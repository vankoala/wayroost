// End-to-end compatibility check: runs Signalbox's Paseo connector against a
// real Paseo daemon (in-process, isolated home, random port) whose only agent
// is scripts/paseo-compat/fake-acp-agent.mjs. Nothing touches your own daemon.
//
//   npm install --prefix /tmp/paseo-X @getpaseo/server@X
//   npx tsx scripts/paseo-compat/run.ts /tmp/paseo-X/node_modules/@getpaseo/server
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ControlId, ConversationControl, ServerEvent, TimelineItem } from '../../shared/protocol.js';
import { decodeAttachments } from '../../server/src/attachments.js';
import { EventHub } from '../../server/src/hub.js';
import { MAX_MEDIA_BYTES, localImagePath } from '../../server/src/media.js';
import { PaseoAdapter } from '../../server/src/paseo/adapter.js';
import { HERMES_PARENT_LABEL } from '../../server/src/paseo/normalize.js';
import { UserFacingError } from '../../server/src/sources.js';

const serverDir = resolve(process.argv[2] ?? '');
const version = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8')).version as string;
const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs');
const { createPaseoDaemon } = await import(pathToFileURL(join(serverDir, 'dist/server/server/bootstrap.js')).href);
const pino = createRequire(join(serverDir, 'package.json'))('pino');

const root = mkdtempSync(join(tmpdir(), 'sb-paseo-'));
const paseoHome = join(root, '.paseo');
const project = join(root, 'project');
const staticDir = join(root, 'static');
for (const dir of [paseoHome, project, staticDir]) mkdirSync(dir, { recursive: true });

async function startDaemon(listen: string) {
  const started = await createPaseoDaemon(
    {
      listen,
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: {},
      agentStoragePath: join(paseoHome, 'agents'),
      relayEnabled: false,
      relayEndpoint: 'relay.paseo.sh:443',
      appBaseUrl: 'https://app.paseo.sh',
      providerOverrides: {
        fakeacp: { extends: 'acp', label: 'Fake ACP', command: [process.execPath, fakeAgent] },
        fakemodes: { extends: 'acp', label: 'Fake ACP with modes', command: [process.execPath, fakeAgent, '--modes'] },
        // Stands in for Hermes in Paseo, which is an ACP provider named "hermes".
        hermes: { extends: 'acp', label: 'Hermes', command: [process.execPath, fakeAgent] },
      },
    },
    pino({ level: process.env.PASEO_LOG ?? 'silent' }),
  );
  await started.start();
  return started;
}

let daemon = await startDaemon('127.0.0.1:0');
const target = daemon.getListenTarget();
const port = target.type === 'tcp' ? target.port : 0;

// Collect what Signalbox would push to browsers, per conversation.
const hub = new EventHub();
const timelines = new Map<string, Map<string, TimelineItem>>();
const itemsOf = (id: string) => {
  let items = timelines.get(id);
  if (!items) timelines.set(id, (items = new Map()));
  return items;
};
const socket = {
  readyState: 1,
  bufferedAmount: 0,
  terminate() {},
  send(raw: string) {
    const event = JSON.parse(raw) as ServerEvent;
    if (event.type === 'items_replace') {
      const items = itemsOf(event.conversationId);
      items.clear();
      for (const item of event.items) items.set(item.id, item);
    } else if (event.type === 'items_upsert') {
      for (const item of event.items) itemsOf(event.conversationId).set(item.id, item);
    } else if (event.type === 'text_delta') {
      const items = itemsOf(event.conversationId);
      const item = items.get(event.itemId);
      if (item && (item.kind === 'assistant' || item.kind === 'reasoning')) {
        items.set(event.itemId, { ...item, text: item.text + event.delta });
      }
    }
  },
};
const client = hub.add(socket as never, 'compat');
const log = { info() {}, warn: (o: object, m?: string) => console.warn('  warn:', m, JSON.stringify(o)), error: (o: object, m?: string) => console.error('  error:', m, JSON.stringify(o)) };
const adapter = new PaseoAdapter(`ws://127.0.0.1:${port}`, hub, log, 'cid_signalbox_compat');

async function waitFor(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(`  ✓ ${what}`);
}
const list = (id: string) => [...itemsOf(id).values()];
const replies = (id: string) => list(id).flatMap((i) => (i.kind === 'assistant' ? [i.text] : []));
const text = (id: string) => replies(id).join(' | ');
async function open(id: string) {
  hub.subscribe(client, 'paseo', id);
  const detail = await adapter.getConversation(id);
  for (const item of detail.items) itemsOf(id).set(item.id, item);
}
const waitForStatus = (id: string, status: string) =>
  waitFor(`agent ${status}`, async () => (await adapter.listConversations()).some((c) => c.id === id && c.status === status));

// What the phone would send: a real 1×1 PNG, a text file and a PDF, checked like any upload.
const files = decodeAttachments([
  {
    name: 'dot.png',
    mimeType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  },
  { name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('hello from signalbox\n').toString('base64') },
  { name: 'spec.pdf', mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64') },
]);

let failed = false;
try {
  console.log(`Paseo ${version} (daemon on port ${port})`);
  adapter.start();
  await waitFor('connected', () => adapter.status().state === 'connected');

  const options = await adapter.options();
  const fake = options.providers.find((p) => p.id === 'fakeacp');
  if (!fake) throw new Error(`fake provider not offered: ${JSON.stringify(options.providers.map((p) => p.id))}`);
  if (!fake.autoApproves) throw new Error('a provider without modes must require consent');
  console.log('  ✓ provider offered, flagged as needing consent');

  let refused = false;
  await adapter.createConversation({ providerId: 'fakeacp', cwd: project, text: 'hi' }).catch(() => (refused = true));
  if (!refused) throw new Error('launch without consent was not refused');
  console.log('  ✓ launch without consent refused');

  const id = await adapter.createConversation({
    providerId: 'fakeacp',
    cwd: project,
    text: 'Please ask permission, then say hello',
    acknowledgeAutoApprove: true,
  });
  await open(id);
  console.log(`  ✓ agent created (${id.slice(0, 8)}), timeline loaded`);

  await waitFor('permission request surfaced', () => adapter.listApprovals().some((a) => a.conversationId === id));
  const approval = adapter.listApprovals().find((a) => a.conversationId === id)!;
  const kinds = approval.options.map((o) => `${o.id}:${o.kind}`).join(',');
  if (!approval.options.some((o) => o.kind === 'allow') || !approval.options.some((o) => o.kind === 'deny')) {
    throw new Error(`unexpected options ${kinds}`);
  }
  await adapter.respondToApproval(id, approval.id, { optionId: approval.options.find((o) => o.kind === 'allow')!.id });
  await waitFor('approval answered and cleared', () => !adapter.listApprovals().some((a) => a.conversationId === id));
  // "Hello", then the tool call, then "world" — two assistant bubbles around the tool.
  await waitFor('reply streamed around the tool call', () => /Hello.*\|.*world/.test(text(id)));
  await waitFor('tool call completed', () => list(id).some((i) => i.kind === 'tool' && i.status === 'done'));
  await waitForStatus(id, 'idle');

  await adapter.sendMessage(id, 'Again');
  await waitFor('follow-up answered in one streamed bubble', () => /Hello\s*world/.test(text(id)));

  await adapter.sendMessage(id, 'Be slow');
  await waitFor('long task running', () => /Working on it/.test(text(id)));
  await adapter.interrupt(id);
  await waitFor('stopped on request', () => list(id).some((i) => i.kind === 'notice' && i.text === 'Stopped'));
  await waitForStatus(id, 'idle');

  // The agent's own "/" commands, as it announced them.
  const commands = (await adapter.listCommands(id)).map((c) => `${c.kind}:${c.name}`).join(',');
  if (commands !== 'command:review,command:explain') throw new Error(`unexpected commands: ${commands || 'none'}`);
  console.log('  ✓ agent commands listed');

  // A photo and a text file go inline, the PDF through Paseo's upload; the agent can read all three.
  await adapter.sendMessage(id, 'What did I send?', files);
  await waitFor('photo, text file and PDF reached the agent', () =>
    replies(id).includes('Received: image image/png png, text notes.txt, file spec.pdf readable'),
  );
  const sentItem = list(id).find((i) => i.kind === 'user' && i.text === 'What did I send?');
  const chips = sentItem?.kind === 'user' ? (sentItem.attachments ?? []).map((a) => `${a.kind}:${a.name}`).join(',') : '';
  if (chips !== 'image:dot.png,text:notes.txt,pdf:spec.pdf') throw new Error(`files not shown on the message: ${chips || 'none'}`);
  console.log('  ✓ files shown on the message');
  await waitForStatus(id, 'idle');

  // A message sent while it works steers it; ACP agents can't be steered, so it replaces the turn.
  await adapter.sendMessage(id, 'Be slow');
  await waitFor('long task running again', () => replies(id).filter((r) => /Working on it/.test(r)).length === 2);
  await waitForStatus(id, 'running');
  await adapter.sendMessage(id, 'Again');
  await waitFor('message sent while busy answered', () => replies(id).filter((r) => /^Hello\s*world$/.test(r)).length === 2);
  await waitForStatus(id, 'idle');

  // A new agent started from a photo alone.
  const photoOnly = await adapter.createConversation({
    providerId: 'fakeacp',
    cwd: project,
    text: '',
    attachments: files.slice(0, 1),
    acknowledgeAutoApprove: true,
  });
  await open(photoOnly);
  await waitFor('agent started from a photo alone', () => replies(photoOnly).includes('Received: image image/png png'));
  const firstItem = list(photoOnly).find((i) => i.kind === 'user');
  if (firstItem?.kind !== 'user' || firstItem.text !== '' || firstItem.attachments?.[0]?.name !== 'dot.png') {
    throw new Error(`photo not shown on the first message: ${JSON.stringify(firstItem)}`);
  }
  console.log('  ✓ photo shown on the first message');

  // Model, reasoning and mode pickers on an agent that offers them.
  const tuned = await adapter.createConversation({ providerId: 'fakemodes', cwd: project, text: 'Again' });
  await waitForStatus(tuned, 'idle');
  const describe = (controls: ConversationControl[]) =>
    controls.map((c) => `${c.id}=${c.value}:${c.options.map((o) => `${o.id}${o.autoApproves ? '!' : ''}`).join('/')}`).join(' ');
  const offered = describe((await adapter.getControls(tuned)).controls);
  if (offered !== 'model=fast:fast/smart reasoning=low:low/high mode=ask:ask/auto!') throw new Error(`unexpected pickers: ${offered}`);
  console.log('  ✓ model, reasoning and mode offered; the mode without safeguards hidden');
  let unconfirmed = false;
  await adapter.setControl(tuned, { control: 'mode', value: 'auto' }).catch(() => (unconfirmed = true));
  if (!unconfirmed) throw new Error('switched to a mode that acts on its own without an OK');
  const changes: Array<[ControlId, string]> = [['mode', 'auto'], ['model', 'smart'], ['reasoning', 'high']];
  for (const [control, value] of changes) {
    const res = await adapter.setControl(tuned, { control, value, acknowledgeAutoApprove: control === 'mode' });
    const now = res.ok ? res.controls.controls.find((c) => c.id === control)?.value : undefined;
    if (now !== value) throw new Error(`${control} is ${now} after switching to ${value}`);
  }
  console.log('  ✓ mode (after an OK), model and reasoning switched');

  // Images an agent shows, read through Paseo the way its own app reads them.
  const isPng = (bytes: Buffer) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const statusOf = (read: Promise<unknown>) => read.then(() => 200, (err: unknown) => (err instanceof UserFacingError ? err.status : 0));
  await adapter.sendMessage(id, 'Please draw a dot');
  await waitFor('agent showed a picture it made', () => replies(id).some((r) => r.includes('![dot](')));
  const target = /!\[dot\]\(([^)\s]+)\)/.exec(replies(id).find((r) => r.includes('![dot](')) ?? '')?.[1] ?? '';
  const drawn = localImagePath(target);
  if (!drawn?.startsWith(`${project}/`)) throw new Error(`unexpected picture path: ${target}`);
  if (!isPng((await adapter.readImage(id, drawn)).bytes)) throw new Error('the picture read back is not a PNG');
  console.log("  ✓ picture in the agent's folder read back");
  const outside = join(root, 'outside.png');
  writeFileSync(outside, files[0]!.bytes);
  if (!isPng((await adapter.readImage(id, outside)).bytes)) throw new Error('the picture outside the folder is not a PNG');
  console.log('  ✓ picture outside the folder read back');
  // A link in the agent's folder that leads out of it is refused, and not retried against "/".
  symlinkSync(outside, join(project, 'link.png'));
  const linked = await statusOf(adapter.readImage(id, join(project, 'link.png')));
  if (linked !== 403) throw new Error(`a link out of the agent's folder was not refused (${linked})`);
  writeFileSync(join(project, 'huge.png'), Buffer.alloc(MAX_MEDIA_BYTES + 1));
  const huge = await statusOf(adapter.readImage(id, join(project, 'huge.png')));
  if (huge !== 413) throw new Error(`an image over the size cap was not refused (${huge})`);
  console.log('  ✓ a link out of the folder and an image over the size cap refused');
  await waitForStatus(id, 'idle');

  // Hermes in Paseo that a Hermes chat started through the bridge: Signalbox's label
  // comes back as its parent, and it's also known by the ACP session id the agent has.
  const hermesChat = '20260927_101500_ab12cd';
  const inPaseo = await adapter.createConversation({
    providerId: 'hermes',
    cwd: project,
    text: 'What is your session id?',
    acknowledgeAutoApprove: true,
    labels: { [HERMES_PARENT_LABEL]: hermesChat },
  });
  await open(inPaseo);
  const told = () => replies(inPaseo).map((r) => /^Session (\S+)$/.exec(r.trim())?.[1]).find(Boolean);
  await waitFor('Hermes-in-Paseo agent told its ACP session id', () => told() !== undefined);
  await waitForStatus(inPaseo, 'idle');
  const expectedNesting = JSON.stringify({ parent: { source: 'hermes', id: hermesChat }, aliases: [{ source: 'hermes', id: told() }] });
  const nesting = async () => {
    const summary = (await adapter.listConversations()).find((c) => c.id === inPaseo);
    return JSON.stringify({ parent: summary?.parent, aliases: summary?.aliases });
  };
  await waitFor('its parent read back from the label, its ACP session id as an alias', async () => (await nesting()) === expectedNesting);

  // After a restart, Paseo has the agents only in storage, and asking one for its
  // commands would resume it. Signalbox only asks once the conversation is open.
  const unopened = await adapter.createConversation({ providerId: 'fakeacp', cwd: project, text: 'Again', acknowledgeAutoApprove: true });
  await waitForStatus(unopened, 'idle');
  await daemon.stop();
  await waitFor('disconnected when the daemon stopped', () => adapter.status().state !== 'connected');
  daemon = await startDaemon(`127.0.0.1:${port}`);
  await waitFor('reconnected to the restarted daemon', () => adapter.status().state === 'connected', 60_000);
  if ((await adapter.listCommands(unopened)).length || daemon.agentManager.getAgent(unopened)) {
    throw new Error('listing commands woke an agent Paseo only had in storage');
  }
  console.log('  ✓ stored agent not woken to list its commands');
  const kept = await nesting();
  if (kept !== expectedNesting) throw new Error(`parent or ACP session id lost in the restart: ${kept}`);
  console.log('  ✓ parent label and ACP session id kept through the restart');
  await open(unopened);
  await waitFor('its commands listed once the conversation is open', async () => (await adapter.listCommands(unopened)).length === 2);
  console.log(`PASS  Paseo ${version}`);
} catch (err) {
  failed = true;
  console.error(`FAIL  Paseo ${version}: ${(err as Error).message}`);
  for (const [id, items] of timelines) {
    const rows = [...items.values()].map((i) => [i.kind, 'text' in i ? i.text : 'status' in i ? i.status : '']);
    console.error(`  timeline ${id.slice(0, 8)}:`, JSON.stringify(rows));
  }
} finally {
  adapter.stop();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
