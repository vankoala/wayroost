import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FEED_SOURCES } from '../../../shared/protocol.js';
import type { Feed } from '../feed/service.js';
import { CardInput } from '../feed/store.js';
import type { Logger } from '../hermes/adapter.js';
import { UserFacingError } from '../sources.js';
import { isBridgeTool, isReportTool, type Bridge, type BridgeIdentity } from './service.js';
import { shadowBackground, type BackgroundGate } from '../background.js';

// The bridge listener: a second Fastify instance bound to 127.0.0.1 only.
// Cloudflare never routes here (the tunnel targets the web app's port), so
// there is no Access check; the bearer token is the only credential. Browsers
// are refused outright: no CORS, no Origin, and only our exact Host (which
// blocks DNS rebinding).
//
//   POST /bridge/v1/<tool>
//   Authorization: Bearer <token>
//   X-Bridge-Paseo-Agent: <PASEO_AGENT_ID or empty>
//   X-Bridge-Hermes-Session: <Hermes stored session id or empty>
//   X-Bridge-Cwd: <PASEO_AGENT_CWD or the process's cwd>
//   body: the tool's arguments (JSON)
//   → { ok: true, result } or { ok: false, error } with a matching HTTP status
//
// Agent and session ids are claims: the bridge only trusts one that matches a
// chat Signalbox knows.

export const BRIDGE_HOST = '127.0.0.1';
export const BRIDGE_BODY_LIMIT = 64 * 1024;
const CHAT_ID = /^[A-Za-z0-9][\w.:@+-]{0,199}$/;

export interface BridgeServerOptions {
  background?: BackgroundGate;
  bridge: Pick<Bridge, 'call'>;
  token: string;
  port: number;
  log: Logger;
  /** For you: Hermes' pulse reads its preferences and posts cards here. */
  feed?: Pick<Feed, 'preferences' | 'ingest'>;
}

// The pulse (Hermes' 7am brief and daytime checks) posts what it found:
//   GET  /pulse/v1/preferences  → level, quiet hours, "less like this", recent cards
//   POST /pulse/v1/cards        { source, cards: [...] } → { created, updated, rejected }
// Same token and checks as the bridge tools; these aren't offered to agents as tools.
const PulseCards = z.object({ source: z.enum(FEED_SOURCES), cards: z.array(z.unknown()).max(20) }).strict();

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Folder from a header: Node reads header bytes as Latin-1, so UTF-8 names are recovered; %-encoded paths are accepted too. */
export function headerFolder(value: string | undefined): string | undefined {
  let folder = value?.trim();
  if (!folder) return undefined;
  if (/[^\x00-\x7f]/.test(folder)) folder = Buffer.from(folder, 'latin1').toString('utf8');
  if (/^%2f/i.test(folder)) {
    try {
      folder = decodeURIComponent(folder);
    } catch {
      return undefined;
    }
  }
  return folder;
}

export async function buildBridgeServer(options: BridgeServerOptions): Promise<FastifyInstance> {
  (options.background ?? shadowBackground).require();
  const { bridge, port, log } = options;
  const expected = digest(options.token);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const app = Fastify({
    // Our own log lines only: request logs would carry URLs and headers.
    logger: false,
    bodyLimit: BRIDGE_BODY_LIMIT,
    trustProxy: false,
    return503OnClosing: true,
  });
  // JSON only (Fastify also parses text/plain by default).
  app.removeContentTypeParser('text/plain');

  const deny =(req: FastifyRequest, reply: FastifyReply, status: number, reason: string, error: string) => {
    log.warn({ reason, method: req.method, path: req.url.split('?')[0] }, 'bridge request denied');
    return reply.code(status).send({ ok: false, error });
  };

  app.addHook('onRequest', async (req, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff');

    const host = header(req, 'host')?.toLowerCase();
    if (!host || !hosts.has(host)) return deny(req, reply, 421, 'unexpected host', 'Misdirected request.');

    // Browsers always send Origin on cross-site and POST requests; nothing legitimate here does.
    if (req.headers.origin !== undefined) {
      return deny(req, reply, 403, 'browser request', "Browsers can't use the Wayroost bridge.");
    }

    // Compare fixed-length digests in constant time.
    const auth = header(req, 'authorization') ?? '';
    const presented = /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1];
    if (!presented || !timingSafeEqual(digest(presented), expected)) {
      return deny(req, reply, 401, presented ? 'wrong token' : 'missing token', "Wayroost didn't accept the bridge token.");
    }
  });

  app.post('/bridge/v1/:tool', async (req, reply) => {
    const { tool } = req.params as { tool: string };
    if (!isBridgeTool(tool) && !isReportTool(tool)) return reply.code(404).send({ ok: false, error: 'Unknown tool.' });
    const identity: BridgeIdentity = {};
    const agent = header(req, 'x-bridge-paseo-agent')?.trim();
    if (agent && CHAT_ID.test(agent)) identity.paseoAgent = agent;
    const session = header(req, 'x-bridge-hermes-session')?.trim();
    if (session && CHAT_ID.test(session)) identity.hermesSession = session;
    const cwd = headerFolder(header(req, 'x-bridge-cwd'));
    if (cwd) identity.cwd = cwd;
    // A caller that hangs up (its tool call timed out) mustn't keep a wait that would swallow a reply.
    const hangUp = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) hangUp.abort();
    });
    const result = await bridge.call(tool, req.body ?? {}, identity, { signal: hangUp.signal });
    return { ok: true, result };
  });

  const feed = options.feed;
  if (feed) {
    app.get('/pulse/v1/preferences', async () => ({ ok: true, result: feed.preferences() }));
    app.post('/pulse/v1/cards', async (req) => {
      const body = PulseCards.parse(req.body ?? {});
      // One bad card doesn't sink the rest.
      const cards: CardInput[] = [];
      for (const raw of body.cards) {
        const parsed = CardInput.safeParse(raw);
        if (parsed.success) cards.push(parsed.data);
      }
      const result = feed.ingest(body.source, cards);
      return { ok: true, result: { ...result, rejected: body.cards.length - cards.length } };
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, error: 'Not found.' }));

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserFacingError) return reply.code(err.status).send({ ok: false, error: err.message });
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ ok: false, error: `Invalid request: ${err.issues.map((i) => i.path.join('.') || 'body').join(', ')}` });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const error =
        status === 413 ? 'Request too large (the limit is 64 KB).' : status === 415 ? 'Send the arguments as JSON.' : 'Bad request.';
      return reply.code(status).send({ ok: false, error });
    }
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'bridge request failed');
    return reply.code(500).send({ ok: false, error: 'Something went wrong in Wayroost.' });
  });

  return app;
}
