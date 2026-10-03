# Developing Wayroost

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
npm run build:web && npm run demo   # the real app with demo data at http://127.0.0.1:8890
npm run check:ui               # headless Chrome screenshots at phone/desktop sizes → ui-shots/
```

`npm run demo` and `check:ui` run the real server, including the full Access
check, with built-in demo data instead of Hermes and Paseo. A small local "edge"
proxy plays Cloudflare and stamps a locally signed token on every request and
WebSocket handshake. Open the demo in any browser; set `PORT` to move it from
8890 (the server behind the edge listens on the next port up). At startup, the
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

`npm test` runs every `*.test.ts` under `supervisor/test/`, `server/test/`,
`web/src/` and `scripts/`.

| Suite | What it covers |
| --- | --- |
| `server/test/security.test.ts` | Forged, expired and wrong-audience tokens, service tokens, look-alike emails, the install-file exception, CSRF, encoded paths, DNS rebinding, headers, input validation including attachments, the "/" command and control routes, WebSocket origin, expiry and re-authentication. |
| `server/test/config.test.ts` | Every unsafe config that must be refused, and `hermes.secretPrompts` staying off unless turned on. |
| `server/test/attachments.test.ts` | File checks: the type comes from the bytes, PDFs, UTF-8 text and documents whose bytes match their name, size and count limits, clean names. |
| `server/test/hermes.test.ts` | The Hermes adapter against `fake-hermes.ts`, a protocol-faithful stand-in for the dashboard: sign-in, listing, streaming, tool calls, approval round trip, password prompts left to a notice by default. |
| `server/test/hermes-requests.test.ts` | Cards kept in step with what Hermes still has open: no cards from a snapshot of a chat that isn't running or waiting, leftovers cleared when a turn ends, the chat stops or you tap Stop (with or without Hermes' `request.cancel`), cards Hermes lost in a restart dropped without resuming the chat, cards kept and rechecked through a dropped socket, and restored requests answered with `request.answer`, whose `expired` removes the card. Against the fake's crash marker, Wayroost never cold-resumes a chat on its own: not after a restart, and not for opening one (history, chips, "/" menu, Stop), while live chats you have open are re-attached, or attached once they become live, and stream. |
| `server/test/hermes-subagents.test.ts` | Hermes `delegate_task` runs under their chats: each parent rule in turn, compressed chats and runs (earlier ids, the fold, one row per run), ACP parents by uuid and by lookup, the per-parent cap and orphans; against the fake, `sessions.show_subagents` on and off, the version check once per connection, caching and refreshes, and runs opened read-only with every action refused. |
| `server/test/hermes-secrets.test.ts` | Hermes password prompts: only a notice while `hermes.secretPrompts` is off; with it on, cards for sudo, secrets, vault unlocks, 2FA codes and logins to save; answers in the exact shape Hermes expects, on the request's connection or with `request.answer`; declines; refused shapes, chats and cards; cancelled and expired requests; and a marker password and login that reach Hermes but no response, event, log, card or state file, even when the request is invalid. |
| `server/test/hermes-commands.test.ts` | Hermes "/" commands, files, model and reasoning: parsing, blocked commands, the menu, output cleanup, uploads before the prompt, image-only messages, refusing files mid-turn, slow commands, stored turns shown as typed, the pickers, reading images through the dashboard, vision tool summaries, and following a chat that moves to a new id. |
| `server/test/paseo.test.ts` | Mode tiers, permission and question mapping, the timeline mirror (replays, gaps, epoch changes), launch validation, approval routing, files, steering, "/" commands, the model, reasoning and mode pickers, reading images an agent showed, and when an agent was last active (not moved by reloads). |
| `server/test/media.test.ts` | Images from your machine: which paths count, signing links per conversation, refused folders, finding images in replies and tool cards, and the media route serving only real images an agent showed. |
| `server/test/bridge.test.ts` | The project bridge: project scoping, reading, delivery and queueing, the envelope, reply addresses and "/" refusal, identified Hermes callers, `wait_for_reply` (replies, finished turns, time-outs, one wait per chat, pausing, hang-ups), every rate limit and the loop breaker, starting chats (mode tiers, caps, parents), the Pause switch, no approval surface, logs without message text, the listener's token, Origin, Host and body checks, `/api/bridge`, the config and the token file. |
| `server/test/bridge-project.test.ts` | Bridge building blocks: project resolution matching the Projects view, envelopes with and without a reply address, envelopes in titles and previews, transcripts and chat entries, and the send limits. |
| `server/test/paseo-events.test.ts`, `server/test/paseo-agents.test.ts`, `server/test/paseo-mirror.test.ts` | Paseo 0.9.2 subscriptions through the client library's own ownership lifecycle: permission and sub-agent events and the agent list recovering after a failed or interrupted subscription, cumulative catch-up snapshots, text kept in order around tool updates, and reloads that discard stale fetches. |
| `web/src/router.test.ts`, `web/src/pages/*.test.ts`, `web/src/*.regressions.test.ts` | The shell: every page at its own URL (Home at `/`, Chats at `/chats`, Settings and its pages), quick-action sheets that never stack, settings search and timing labels, and the Status & power page's pickers, confirm taps, focus and progress polling. |
| `web/src/approvalCard*.test.ts`, `web/src/shellWords.test.ts`, `web/src/commandGrammar.test.ts`, `server/test/approval-normalization.test.ts` | Approval cards: who is asking (by role), what happens in plain words, and how risky it is. A command's risk comes from reading it as the shell would; anything Wayroost can't resolve (expansions, braces, globs, substitutions) shows as High rather than guessed. The choices shown are only the ones the agent offered. |
| `web/src/approvalLink.test.ts`, `web/src/components/ApprovalDock.links.test.ts` | A desktop toast's Open link (`#approval-<id>`): that card first, following hash changes, in-app links and back/forward, and the usual order once it is answered. |
| `desktop/test/*.test.ts` | The desktop companion, without an Electron window: toast XML and "Allow once" rules, single-use toast tickets, the rescue client, tray state, the main-process approval client, the desktop marker on the app session, and losing the pairing. `fuses.test.ts` needs the desktop package's own install and runs in its CI job; `scripts/root-suite.test.ts` checks the root run collects only what the root install can run. |
| `web/src/power*.test.ts` | The power client: the server's status envelope, polling only while the page is visible, no stale controls after a failed refresh, and the plain words the status block uses. |
| `scripts/demo-power.test.ts` | The demo's pretend supervisor, alone and behind the production power routes: a paired desktop acts at once, a paired phone confirms with a single-use tap. |
| `server/test/shadow*.test.ts`, `server/test/state-directory.test.ts`, `server/test/environment.test.ts`, `server/test/gate-contract.test.ts`, `server/test/helper-role.test.ts` | The shadow role: every unattended side effect behind one gate in shadow and running in primary, signed-in actions working in both, startup wiring, state directories that a shadow and a primary never share, and Wayroost's environment names with their legacy `SIGNALBOX_*` fallbacks. |
| `server/test/live-device.test.ts` | The live device check before every change: a desktop or phone revoked while its body is pending changes nothing (approvals, messages, interrupts, folders, settings, power), and every mutating route in the app's route table is held to the check or to the one exemption, redeeming a pairing code. |
| `scripts/wayroost-wrapper.test.ts` | `sudo wayroost pair` / `pair-desktop`, rendered with invented paths: the explicit device kind, the installed config, nothing taken from the caller, root only. |
| `server/test/power.test.ts` | Status & power against a fake supervisor: the cached snapshot and its live pushes, a phone's confirm tap (bound to that device and that exact request, single use, expiring), what a phone may not do, busy answers, presence, only paired devices acting (an Access sign-in alone is refused, a revoked phone's tap dies with it), the API rules on every route, and no token or key in the logs. |
| `server/test/supervisor-client.test.ts` | The supervisor client over a real Unix socket: the key, status, actions, action records, the reconnecting event stream and busy pushes. |
| `server/test/busy.test.ts` | The counts "when idle" waits on: unknown whenever a source can't say for certain, and nothing pushed then. |
| `scripts/paseo-compat/isolation.test.ts` | The compatibility harness's environment isolation, built-in provider list and development-port fallback. |
| `scripts/paseo-compat/isolated-home.test.ts` | The compat checks' temp home: what moves and what's dropped, Git's trace and repository variables, and the guard that fails when your real skill folders change. |
| `server/test/worker-approvals.test.ts`, `server/test/safety-*.test.ts`, `server/test/config-lock.test.ts` | "Workers' approvals come to me" in production ([worker-approvals.md](worker-approvals.md)): the saved choice and undo records, shared config lock, bounded revision retries, post-write conflicts, final disk and effective-policy checks, uncovered providers, the owner-side helper's RPC, and paired-desktop writes. |
| `server/test/install-config.test.ts` | The generated server config's desktop origin and pairing next to public Access, and the `paseo-password` credential only when its source exists. |
| `scripts/paseo-compat/safety-config.test.ts` | Merging "Workers' approvals come to me" into Paseo's per-provider tool limits, and undoing it exactly, including limits changed while it was on; the lead, worker and reviewer role providers. |
| `server/test/tasks.test.ts`, `server/test/tasks-api.test.ts`, `server/test/hub-readiness.test.ts`, `server/test/chat-identity.test.ts`, `scripts/worker-updates-copy.test.ts` | Worker updates and the task log ([bridge.md](bridge.md#worker-updates)): launch proof from the chat's own `paseo run`, what is posted and when, quoting worker text, overdue notices and cards, budgets, held and undelivered updates across restarts, Hermes chat moves, live chat readiness before a delivery, `/api/tasks`, and the relay staying off in shadow. |
| `server/test/bridge-adapters.test.ts` | How the Hermes and Paseo adapters start chats for the bridge: titles, "started by", and Paseo's parent label. |
| `scripts/test-bridge.test.ts` | `bridge/signalbox-bridge.mjs` driven over stdio against a fake listener: the MCP handshake, forwarding calls with the token and who's calling, the Hermes plugin's caller id (sent as a header only when Hermes started the bridge), waiting for a reply, error mapping, a missing or replaced token, loopback-only URLs, no proxy, cancelling, and hanging up on a held wait when the client goes away. |
| `web/src/markdown.test.ts` | XSS payloads through the markdown pipeline (jsdom), and how images from your machine render. |
| `web/src/media.test.ts` | Loading images from your machine: only signed links, fetched once with the API marker, shown as `blob:` URLs, image types only, and a memory cap. |
| `web/src/reveal.test.ts` | Invisible characters and padding in approval details (`shared/reveal.ts`, written as escapes). |
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

The helper's tests (`helper/test_*.py`: skill syncing, the phone line status
the busy counts rely on, and the shadow role) are plain `unittest` as well, and `npm test` doesn't run
them either:

```bash
python3 -m unittest discover -s helper -p 'test_*.py'
```

### Paseo compatibility

`scripts/paseo-compat/run.ts` starts a **real** Paseo daemon in-process, on
development port 8892 (8893 if that one is taken), whose only agent is
`scripts/paseo-compat/fake-acp-agent.mjs`. That is a tiny ACP agent that
streams a reply, asks for a permission, waits to be cancelled, takes files,
announces two "/" commands and "draws" a PNG into its folder. Started with
`--modes`, it also offers modes (one without safeguards), models and thinking
levels. The harness drives Wayroost's Paseo adapter end to end: consent,
launch, permission, an approval answered outside Wayroost, streaming,
follow-up, stop, the agent's commands, files, a message sent while it works,
the model, reasoning and mode pickers, reading the images it shows, and a
daemon restart after which stored agents must not be woken. A fake `hermes`
provider checks that the `signalbox.parent-hermes-chat` label comes back as the
agent's parent, and that its alias is the ACP session id the fake agent
reports, before and after that restart.

The harness keeps out of your home. Before it loads any daemon code, it notes
what is in `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`, where
Paseo keeps its skills up to date at startup. Then it keeps only an allowlist of
inherited environment variables (`scripts/paseo-compat/isolation.ts`) and points
`HOME`, `USERPROFILE`, the XDG folders, temp, Git's global config and
`PASEO_HOME` into the temp folder. Variables that name a path outright and
don't follow `HOME` aren't on the allowlist, so they're gone: the provider
folder pointers (`CODEX_HOME` and the like), the targets of Paseo's debug
output (such as `PASEO_GIT_TRACE_FILE`), Git's own trace targets, and the Git
variables that point at a repository (`GIT_DIR` and the like). Git's system
config is skipped and trace2 is switched off, since the system git config can
name a trace target too. Every built-in provider listed in the installed
daemon's own manifest is turned off, so no real agent CLI starts. The check
fails if anything in those three folders of your real home changed while it
ran (it compares only names and modification times), and prints PASS only
after that.

`npm run check:paseo-tools` runs `scripts/paseo-compat/tool-policy.ts` (Paseo
0.9 or later) with the same isolation. It checks that the daemon refuses the
agent tools a provider is denied in `agents.providers.<id>.paseoTools`, switched
the way Wayroost will switch them: merged into `config.json` by
`server/src/paseo/safety-config.ts` (the production transformer), undone from its backup, and applied
with a daemon reload. Known gaps are reported as `GAP` lines and don't fail the
run. Both checks use the same development ports, so run them one after the
other.

```bash
npm install --prefix /tmp/paseo-latest --ignore-scripts @getpaseo/server@latest
npm run check:paseo -- /tmp/paseo-latest/node_modules/@getpaseo/server
npm run check:paseo-tools -- /tmp/paseo-latest/node_modules/@getpaseo/server
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

It uses ports 8897 to 8899 and writes its screenshots to the folder you name
(default `e2e-shots/`).

## Continuous integration

CI runs the type checks, the tests, the build and `npm audit` on runtime
dependencies, then the UI check, then the Paseo compatibility harness and the
tool-limit check against Paseo 0.9.2 and the latest release. A failure against
the latest release is reported but doesn't fail the build.

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
