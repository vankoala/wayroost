#!/usr/bin/env node
// A tiny ACP (Agent Client Protocol) agent over stdio, used to test Signalbox
// against real Paseo daemons without any AI provider. It streams a reply,
// asks for one permission when the prompt mentions "permission", and waits
// to be cancelled when the prompt says "slow". It takes images, announces
// two "/" commands, says which files a prompt brought, "draws" a PNG into
// its folder, and tells its ACP session id when asked. With --modes it also
// offers modes (one without safeguards), two models and thinking levels.
// "mcp-call {json}" makes it call one of Paseo's own agent tools through the
// MCP server Paseo gave its session, and reply with what happened.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

let nextId = 1;
const pending = new Map();
const cancelled = new Set();
const folders = new Map();
const paseoServers = new Map(); // sessionId → the "paseo" MCP server from session/new
const DOT_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const COMMANDS = [
  { name: 'review', description: 'Review the current changes', input: { hint: 'focus area' } },
  { name: 'explain', description: 'Explain a file' },
];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const TUNABLE = process.argv.includes('--modes');
const settings = new Map();
const settingsOf = (sessionId) => {
  if (!settings.has(sessionId)) settings.set(sessionId, { mode: 'ask', model: 'fast', effort: 'low' });
  return settings.get(sessionId);
};
const effortOption = (s) => ({
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  currentValue: s.effort,
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
});
/** What a session offers, in the ACP session/new and session/load replies. */
function tunables(sessionId) {
  if (!TUNABLE) return {};
  const s = settingsOf(sessionId);
  return {
    modes: {
      availableModes: [
        { id: 'ask', name: 'Ask' },
        { id: 'auto', name: 'Auto' },
        { id: 'yolo', name: 'YOLO' },
      ],
      currentModeId: s.mode,
    },
    models: {
      availableModels: [
        { modelId: 'fast', name: 'Fast' },
        { modelId: 'smart', name: 'Smart' },
      ],
      currentModelId: s.model,
    },
    configOptions: [effortOption(s)],
  };
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Like real agents, announce the "/" commands once the session exists (after the reply).
const announceCommands = (sessionId) =>
  setTimeout(() => update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }), 20);

/** "image image/png png", "text notes.txt", "file spec.pdf readable": what came besides the typed text. */
function describeFiles(prompt) {
  const seen = [];
  for (const block of prompt ?? []) {
    if (block.type === 'image') {
      const bytes = Buffer.from(block.data ?? '', 'base64');
      seen.push(`image ${block.mimeType} ${bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? 'png' : 'not-png'}`);
    } else if (block.type === 'text' && block.text?.startsWith('Attached file: ')) {
      seen.push(`text ${block.text.split('\n')[0].slice('Attached file: '.length)}`);
    } else if (block.type === 'text' && block.text?.startsWith('Uploaded file: ')) {
      // Paseo tells the agent where it put the upload; check the agent can read it.
      const field = (name) => new RegExp(`^${name}: (.*)$`, 'm').exec(block.text)?.[1] ?? '';
      let readable = false;
      try {
        const bytes = readFileSync(field('Path'));
        readable = bytes.length === Number.parseInt(field('Size'), 10) && bytes.subarray(0, 5).toString() === '%PDF-';
      } catch {
        readable = false;
      }
      seen.push(`file ${field('Uploaded file')} ${readable ? 'readable' : 'unreadable'}`);
    }
  }
  return seen.join(', ');
}

/**
 * One of Paseo's agent tools, called like a real agent would: through the "paseo" MCP
 * server (streamable HTTP, URL and headers as Paseo gave them). `dropCaller` removes
 * ?callerAgentId from that URL. Answers which tools the server listed, and the outcome.
 */
async function callPaseoTool(sessionId, { tag, tool, args = {}, dropCaller = false }) {
  const server = paseoServers.get(sessionId);
  if (!server) return { tag, error: 'no paseo MCP server in this session' };
  const url = new URL(server.url);
  if (dropCaller) url.searchParams.delete('callerAgentId');
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const { name, value } of server.headers ?? []) headers[name] = value;
  const rpc = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${body}`);
    // The reply comes as one server-sent event, or as plain JSON.
    const json = /^data: (.*)$/m.exec(body)?.[1] ?? body;
    const message = JSON.parse(json);
    if (message.error) throw new Error(message.error.message);
    return message.result;
  };
  const tools = (await rpc('tools/list', {})).tools.map((t) => t.name);
  if (!tool) return { tag, tools };
  const result = await rpc('tools/call', { name: tool, arguments: args });
  const said = (result.content ?? []).map((c) => c.text ?? '').join(' ');
  return { tag, listed: tools.includes(tool), ...(result.isError ? { refused: said } : { ok: true }) };
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}

const handlers = {
  async initialize(params) {
    return {
      protocolVersion: params.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: false },
        mcpCapabilities: { http: true, sse: false },
      },
      authMethods: [],
    };
  },

  async 'session/new'({ cwd, mcpServers }) {
    const sessionId = `fake-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    folders.set(sessionId, cwd);
    paseoServers.set(sessionId, (mcpServers ?? []).find((server) => server.name === 'paseo'));
    announceCommands(sessionId);
    return { sessionId, ...tunables(sessionId) };
  },

  // Resuming after a daemon restart. Nothing to replay: Paseo keeps its own timeline.
  async 'session/load'({ sessionId, cwd, mcpServers }) {
    folders.set(sessionId, cwd);
    paseoServers.set(sessionId, (mcpServers ?? []).find((server) => server.name === 'paseo'));
    announceCommands(sessionId);
    return tunables(sessionId);
  },

  async 'session/set_mode'({ sessionId, modeId }) {
    settingsOf(sessionId).mode = modeId;
    return {};
  },

  async 'session/set_model'({ sessionId, modelId }) {
    settingsOf(sessionId).model = modelId;
    return {};
  },

  async 'session/set_config_option'({ sessionId, configId, value }) {
    const s = settingsOf(sessionId);
    if (configId === 'effort') s.effort = value;
    return { configOptions: [effortOption(s)] };
  },

  async 'session/prompt'({ sessionId, prompt }) {
    const text = (prompt ?? []).map((block) => block.text ?? '').join(' ');
    cancelled.delete(sessionId);

    const call = /\bmcp-call (\{[\s\S]*\})/.exec(text);
    if (call) {
      const asked = JSON.parse(call[1]);
      const result = await callPaseoTool(sessionId, asked).catch((err) => ({ tag: asked.tag, error: String(err) }));
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `MCP ${JSON.stringify(result)}` } });
      return { stopReason: 'end_turn' };
    }

    const files = describeFiles(prompt);
    if (files) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Received: ${files}` } });
      return { stopReason: 'end_turn' };
    }

    // Like an agent that made a picture: a PNG in its folder, shown as a markdown image.
    if (/\bdraw\b/i.test(text) && folders.get(sessionId)) {
      const picture = join(folders.get(sessionId), 'dot.png');
      writeFileSync(picture, Buffer.from(DOT_PNG, 'base64'));
      const reply = `Here it is: ![dot](${pathToFileURL(picture).href})`;
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } });
      return { stopReason: 'end_turn' };
    }

    // Its own ACP session id, which Hermes would know it by.
    if (/\bsession id\b/i.test(text)) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Session ${sessionId}` } });
      return { stopReason: 'end_turn' };
    }

    if (/\bslow\b/i.test(text)) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working on it…' } });
      while (!cancelled.has(sessionId)) await sleep(50);
      return { stopReason: 'cancelled' };
    }

    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });

    if (/\bpermission\b/i.test(text)) {
      const toolCall = { toolCallId: 'call-1', title: 'Run echo hi', kind: 'execute', rawInput: { command: 'echo hi' } };
      update(sessionId, { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
      const answer = await request('session/request_permission', {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });
      const allowed = answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow';
      update(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: allowed ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: allowed ? 'hi' : 'denied' } }],
      });
    }

    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } });
    return { stopReason: 'end_turn' };
  },
};

createInterface({ input: process.stdin }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  // Response to one of our requests.
  if (message.method === undefined && message.id !== undefined) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(message.error);
    else waiter.resolve(message.result);
    return;
  }

  if (message.method === 'session/cancel') {
    cancelled.add(message.params?.sessionId);
    return;
  }
  if (message.id === undefined) return; // other notifications

  const handler = handlers[message.method];
  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    return;
  }
  try {
    send({ id: message.id, result: await handler(message.params ?? {}) });
  } catch (err) {
    send({ id: message.id, error: { code: -32603, message: String(err) } });
  }
});
