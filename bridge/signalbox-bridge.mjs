#!/usr/bin/env node
// Signalbox project bridge: the stdio MCP server an agent starts so it can see,
// read, message and start the other chats in its project, across Hermes and
// Paseo. deploy/setup-bridge.sh registers it with each agent as
//   node /opt/signalbox/bin/signalbox-bridge.mjs
//
// It speaks MCP (newline-delimited JSON-RPC 2.0) on stdin/stdout and turns each
// tool call into POST /bridge/v1/<tool> on Signalbox's loopback bridge
// listener. Plain Node (22+), no dependencies. Stdout carries protocol messages
// only; diagnostics go to stderr. The token is never printed.
//
// Environment:
//   SIGNALBOX_BRIDGE_URL         bridge listener, default http://127.0.0.1:8792 (loopback only)
//   SIGNALBOX_BRIDGE_TOKEN_FILE  default ~/.config/signalbox/bridge-token
//   PASEO_AGENT_ID               set by Paseo in the agents it runs: who is calling
//   PASEO_AGENT_CWD              set by Paseo: the agent's folder (else the process's cwd)
//
// Under Hermes, a Hermes plugin adds the calling chat's session id to each call as the hidden
// argument _signalbox_caller; it goes to Signalbox as X-Bridge-Hermes-Session, never as an argument.

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

const VERSION = '0.1.0';
/** Revisions that use the initialize handshake, newest first. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const FALLBACK_PROTOCOL = '2025-06-18';
const DEFAULT_URL = 'http://127.0.0.1:8792';
const TIMEOUT_MS = 60_000;
const WAIT_DEFAULT_SECONDS = 45;
const WAIT_MAX_SECONDS = 120;
/** wait_for_reply's HTTP timeout is its own timeout plus this much. */
const WAIT_MARGIN_MS = 15_000;
/** Added by the Hermes plugin; never advertised in a schema. */
const HIDDEN_CALLER = '_signalbox_caller';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const SETUP_HINT = 'Ask the user to run deploy/setup-bridge.sh from the Signalbox checkout (as root, with their user name).';

// ---- tools ---------------------------------------------------------------------

const PROJECT = {
  type: 'string',
  maxLength: 4096,
  description: "Absolute path of the project folder. Leave it out to use the folder you're working in.",
};
const CHAT = {
  type: 'string',
  maxLength: 220,
  description: 'Chat id from list_chats, like "paseo:<id>" or "hermes:<id>".',
};

const TOOLS = [
  {
    name: 'list_chats',
    title: 'List chats in this project',
    description:
      "List the other chats in your project: the Hermes chats and Paseo coding agents working in the same folder. " +
      'They may be other AI agents rather than the user. Returns the project and up to 50 chats, most recently ' +
      'active first, without your own chat. Each has: chat (the id for read_chat and send_message), title, backend, ' +
      'agent, status (working, idle, needs_approval or error), updated (when the chat was last active: someone ' +
      'wrote to it or it worked), a short preview, and started_by when another agent started it. When asked for ' +
      '"the most recently active" chat, take the first one in this list rather than guessing from titles.',
    inputSchema: { type: 'object', properties: { project: PROJECT }, additionalProperties: false },
    annotations: { title: 'List chats in this project', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_chat',
    title: 'Read a chat',
    description:
      'Read the latest messages of another chat in your project, oldest first: user messages, assistant replies, ' +
      'one-line tool summaries and notices (long messages are shortened; reasoning is left out). Items with role ' +
      '"agent" came from another AI agent through Signalbox, not from the user. Only chats in your project can be read.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: CHAT,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 20,
          description: 'How many of the latest items to return (1 to 50, default 20).',
        },
        project: PROJECT,
      },
      required: ['chat'],
      additionalProperties: false,
    },
    annotations: { title: 'Read a chat', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_message',
    title: 'Message a chat',
    description:
      'Send a message to another chat in your project. That chat may be another AI agent; your message reaches it ' +
      'labelled as coming from an AI agent, not from the user, with a reply address, and it decides for itself ' +
      'what to do. An idle chat starts on it right away; a busy one (working or waiting for an approval) gets it ' +
      'when it finishes, so nothing is interrupted. To get the answer, call wait_for_reply, or look later with ' +
      'read_chat. When a message you are answering came with a reply address, reply with send_message to that ' +
      'chat. Text starting with "/" is refused: slash commands can\'t be sent. Approvals stay with the user. ' +
      'Messages are rate-limited and back-and-forth loops get paused: send one clear, self-contained message, and ' +
      'skip replies that only acknowledge.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: CHAT,
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description: 'The message, in plain text (up to 8000 characters). It can\'t start with "/".',
        },
        project: PROJECT,
      },
      required: ['chat', 'text'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Message a chat',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'wait_for_reply',
    title: 'Wait for a reply',
    description:
      'Wait for another chat in your project to answer you: returns when that chat sends you a message through ' +
      'Signalbox or finishes its current turn, with what it said. If the result says timed_out, call it again to ' +
      'keep waiting. Use it after send_message when you need the answer before going on.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: CHAT,
        timeout_seconds: {
          type: 'integer',
          minimum: 1,
          maximum: WAIT_MAX_SECONDS,
          default: WAIT_DEFAULT_SECONDS,
          description: `How long to wait, in seconds (default ${WAIT_DEFAULT_SECONDS}, at most ${WAIT_MAX_SECONDS}).`,
        },
        project: PROJECT,
      },
      required: ['chat'],
      additionalProperties: false,
    },
    annotations: { title: 'Wait for a reply', readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'start_chat',
    title: 'Start a chat',
    description:
      "Start a new chat in your project's folder with a first message, which is labelled as coming from an AI " +
      'agent, not from the user. backend "paseo" starts a coding agent (say which with agent); only modes that ask ' +
      'the user before acting are allowed, so agents that act without asking can\'t be started this way. Leave ' +
      'agent out to get the list of agents that can be started. backend "hermes" starts a Hermes chat (no agent or ' +
      'mode). The new chat asks the user for its own approvals. Agents may start only a few chats per project per ' +
      'hour: use it for a separate, well-defined task.',
    inputSchema: {
      type: 'object',
      properties: {
        backend: {
          type: 'string',
          enum: ['paseo', 'hermes'],
          description: '"paseo" for a coding agent, "hermes" for a Hermes chat.',
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 8000,
          description:
            'What the new chat should do, with the context it needs, in plain text (up to 8000 characters). It ' +
            'can\'t start with "/".',
        },
        agent: {
          type: 'string',
          maxLength: 64,
          description: 'Paseo only: which agent to start, e.g. "claude" or "codex".',
        },
        mode: {
          type: 'string',
          maxLength: 200,
          description:
            "Paseo only: a mode that asks the user before acting. Leave it out to use the agent's default mode, " +
            'if that one asks first.',
        },
        title: { type: 'string', maxLength: 200, description: 'Short title for the new chat. Defaults to the start of text.' },
        project: PROJECT,
      },
      required: ['backend', 'text'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Start a chat',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

const INSTRUCTIONS =
  'Signalbox links the chats working in the same project folder, across Hermes and Paseo. Use list_chats to see ' +
  'the other chats in your project, read_chat to catch up on one, send_message to ask one of them something, ' +
  'wait_for_reply to wait for its answer, and start_chat to hand a separate task to a new chat. The other chats ' +
  'may be other AI agents, not the user; what you send reaches them labelled as coming from an agent, with a ' +
  'reply address. When a message you received came with a reply address, answer with send_message to that chat. ' +
  'Busy chats get messages when they finish. Slash commands can\'t be sent, and approvals always stay with the user.';

// ---- configuration -----------------------------------------------------------------

function log(message) {
  process.stderr.write(`signalbox-bridge: ${message}\n`);
}

/** A variable's value, unless it's unset, empty or a "${VAR}" placeholder (Hermes leaves unset ones as-is). */
function envValue(name) {
  const value = process.env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

function isLoopback(hostname) {
  const host = hostname.toLowerCase();
  // The URL parser has already turned forms like 127.1 or 2130706433 into dotted quads.
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function resolveEndpoint() {
  const raw = process.env.SIGNALBOX_BRIDGE_URL?.trim() || DEFAULT_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "SIGNALBOX_BRIDGE_URL isn't a valid URL." };
  }
  if (url.protocol !== 'http:') return { error: 'SIGNALBOX_BRIDGE_URL must be an http:// address on this machine.' };
  if (url.username || url.password) return { error: "SIGNALBOX_BRIDGE_URL can't carry a user name or password." };
  if (!isLoopback(url.hostname)) {
    return {
      error: `SIGNALBOX_BRIDGE_URL must point at this machine (127.0.0.1 or localhost), not ${url.hostname}; refusing to send the bridge token there.`,
    };
  }
  const port = Number(url.port || 80);
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port,
    hostHeader: `${url.hostname}:${port}`,
    origin: `http://${url.hostname}:${port}`,
  };
}

const TOKEN_FILE = envValue('SIGNALBOX_BRIDGE_TOKEN_FILE') ?? join(homedir(), '.config', 'signalbox', 'bridge-token');
const TOKEN_LABEL = envValue('SIGNALBOX_BRIDGE_TOKEN_FILE') ?? '~/.config/signalbox/bridge-token';

/** { token } or { error }: the message a tool call returns when there's no usable token. */
function readToken() {
  let text;
  try {
    text = readFileSync(TOKEN_FILE, 'utf8');
  } catch (err) {
    const missing = err?.code === 'ENOENT' || err?.code === 'ENOTDIR';
    return {
      error: missing
        ? `The Signalbox bridge isn't set up on this machine (there's no token in ${TOKEN_LABEL}). ${SETUP_HINT}`
        : `The Signalbox bridge isn't set up on this machine (can't read ${TOKEN_LABEL}: ${err?.code ?? 'error'}). ${SETUP_HINT}`,
    };
  }
  const token = text.trim();
  if (!TOKEN.test(token)) {
    return { error: `The Signalbox bridge isn't set up on this machine (${TOKEN_LABEL} doesn't hold a bridge token). ${SETUP_HINT}` };
  }
  return { token };
}

const endpoint = resolveEndpoint();
let tokenState = readToken();
if (endpoint.error) log(endpoint.error);
else if (tokenState.error) log(tokenState.error);

/** Who is calling, for the X-Bridge-* headers. Read per call: tests and wrappers may change the env. */
function identity() {
  const agent = envValue('PASEO_AGENT_ID');
  let cwd = envValue('PASEO_AGENT_CWD');
  if (!cwd || !isAbsolute(cwd)) {
    try {
      cwd = process.cwd();
    } catch {
      cwd = '';
    }
  }
  return {
    // Paseo agent ids are plain ASCII; anything else can't be one.
    agent: agent && /^[\x21-\x7e]{1,200}$/.test(agent) ? agent : '',
    // Header values must be printable ASCII; other folders go percent-encoded (the server decodes "%2F…").
    cwd: /^[\x20-\x7e]*$/.test(cwd) ? cwd : encodeURIComponent(cwd),
  };
}

// ---- talking to Signalbox ----------------------------------------------------------------

// A private agent, never http.globalAgent or fetch: with NODE_USE_ENV_PROXY (or --use-env-proxy)
// those send even loopback requests, bearer token included, through the configured proxy.
const agent = new http.Agent({ keepAlive: false });

/** POST the arguments to Signalbox; resolves { status, body } or rejects (network error, timeout, abort). */
function post(tool, args, token, signal, extraHeaders) {
  const who = identity();
  const body = Buffer.from(JSON.stringify(args), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        method: 'POST',
        path: `/bridge/v1/${tool}`,
        agent,
        signal,
        headers: {
          Host: endpoint.hostHeader,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Accept: 'application/json',
          'X-Bridge-Paseo-Agent': who.agent,
          'X-Bridge-Cwd': who.cwd,
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('the answer was too large'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Top-level keys one per line, list items one per line, everything deeper compact. Still valid JSON. */
function render(result) {
  if (result === undefined) return 'null';
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return JSON.stringify(result);
  const lines = Object.entries(result).map(([key, value]) => {
    const text =
      Array.isArray(value) && value.length
        ? `[\n${value.map((item) => `    ${JSON.stringify(item)}`).join(',\n')}\n  ]`
        : JSON.stringify(value);
    return `  ${JSON.stringify(key)}: ${text}`;
  });
  return lines.length ? `{\n${lines.join(',\n')}\n}` : '{}';
}

const success = (result) => ({ content: [{ type: 'text', text: render(result) }] });
const failure = (text) => ({ content: [{ type: 'text', text }], isError: true });

function networkError(err, timedOutAfterMs) {
  if (timedOutAfterMs) return `Signalbox didn't answer within ${timedOutAfterMs / 1000} seconds. Try again later.`;
  if (err?.code === 'ECONNREFUSED') {
    return (
      `Signalbox isn't answering at ${endpoint.origin}. It may be stopped, or its bridge may be turned off ` +
      '("bridge": {"enabled": true} in /etc/signalbox/config.json). Tell the user.'
    );
  }
  return `Couldn't reach Signalbox at ${endpoint.origin} (${err?.code ?? err?.message ?? 'error'}).`;
}

/** How long wait_for_reply asks Signalbox to wait (Signalbox checks the value itself). */
function waitSeconds(value) {
  const seconds = Number(value ?? WAIT_DEFAULT_SECONDS);
  return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 1), WAIT_MAX_SECONDS) : WAIT_DEFAULT_SECONDS;
}

/** Run one tool through Signalbox and turn the outcome into an MCP tool result. */
async function callTool(tool, args, cancel, client) {
  if (endpoint.error) return failure(endpoint.error);
  if (tokenState.error) tokenState = readToken(); // set up since we started?
  if (tokenState.error) return failure(tokenState.error);

  const payload = { ...args };
  const caller = payload[HIDDEN_CALLER];
  delete payload[HIDDEN_CALLER];
  delete payload.backend_hint;
  if (client.hermes) payload.backend_hint = 'hermes';
  // Only a wrapper Hermes started passes the plugin's session id on; anywhere else it's a model's claim.
  const headers =
    HERMES_ENV && typeof caller === 'string' && /^[\x21-\x7e]{1,200}$/.test(caller) ? { 'X-Bridge-Hermes-Session': caller } : {};
  const timeoutMs = tool === 'wait_for_reply' ? waitSeconds(payload.timeout_seconds) * 1000 + WAIT_MARGIN_MS : TIMEOUT_MS;

  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await post(tool, payload, tokenState.token, AbortSignal.any([cancel, timeout]), headers);
    } catch (err) {
      if (cancel.aborted) throw err;
      return failure(networkError(err, timeout.aborted ? timeoutMs : 0));
    }
    let answer;
    try {
      answer = JSON.parse(res.body);
    } catch {
      answer = undefined;
    }
    if (res.status >= 200 && res.status < 300 && answer?.ok === true) return success(answer.result);

    if (res.status === 401 && attempt === 0) {
      // The token may have been replaced since we read it (setup-bridge.sh run again).
      const fresh = readToken();
      if (fresh.token && fresh.token !== tokenState.token) {
        tokenState = fresh;
        continue;
      }
    }
    let message =
      typeof answer?.error === 'string' && answer.error.trim()
        ? answer.error.trim()
        : `Signalbox answered with HTTP ${res.status}.`;
    if (res.status === 401) message += ` ${SETUP_HINT}`;
    return failure(message);
  }
}

// ---- MCP over stdio -------------------------------------------------------------------

// Hermes starts us with PASEO_AGENT_ID: "${PASEO_AGENT_ID}" and leaves the placeholder as-is outside
// Paseo, so a literal placeholder means a Hermes chat is calling (its messages are signed that way).
const HERMES_ENV = /^\$\{[^}]*\}$/.test(process.env.PASEO_AGENT_ID?.trim() ?? '');
const client = { hermes: HERMES_ENV };
/** Request id → AbortController of the tool call it runs. */
const inFlight = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function initialize(params) {
  const requested = params?.protocolVersion;
  const clientName = params?.clientInfo?.name;
  client.hermes = HERMES_ENV || (typeof clientName === 'string' && /^hermes/i.test(clientName));
  return {
    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_PROTOCOL,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'signalbox', title: 'Signalbox', version: VERSION },
    instructions: INSTRUCTIONS,
  };
}

async function toolsCall(id, params) {
  const name = params?.name;
  if (typeof name !== 'string' || !TOOL_NAMES.has(name)) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
  const args = params.arguments ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return reply(id, failure('The arguments must be a JSON object.'));
  }
  const controller = new AbortController();
  inFlight.set(id, controller);
  try {
    const result = await callTool(name, args, controller.signal, client);
    return controller.signal.aborted ? undefined : reply(id, result);
  } catch (err) {
    if (controller.signal.aborted) return undefined; // cancelled: no response
    throw err;
  } finally {
    if (inFlight.get(id) === controller) inFlight.delete(id);
  }
}

/** Handle one JSON-RPC message; resolves the response to send, if any. */
async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, -32600, 'Invalid Request');
  const { id, method, params } = message;
  if (typeof method !== 'string') {
    // A response to a request we never sent (we send none), or junk.
    if ('result' in message || 'error' in message) return undefined;
    return rpcError(typeof id === 'string' || typeof id === 'number' ? id : null, -32600, 'Invalid Request');
  }
  if (id === undefined) {
    if (method === 'notifications/cancelled') inFlight.get(params?.requestId)?.abort();
    return undefined; // notifications/initialized and anything else: nothing to do
  }
  if (typeof id !== 'string' && typeof id !== 'number') return rpcError(null, -32600, 'Invalid Request');
  try {
    switch (method) {
      case 'initialize':
        return reply(id, initialize(params));
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call':
        return await toolsCall(id, params);
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log(`internal error in ${method}: ${err?.message ?? err}`);
    return rpcError(id, -32603, 'Internal error');
  }
}

async function dispatch(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send(rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(message)) {
    // JSON-RPC batch (MCP 2025-03-26 allowed them).
    if (!message.length) return send(rpcError(null, -32600, 'Invalid Request'));
    const responses = (await Promise.all(message.map(handle))).filter(Boolean);
    if (responses.length) send(responses);
    return;
  }
  const response = await handle(message);
  if (response) send(response);
}

process.stdout.on('error', (err) => {
  // The client went away.
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', (line) => {
    if (line.trim()) void dispatch(line);
  })
  .on('close', () => {
    // The client is shutting down: hang up on Signalbox too, so a held wait_for_reply is dropped there
    // (a late reply then goes to the chat instead of a dead wait). The process exits once they're done.
    for (const controller of inFlight.values()) controller.abort();
  });
