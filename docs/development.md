# Developing Signalbox

## Layout

```
server/src/
  index.ts              entry point: config, sources, keep-warm Access keys, listen
  app.ts                Fastify app: request checks, JSON API, /ws live events, static files
  config.ts             strict, fail-closed config parsing
  hub.ts                fans server events out to connected browsers
  attachments.ts        checks uploaded files: count, size, real type from the bytes
  media.ts              finds images agents show, signs links to them, refuses private folders
  sources.ts            the interface every backend adapter implements
  speech.ts             voice mode: the speech service client, and one browser's recording on its WebSocket
  secrets.ts            the saved Hermes sign-in and the Paseo client id
  security/             Access JWT verification, CSRF/Origin/Host guards, response headers
  hermes/               Hermes dashboard: sign-in, JSON-RPC gateway, "/" commands, mapping to the shared protocol
  paseo/                Paseo daemon: connection, timeline mirror, mapping, mode tiers
  disabled.ts           stand-in when a source is turned off
  bridge/               project bridge: loopback listener, tools, project scoping, limits, token
  feed/                 For you: the card store, the service (actions, proactivity level, notifications), Web Push
bridge/                 signalbox-bridge.mjs, the stdio MCP server agents start for the bridge
hermes-plugin/          signalbox-identity, the Hermes plugin that tells the bridge which Hermes chat is calling, and its tests
shared/protocol.ts      the contract between server and browser
web/src/                React app (Vite): inbox, projects view, conversation, approvals, composer, "/" menu, attachments, model and mode chips, image viewer
  voice/                voice mode: mic and playback, cutting replies into sentences, reading them aloud
web/public/voice-worklet.js  the microphone's AudioWorklet: filters and resamples to 16 kHz PCM frames
web/public/sw.js        the service worker for phone notifications (shows them and opens the page; no fetch handler)
speech/                 the speech service for voice mode (signalbox-speech.py) and its hash-pinned requirements
scripts/                demo, UI check, local end-to-end run, Paseo compatibility harness, icons
deploy/                 installer, tunnel, bridge, helper and voice setup, shared checks (lib.sh), systemd units, templates
docs/                   documentation
```

## Commands

```bash
npm ci --ignore-scripts        # dependencies (install scripts stay off)
npm run typecheck              # server + web
npm test                       # unit and integration tests (vitest)
npm run build                  # web (Vite) + server bundle (esbuild) into dist/
npm run build:web && npm run demo   # the real app with demo data at http://127.0.0.1:8795
npm run check:ui               # headless Chrome screenshots at phone/desktop sizes → ui-shots/
```

`npm run demo` and `check:ui` run the real server, including the full Access
check, with built-in demo data instead of Hermes and Paseo. A small local "edge"
proxy plays Cloudflare and stamps a locally signed token on every request and
WebSocket handshake. Open the demo in any browser; set `PORT` to move it from
8795 (the server behind the edge listens on the next port up). At startup, the
demo's agents send a few messages through the project bridge, so bridged
messages and the Settings section have something to show; the demo doesn't
open a bridge listener. For you starts with five demo cards, a stand-in for
Hermes' pulse jobs (so the level setting works) and phone notifications that go
nowhere. `check:ui` takes `PORT` too, so two runs can share a machine.

`check:ui` drives headless Chrome, so it needs Chrome at
`/usr/bin/google-chrome`, or set `CHROME=/path/to/chrome`. It fails on any page
error or CSP violation.

`npm run dev:web` starts Vite's dev server for the web app alone. It has no API
proxy and no backend, so for a working local stack use `npm run demo`.

Every environment variable is listed in
[configuration.md](configuration.md#environment-variables).

## Tests

`npm test` runs every `*.test.ts` under `server/test/`, `web/src/` and
`scripts/`.

| Suite | What it covers |
| --- | --- |
| `server/test/security.test.ts` | Forged, expired and wrong-audience tokens, service tokens, look-alike emails, the install-file exception, CSRF, encoded paths, DNS rebinding, headers, input validation including attachments, the "/" command and control routes, WebSocket origin, expiry and re-authentication. |
| `server/test/config.test.ts` | Every unsafe config that must be refused, and `hermes.secretPrompts` staying off unless turned on. |
| `server/test/attachments.test.ts` | File checks: the type comes from the bytes, PDFs, UTF-8 text and documents whose bytes match their name, size and count limits, clean names. |
| `server/test/hermes.test.ts` | The Hermes adapter against `fake-hermes.ts`, a protocol-faithful stand-in for the dashboard: sign-in, listing, streaming, tool calls, approval round trip, password prompts left to a notice by default. |
| `server/test/hermes-requests.test.ts` | Cards kept in step with what Hermes still has open: no cards from a snapshot of a chat that isn't running or waiting, leftovers cleared when a turn ends, the chat stops or you tap Stop (with or without Hermes' `request.cancel`), cards Hermes lost in a restart dropped without resuming the chat, cards kept and rechecked through a dropped socket, and restored requests answered with `request.answer`, whose `expired` removes the card. Against the fake's crash marker, Signalbox never cold-resumes a chat on its own: not after a restart, and not for opening one (history, chips, "/" menu, Stop), while live chats you have open are re-attached, or attached once they become live, and stream. |
| `server/test/hermes-subagents.test.ts` | Hermes `delegate_task` runs under their chats: each parent rule in turn, compressed chats and runs (earlier ids, the fold, one row per run), ACP parents by uuid and by lookup, the per-parent cap and orphans; against the fake, `sessions.show_subagents` on and off, the version check once per connection, caching and refreshes, and runs opened read-only with every action refused. |
| `server/test/hermes-secrets.test.ts` | Hermes password prompts: only a notice while `hermes.secretPrompts` is off; with it on, cards for sudo, secrets, vault unlocks, 2FA codes and logins to save; answers in the exact shape Hermes expects, on the request's connection or with `request.answer`; declines; refused shapes, chats and cards; cancelled and expired requests; and a marker password and login that reach Hermes but no response, event, log, card or state file, even when the request is invalid. |
| `server/test/hermes-commands.test.ts` | Hermes "/" commands, files, model and reasoning: parsing, blocked commands, the menu, output cleanup, uploads before the prompt, image-only messages, refusing files mid-turn, slow commands, stored turns shown as typed, the pickers, reading images through the dashboard, vision tool summaries, and following a chat that moves to a new id. |
| `server/test/paseo.test.ts` | Mode tiers, permission and question mapping, the timeline mirror (replays, gaps, epoch changes), launch validation, approval routing, files, steering, "/" commands, the model, reasoning and mode pickers, reading images an agent showed, and when an agent was last active (not moved by reloads). |
| `server/test/media.test.ts` | Images from your machine: which paths count, signing links per conversation, refused folders, finding images in replies and tool cards, and the media route serving only real images an agent showed. |
| `server/test/bridge.test.ts` | The project bridge: project scoping, reading, delivery and queueing, the envelope, reply addresses and "/" refusal, identified Hermes callers, `wait_for_reply` (replies, finished turns, time-outs, one wait per chat, pausing, hang-ups), every rate limit and the loop breaker, starting chats (mode tiers, caps, parents), the Pause switch, no approval surface, logs without message text, the listener's token, Origin, Host and body checks, `/api/bridge`, the config and the token file. |
| `server/test/bridge-project.test.ts` | Bridge building blocks: project resolution matching the Projects view, envelopes with and without a reply address, envelopes in titles and previews, transcripts and chat entries, and the send limits. |
| `server/test/bridge-adapters.test.ts` | How the Hermes and Paseo adapters start chats for the bridge: titles, "started by", and Paseo's parent label. |
| `scripts/test-bridge.test.ts` | `bridge/signalbox-bridge.mjs` driven over stdio against a fake listener: the MCP handshake, forwarding calls with the token and who's calling, the Hermes plugin's caller id (sent as a header only when Hermes started the bridge), waiting for a reply, error mapping, a missing or replaced token, loopback-only URLs, no proxy, cancelling, and hanging up on a held wait when the client goes away. |
| `web/src/markdown.test.ts` | XSS payloads through the markdown pipeline (jsdom), and how images from your machine render. |
| `web/src/media.test.ts` | Loading images from your machine: only signed links, fetched once with the API marker, shown as `blob:` URLs, image types only, and a memory cap. |
| `web/src/reveal.test.ts` | Invisible characters and padding in approval details. |
| `web/src/projects.test.ts` | Grouping by project and nesting of sub-agents. |
| `web/src/slash.test.ts` | The "/" menu: when it opens, ranking, grouping, argument values, editing, and cleaning command output. |
| `web/src/previews.test.ts` | Thumbnails of sent photos following their message. |
| `web/src/controls.test.ts` | The model and mode chips: chip text, token counts, and grouping and filtering in the picker. |
| `web/src/bridge.test.ts` | Titles and previews of bridged messages, whole or cut short. |
| `server/test/voice.test.ts` | Voice mode: recordings assembled per run, stale and cancelled runs ignored, the length cap and idle drop, failures; the speech client against a fake Unix-socket service (requests, refusals, no echo, nothing answering); `/api/voice` and `/api/voice/speak` under the API rules, the microphone policy, and audio over a real WebSocket. |
| `web/src/voice/text.test.ts` | Cutting replies into sentences as they stream (ported from an earlier, tested splitter) and turning Markdown into what's worth saying. |
| `web/src/voice/reader.test.ts` | Reading a reply aloud as it streams: only replies after your message, no rereading after a reload renames items, the length cap, two clips ahead, giving up on failures, stopping. |
| `server/test/feed.test.ts` | For you: the card store (keys, updates that keep your choices, closed cards staying closed, cleaning, pruning, the file's mode); Web Push (RFC 8291's own test vector, VAPID signatures, the push-service allowlist, dropping gone devices); the service ("Do it", "Not now" around quiet hours, "Less like this", approval notifications without the command, card notifications only when chosen, the proactivity level); `/api/feed` and `/api/push` under the API rules; and the bridge's `/pulse/v1` routes. |
| `web/src/feed.test.ts` | For you's card order, "back at …" labels and the new-card count. |

The Hermes plugin has its own tests, `hermes-plugin/tests/test_signalbox_identity.py`,
in plain `unittest`; `npm test` and CI don't run them. They cover which calls
get the session id and when the hook stays out of the way. Run them as the user
Hermes runs as, through Hermes' launcher, so the tests that load the plugin
through Hermes' own plugin manager run too:

```bash
hermes --run-module unittest discover -s hermes-plugin/tests -v
```

With plain `python3 -m unittest`, only the hook tests run and the rest are
skipped.

### Paseo compatibility

`scripts/paseo-compat/run.ts` starts a **real** Paseo daemon in-process, with an
isolated home and a random port, whose only agent is
`scripts/paseo-compat/fake-acp-agent.mjs`. That is a tiny ACP agent that
streams a reply, asks for a permission, waits to be cancelled, takes files,
announces two "/" commands and "draws" a PNG into its folder. Started with
`--modes`, it also offers modes (one without safeguards), models and thinking
levels. The harness drives Signalbox's Paseo adapter end to end: consent,
launch, permission, streaming, follow-up, stop, the agent's commands, files, a
message sent while it works, the model, reasoning and mode pickers, reading the
images it shows, and a daemon restart after which stored agents must not be
woken. A fake `hermes` provider checks that the `signalbox.parent-hermes-chat`
label comes back as the agent's parent, and that its alias is the ACP session
id the fake agent reports, before and after that restart.

```bash
npm install --prefix /tmp/paseo-latest --ignore-scripts @getpaseo/server@latest
npm run check:paseo -- /tmp/paseo-latest/node_modules/@getpaseo/server
```

The daemon's own logs are off; set `PASEO_LOG=debug` (or another log level) to
see them.

### Against your own services

`scripts/e2e-local.ts` runs the **built** server against the Hermes and Paseo on
your machine, behind a local stand-in for Cloudflare Access, and screenshots the
inbox, the projects view and Settings. It also checks that a request without a
token is refused. It only reads lists; it doesn't open conversations or send
anything. It starts with an empty state directory, so Hermes shows as needing
sign-in, and it needs Chrome, like `check:ui`.

```bash
npm run build && npx tsx scripts/e2e-local.ts e2e-shots
```

It uses ports 8797 to 8799 and writes its screenshots to the folder you name
(default `e2e-shots/`).

## Continuous integration

CI runs the type checks, the tests, the build and `npm audit` on runtime
dependencies, then the UI check, then the Paseo compatibility harness against
Paseo 0.5.1 and the latest release. A failure against the latest release is
reported but doesn't fail the build.

## Conventions

- Keep the security properties in [SECURITY.md](../SECURITY.md) true, and add a
  test when you touch request handling, auth or rendering.
- Source adapters map everything into `shared/protocol.ts`; the UI never knows
  which backend a message came from beyond its `source`.
- Never answer an approval or question without a user action, and never offer a
  mode that removes approvals without the consent step.
- No inline scripts or styles: the CSP forbids them. React `style` props are
  fine, but prefer classes.
- Don't read real agent conversations while developing. Use the demo sources,
  the fakes, or read-only listings.
