> This is the guide to **Signalbox**, the app Wayroost starts from. For Wayroost itself, see the [main README](../README.md).

# Signalbox

Signalbox is a self-hosted web app that puts your
[Hermes Agent](https://github.com/NousResearch/hermes-agent) chats and your
[Paseo](https://github.com/getpaseo/paseo) coding agents into one
phone-friendly interface. It runs on the machine where your agents run. Your
phone reaches it through a Cloudflare Tunnel, so you don't open any ports, and
Cloudflare Access lets only you in. From anywhere, you can watch your agents
work, approve or deny what they want to do, answer their questions, and start
new work.

## Features

- **One inbox.** Hermes chats and Paseo agents in one list. Anything waiting on
  you is pinned to the top, and a banner takes you straight to it. Filter by
  *Needs you*, Hermes or Paseo, or search.
- **Projects view.** Everything grouped by project folder, with a Hermes lane
  and a Paseo lane. Agents started by another agent are nested under the thread
  that started them, and each thread links to its parent and to the agents it
  started. A Hermes chat working inside a Paseo project joins that project.
  Hermes agents running inside Paseo carry a **Hermes · in Paseo** badge and
  aren't listed twice.
- **Live timelines.** Replies stream in as they're written, with the model's
  reasoning and every tool call (input, output, status) in cards you can open.
  The app reconnects by itself and catches up when your phone brings it back to
  the front.
- **Photos and files.** Attach up to four photos, PDFs, text files, Office
  documents (Excel, Word, PowerPoint), archives or SQLite/Parquet files to a
  message, 10 MB each. The browser shrinks large photos first, and the server
  checks every file's real type before an agent sees it.
- **"/" commands and skills.** Type `/` for a menu of the conversation's
  commands and skills. Hermes commands run the way the Hermes desktop app runs
  them, with their output in the timeline, and the few that switch safeguards
  off are refused. Paseo agents list their own commands, get "/" text as a
  message and run it themselves.
- **Model and mode.** Chips above the message box switch the model, the
  reasoning level and, for Paseo, the mode, for that conversation only, and a
  ring shows how full the context window is. Hermes' saved defaults never
  change, and expensive models ask first. A Paseo mode that acts on its own
  needs an explicit OK, and modes that turn every safeguard off are never
  offered.
- **Images from your machine.** When an agent shows you a chart it drew or a
  screenshot a tool took, you see it in the conversation, with a full-screen
  viewer. The browser never asks for a file by path: the server signs each
  link, refuses system and credential folders, and serves only real images.
- **Agents that work together (optional).** With the project bridge on, the
  agents in one project, across Hermes and Paseo, can list, read, message and
  start each other's chats, and wait for an answer. Messages are labelled as
  coming from an agent, say which chat to reply to when Signalbox knows the
  sender, and wait until the other chat is idle. Rate limits and a loop breaker
  hold runaway agents back, new agents start only in modes that ask you,
  approvals stay with you, and one tap in Settings pauses it all.
- **Approvals and questions.** Answer permission requests with big buttons:
  Hermes offers Allow once, Allow for this chat, Always allow and Deny; Paseo
  agents offer their own options. Answer questions with one choice, several
  (multi-select) or a typed answer.
- **Hard to trick.** Commands are shown in full, with invisible characters and
  padding made visible. Long commands must be expanded before Allow unlocks,
  and a command too long to show can only be denied. A new card ignores taps
  for ¾ s, so a double-tap can't approve the next request. The server accepts
  only options that were actually offered. Nothing is approved automatically,
  and Hermes password prompts (sudo, secrets, vault unlocks, 2FA codes and
  logins to save) can be answered from your phone only if you turn that on.
  What you type then goes straight to Hermes and is never kept.
- **Start work from your phone.** Launch a Paseo agent with any provider Paseo
  has ready, in a recent project folder or any other. Permission modes are
  vetted: modes that ask you are offered normally, modes that act on their own
  need an explicit "I understand", and modes that turn every safeguard off are
  never offered. Or start a Hermes chat, optionally in a folder. Send follow-ups
  and stop a running turn.
- **For you (optional).** Hermes' morning brief and daytime checks put what
  needs you on cards: a reply to send, a meeting to get ready for, a promise
  coming due. **Do it** hands the card to Hermes after showing you exactly
  what it will be asked; **Not now** and **Less like this** teach it what to
  leave alone. Choose how often Hermes speaks up and when it stays quiet, and
  get a phone notification when an agent is waiting on you. See
  [docs/for-you.md](for-you.md).
- **Voice (optional).** Hold the mic to talk to an agent, and hear its reply
  read aloud as it streams in. Speech is turned into text and back on your own
  PC, on the CPU, by a locked-down local service; nothing is sent anywhere else
  or kept. See [docs/voice.md](voice.md).
- **Skills.** Every agent's skills (Hermes, pi, Claude Code, Codex, OpenCode,
  on Linux and Windows) in one list, kept the same everywhere: the shared
  folder spreads to every app within seconds, a copy changed inside one app
  waits for your decision, and a marketplace installs scanned skills for every
  app. See [docs/skills.md](skills.md).
- **Tidy up.** Archive or delete a thread from its ⋯ menu. Archive a whole
  project folder: it stays out of sight until something new starts there.
  Archive every thread idle for more than a week or a month in one tap, and
  restore anything from Settings → Archived threads. Archiving uses Hermes' and
  Paseo's own archive, so their apps hide the threads too.
- **Installable.** Add it to your home screen and it opens full screen, like an
  app. Light and dark themes follow your phone, and unsent drafts are kept per
  conversation.
- **Locked down.** Cloudflare Access checks your email at the edge, cloudflared
  checks the Access token again, and Signalbox verifies it a third time on every
  request and WebSocket, apart from the home-screen icons and manifest. On top
  of that: CSRF and WebSocket-origin checks, Host
  checks against DNS rebinding, a strict Content-Security-Policy, sanitized
  agent output, and a sandboxed systemd service. See [SECURITY.md](../SECURITY.md).

## Screenshots

| Inbox | Projects | A Hermes approval |
| --- | --- | --- |
| <img src="images/01-phone-inbox-dark.png" width="250" alt="Inbox with two requests waiting, pinned to the top"> | <img src="images/11-phone-projects.png" width="250" alt="Projects view with Hermes and Paseo lanes and nested sub-agents"> | <img src="images/03-phone-approval.png" width="250" alt="A Hermes chat asking to run a recursive delete, with Allow once, Allow for this chat, Always allow and Deny"> |

| A hidden payload, made visible | An agent at work | Launching an agent |
| --- | --- | --- |
| <img src="images/09-phone-hidden-payload.png" width="250" alt="An approval card that reveals a command hidden behind blank lines and a direction-changing character"> | <img src="images/04-phone-agent.png" width="250" alt="A Paseo agent's timeline with tool calls, reasoning and a streaming reply"> | <img src="images/10-phone-new-pi.png" width="250" alt="Launching an agent that acts on its own, with the I understand checkbox"> |

| The "/" menu | Command output | Photos and files |
| --- | --- | --- |
| <img src="images/13-phone-slash-menu.png" width="250" alt="The slash menu in a Hermes chat, with commands grouped by section"> | <img src="images/15-phone-command-output.png" width="250" alt="Output of Hermes commands shown as command blocks in the timeline"> | <img src="images/16-phone-attachments.png" width="250" alt="Messages with attached files shown as chips and a photo thumbnail"> |

| Model and reasoning | A mode that acts on its own | An image from your machine |
| --- | --- | --- |
| <img src="images/22-phone-controls-strip.png" width="250" alt="Model and reasoning chips above the message box of a Hermes chat, with the context ring"> | <img src="images/24-phone-mode-consent.png" width="250" alt="Switching a Paseo agent to Accept File Edits, waiting for the I understand checkbox"> | <img src="images/26-phone-inline-image.png" width="250" alt="A chart from the agent's project folder shown inline in a reply, with a thumbnail below"> |

| The image viewer | An image a tool looked at |
| --- | --- |
| <img src="images/27-phone-image-viewer.png" width="250" alt="An image from the machine opened full screen"> | <img src="images/28-phone-tool-image.png" width="250" alt="A thumbnail of the screenshot a tool looked at, on its tool card"> |

| A message from another agent | The project bridge in Settings |
| --- | --- |
| <img src="images/29-phone-bridged-message.png" width="250" alt="A Hermes chat started by a Paseo agent, with its messages shown as From Fix flaky login test (Claude Code) via Signalbox"> | <img src="images/30-phone-bridge-settings.png" width="250" alt="The Project bridge section of Settings, paused, with the last hour's activity"> |

<img src="images/08-desktop.png" width="780" alt="Signalbox on a desktop browser: inbox and conversation side by side">

The screenshots use the built-in demo data. `npm run check:ui` takes them.

## How it works

```
 phone ── HTTPS + WebSocket ──▶ Cloudflare Access ── only your email gets past
                                        │
                                        ▼  Cloudflare Tunnel (outbound from your machine, no open ports)
                                   cloudflared ── checks the Access token again
                                        │  127.0.0.1:8790
                                        ▼
                                    Signalbox ── checks the token a third time
                                     ├──▶ Hermes dashboard  127.0.0.1:9119
                                     └──▶ Paseo daemon      127.0.0.1:6777
```

Signalbox is a small server plus a web app. The server runs next to your agents
as a sandboxed systemd service and listens only on loopback (`127.0.0.1:8790`
by default). It turns Hermes and Paseo into one stream of conversations,
timelines and approvals, and pushes live updates to your browser over one
WebSocket. Hermes and Paseo stay local: only Signalbox is routed through the
tunnel. The optional project bridge, which lets agents reach each other's
chats, listens on `127.0.0.1` only and is never routed.

Read more in [docs/how-it-works.md](how-it-works.md).

## Requirements

| Requirement | Notes |
| --- | --- |
| Linux with systemd | The machine your agents run on. Tested on Ubuntu 22.04, including WSL2 with systemd enabled. |
| Node.js 22 or newer, installed system-wide | The installer checks the version, and refuses a `node` or `npm` that anyone but root could modify, such as one from nvm in your home directory. |
| `cloudflared` | From [Cloudflare's downloads](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/). The scripts also use `git`, `rsync`, `curl` and `python3`. |
| A Cloudflare account and a domain on Cloudflare | The free plan works. Cloudflare Access (Zero Trust) is free for up to 50 users. |
| Hermes Agent and/or Paseo | Either or both. Hermes: its dashboard running (default port 9119) with password sign-in. Paseo: its daemon running (default port 6777). |

Tested with Hermes Agent 0.21 and Paseo 0.5.1 and 0.9.2.

## Quick start

The full guide is [docs/setup.md](setup.md). Plan on about 30 minutes;
every step is safe to repeat. In short:

1. **Get the code** into a directory only root can change. The installer runs
   it as root, so it refuses a directory that anyone but root could modify,
   including through a parent directory: your home directory, for example, or
   Debian's group-writable `/usr/local/src`.

   ```bash
   sudo git clone https://github.com/vankoala/wayroost /opt/src/signalbox
   ```

2. **Create a Cloudflare Access application** (Zero Trust → Access →
   Applications → Self-hosted) for your hostname, for example
   `signalbox.example.com`, with a policy that allows only your email. Do this
   before the tunnel exists, so the hostname is protected from the moment it
   resolves.

3. **Write the config.** Set `access.allowedEmails`, and
   `hermes.enabled` / `paseo.enabled`. Leave `publicOrigin`,
   `access.teamDomain` and `access.aud` as they are; step 5 fills them in.

   ```bash
   sudo install -d -m 755 /etc/signalbox
   sudo cp -n /opt/src/signalbox/deploy/config.example.json /etc/signalbox/config.json
   sudoedit /etc/signalbox/config.json
   ```

4. **Install.** The installer checks that only root can modify the code and
   the `node` and `npm` it runs, installs dependencies with npm install scripts
   disabled, runs the tests, builds, copies the result to `/opt/signalbox`, and
   enables `signalbox.service`. It starts the service once step 5 has filled in
   the config.

   ```bash
   sudo /opt/src/signalbox/deploy/install.sh
   ```

5. **Create the tunnel.** Sign cloudflared in once, then run the setup script
   with your bare hostname. It creates or reuses a tunnel named `signalbox`,
   points your hostname at it (replacing any existing DNS record for that
   name), writes `publicOrigin` and the Access team and AUD tag from
   Cloudflare's login redirect into the config, writes
   `/etc/signalbox/cloudflared.yml`, and starts Signalbox and
   `signalbox-tunnel.service`.

   ```bash
   sudo -H cloudflared tunnel login
   sudo /opt/src/signalbox/deploy/setup-tunnel.sh signalbox.example.com
   ```

6. **Open it on your phone.** Go to `https://signalbox.example.com` and sign in
   through Cloudflare Access. If you run Hermes, enter your Hermes dashboard
   username and password under **Settings → Hermes sign-in**. Then add
   Signalbox to your home screen (Safari: **Share → Add to Home Screen**;
   Chrome: **⋮ → Add to Home screen**).

To let the agents in a project work together, turn on the project bridge
afterwards (step 7 of the setup guide).

To update, run `sudo git pull` in `/opt/src/signalbox`, then
`sudo deploy/install.sh`, and `sudo deploy/setup-tunnel.sh <hostname>` too if
the pull changed anything in `deploy/`. If you use the project bridge, run
`sudo deploy/setup-bridge.sh <user>` again after `install.sh`, then restart the
Hermes dashboard and gateway ([docs/bridge.md](bridge.md#upgrading)).
Checking the lock-down, uninstalling, running on WSL2 and troubleshooting are
covered in [docs/setup.md](setup.md).

## Documentation

| Document | What's in it |
| --- | --- |
| [docs/setup.md](setup.md) | Installing step by step, checking the lock-down, updating, uninstalling, WSL2, troubleshooting. |
| [docs/configuration.md](configuration.md) | Every config field, environment variables, files and ports. |
| [docs/how-it-works.md](how-it-works.md) | The architecture, the checks on every request, live updates, approvals. |
| [docs/hermes.md](hermes.md) | How Signalbox signs in to and talks with the Hermes dashboard. |
| [docs/paseo.md](paseo.md) | How Signalbox talks to the Paseo daemon, and the permission-mode tiers. |
| [docs/bridge.md](bridge.md) | The optional project bridge: the tools agents get, who's calling, delivery and replies, limits, pausing, setup and upgrading. |
| [docs/voice.md](voice.md) | Optional voice mode: talking and listening, how it works, setup, privacy and security. |
| [docs/for-you.md](for-you.md) | Optional For you: cards from Hermes' brief and daytime checks, proactivity and quiet hours, phone notifications, the card routes, privacy and security. |
| [docs/skills.md](skills.md) | Settings → Skills: every agent's skills kept the same everywhere, the safety rules, the marketplace, setup. |
| [docs/development.md](development.md) | Code layout, commands, test suites, the Paseo compatibility harness. |
| [SECURITY.md](../SECURITY.md) | Threat model, security layers, known limits, reporting a vulnerability. |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to propose changes and what a pull request needs. |
| [CHANGELOG.md](../CHANGELOG.md) | What changed in each release. |

## Development

You don't need Hermes, Paseo or Cloudflare to work on Signalbox. The demo runs
the real server, including the full Access check, with built-in demo data and a
local stand-in for Cloudflare:

```bash
npm ci --ignore-scripts
npm run build:web && npm run demo    # http://127.0.0.1:8795
```

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks the server and the web app. |
| `npm test` | Runs the tests (Vitest). |
| `npm run build` | Runs `build:web` and `build:server`. |
| `npm run build:web` | Builds the web app with Vite into `dist/web`. |
| `npm run build:server` | Bundles the server with esbuild into `dist/server/index.js`. |
| `npm start` | Runs the built server with the config at `SIGNALBOX_CONFIG` (default `/etc/signalbox/config.json`). |
| `npm run dev:web` | Starts the Vite dev server for the web app alone. It has no API proxy, so use the demo for a working local stack. |
| `npm run demo` | Runs the real server with demo data behind a local stand-in for Cloudflare Access, at `http://127.0.0.1:8795` (set `PORT` to move it). Build the web app first. Open it in any browser. |
| `npm run check:ui` | Builds the web app, drives headless Chrome at phone and desktop sizes, and saves screenshots to `ui-shots/`. Fails on any page error or CSP violation. Needs Chrome at `/usr/bin/google-chrome`, or set `CHROME`. |
| `npm run check:paseo -- <dir>` | Runs the Paseo adapter end to end against a real Paseo daemon. `<dir>` is an installed `@getpaseo/server` package. |

To try the built server against your own Hermes and Paseo, read-only, run
`npm run build && npx tsx scripts/e2e-local.ts e2e-shots`. See
[docs/development.md](development.md) for the code layout, the test suites
and that script, and [CONTRIBUTING.md](../CONTRIBUTING.md) before you open a pull
request.

## Credits

- Signalbox talks to [Hermes Agent](https://github.com/NousResearch/hermes-agent)
  by Nous Research (MIT License) through the Hermes dashboard's HTTP and
  WebSocket APIs. Two parts are adapted from Hermes Agent's own clients: the
  JSON-RPC connection in `server/src/hermes/gateway.ts`, and how stored skill
  turns are shown in `server/src/hermes/normalize.ts`.
- It talks to [Paseo](https://github.com/getpaseo/paseo) (Apache License 2.0)
  with Paseo's published `@getpaseo/client` and `@getpaseo/protocol` packages.
  Parts of the Paseo adapter follow logic from the Paseo app: the timeline
  reconciliation in `server/src/paseo/mirror.ts`, and answers to multi-question
  requests in `server/src/paseo/normalize.ts`.
- [Hermes Conduit](https://github.com/kaishi00/hermes-conduit) (MIT License)
  inspired Signalbox. Its native iOS client showed how a third-party app signs
  in to and talks with the Hermes dashboard.

Neither Hermes Agent nor Paseo is included in this repository. See
[NOTICE](../NOTICE) for the full attributions and licenses.

Signalbox is an independent project. It is not affiliated with or endorsed by
Nous Research, the Paseo project, the Hermes Conduit project, or Cloudflare,
Inc. Cloudflare is a trademark of Cloudflare, Inc. Other product names and
trademarks belong to their owners. They are used only to describe
compatibility.

## License

Apache License 2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
