# Changelog

All notable changes to Signalbox are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The first public release, to be tagged 0.1.0.

### Added

- **For you** (optional; see docs/for-you.md): Hermes' morning brief and
  daytime checks put what needs you on cards, opened from a sparkles button
  with a badge and a strip in the inbox.
  - Each card can be done in a tap. **Do it** shows exactly what Hermes will be
    asked, then starts the chat. **Done** closes a reminder and ticks off the
    open loop. **Not now** brings the card back in 3 hours (never in quiet
    hours). **Less like this** tells Hermes to leave that topic alone.
  - Settings → For you sets how often Hermes speaks up (off, brief only, normal,
    often), which pauses, resumes or reschedules its pulse jobs. It also sets
    quiet hours and lists the turned-down topics.
  - Phone notifications (Web Push, implemented in Signalbox with no library)
    when an agent needs you (never showing the command), and, if you like, for
    new cards. They're turned on per device, with a test button. On iPhone they
    need the Home Screen app.
  - Cards come in through two new routes on the bridge listener
    (`/pulse/v1/preferences` and `/pulse/v1/cards`), with the bridge token.
- Scheduled jobs and mail triggers: **What it can use** (Nothing, Web search, Web + flights &
  maps, Everything). New jobs and triggers start at Nothing, because Hermes runs them
  unattended and approves their tool calls itself. They used to get every tool and every
  connected app.
  - The job builder suggests the least a job needs.
  - Edit only changes tools when asked.
  - Job details and Connectors show what each job can use, and full access gets a badge and a
    warning.
- Paseo daemon password: Signalbox sends it from the systemd credential `paseo-password`,
  rejects passwords Paseo can't carry, and logs once when the daemon refuses it.
- Home: **Recent | Projects | Scheduled** tabs with search below them. Scheduled jobs moved
  from a block on Recent to their own tab (failure badge, sections, all jobs, search); New
  on that tab starts the job builder.
- Scheduled jobs: **Edit** opens the form inside the job (it used to open below the whole
  list, off screen on a phone).
- **Scheduled jobs on the home page** (a collapsible block: running now, failed recently, next
  up, recent results), readable job names, a one-line AI-written idea per job, fuller details
  (created, when, instructions), and an **AI job builder** that drafts a job from plain words
  and suggests Hermes skills to include, for review before anything is created.
- **Settings → Scheduled jobs**: every Hermes cron job and Paseo schedule (badged by source)
  with its schedule, next and last run, and status (live for Hermes), plus run now,
  pause/resume, edit, delete, new (Hermes) jobs, and each job's recent runs. Runs open as
  chats (Hermes sessions, Paseo agents).
- **Settings → Phone**: Hermes Phone's line status, and its PIN (hidden until Show), which can
  be changed there. The PIN stays in the encrypted vault and is read and written through the
  helper and the phone server.
- **Settings → WhatsApp**: switch the whatsapp-routing Hermes plugin's reply
  routing on or off, and choose when WhatsApp returns to your own chat and
  when it starts a fresh one. Applies to the next message, no restart; written
  through the helper.
- **More attachment types**: Office documents (xlsx, xlsm, docx, pptx, xls,
  doc, ppt, ods, odt, odp), Outlook .msg, EPUB, archives (zip, tar, gz/tgz, 7z),
  SQLite and Parquet files, for agents that can open them (Codex, Claude Code).
  Each must carry its format's byte signature and a matching extension. Paseo
  and Hermes save them and give the agent the path.
- **Voice mode** (optional; see docs/voice.md): talk to your agents and hear
  their replies, on a phone or a desktop.
  - Hold the mic next to the message box to talk, or tap it to start and tap
    again to finish; slide away to cancel. What you said lands in the message
    box to check, or goes straight out with "Send what you say right away".
  - Replies to a spoken message are read aloud sentence by sentence as they
    stream in, skipping code, tables and images, with a Stop button. Every
    finished reply has a Listen button. Settings → Voice picks one of 28
    English voices and the speed, per device.
  - Speech is turned into text and back on your PC, on the CPU, by a new
    speech service (NVIDIA Parakeet TDT 0.6B v2 and Kokoro-82M through
    sherpa-onnx). It has no network, sees only its program, models and the
    system libraries, listens on a Unix socket only Signalbox may open, and runs
    from root-owned, hash-checked packages and models.
    `deploy/setup-speech.sh` sets it up; nothing is stored or logged.
  - Audio streams over the live WebSocket as 16 kHz PCM frames; the microphone
    is only allowed (`Permissions-Policy`) when voice mode is on.
- **Connectors** (Settings → Connectors): let Hermes use your apps from a card
  page that works on a phone or a desktop. See docs/hermes.md "Connectors".
  - One-tap sign-in for Notion, Todoist, Dropbox, Canva, Calendly, Strava,
    Craft, Miro, Gamma, Fireflies, WordPress.com, Cloudflare, Hugging Face and
    Comfy Cloud. These are entries in Hermes' own approved MCP catalog, signed
    in on each service's own page. The sign-in comes back to Signalbox, so it
    works from a phone. Hermes keeps every token.
  - Access for each app: "Ask before changes" (Hermes' untrusted tier, the
    default) or "Automatic". Check and Disconnect buttons.
  - Google (Gmail, Calendar, Drive and more) with a paste-back sign-in, through
    the Hermes Google Workspace skill.
  - WhatsApp and the shopping Chrome shown with their status.
  - **Mail triggers**: when new mail matches a Gmail search, Hermes does what
    you asked and tells you. It's a Hermes scheduled job with a gate script, so
    the model only wakes when matching mail arrives. Sign-in codes and password
    resets are never passed on.
  - The optional **Signalbox helper** (deploy/setup-helper.sh) runs Google's
    sign-in and the trigger folders as the Hermes user, on 127.0.0.1.
- **Inbox** for Hermes Agent chats and Paseo agents in one list, with anything
  waiting on you pinned to the top, filters (Needs you, Hermes, Paseo) and
  search.
- **Every thread says where it works.** Below the title: who runs it and its
  folder, e.g. "Desktop · ~/notes" or "Claude Code · ~/code/app".
  - A Hermes chat with no folder of its own shows the folder Hermes runs it
    in, as Hermes' dashboard reports it (`default_cwd`).
  - A Hermes chat's model is on its controls instead, since it can change.
  - Sub-agents show their folder too, then their model or agent.
- **Projects view** that groups conversations by project folder, with separate
  Hermes and Paseo lanes, links between related threads, and a "Hermes · in
  Paseo" badge for Hermes agents running inside Paseo. Everything nests under
  whatever started it, across backends: a Paseo agent under the agent or Hermes
  chat that started it, and sub-agent runs (Hermes `delegate_task` runs, Claude
  Code Task sub-agents) folded under their parent as "3 sub-agents · 1
  working". Sub-agents open read-only.
- **Runs agents start from a shell nest too.** A Hermes chat an agent starts with
  `hermes chat --oneshot`, and a `claude -p` run it starts, fold under that agent
  wherever they ran. The signalbox-identity Hermes plugin (0.2.0) and a Claude
  Code hook (`claude-hook/`, registered by `deploy/setup-bridge.sh`) report the
  launchers named in the new run's environment (`PASEO_AGENT_ID`,
  `HERMES_SESSION_ID`, `SIGNALBOX_LAUNCHER`) through the bridge; Signalbox picks
  the nearest. Claude runs show as read-only rows with their task and final
  answer (the answer Claude Code hands the Stop hook, else the transcript's, read
  again at session end), once they have either: a launch that failed before its
  prompt gets no row. The links, and the Hermes chats the bridge started, are
  kept in the state directory (`lineage.json`), so they survive a restart.
- **New chats start where you want them.** A new Hermes chat can start on any
  model Hermes offers. It applies to that chat only, like the chat's own model
  control, and a paid model needs a tick first. The choice is checked before
  the chat exists. Folder fields for Hermes and for Paseo's "Another folder"
  start at your home folder, worked out from the folders your chats and
  projects use. Left as it is, the Hermes field still means Hermes' usual
  folder. A folder you type is checked as you type. A new one is made when the
  chat starts, one level below an existing folder, through Paseo (which also
  lists it as a project). A path whose parent is missing, or that names a file,
  is flagged before anything starts. Hermes keeps only a folder that exists; if
  it still starts the chat somewhere else, Signalbox says where.
- **Live timelines**: streaming replies and reasoning, and tool calls with
  their input, output and status. Agent output is rendered as sanitized
  markdown.
- **Approvals and questions** from both backends: Hermes' Allow once, Allow for
  this chat, Always allow and Deny; each Paseo agent's own actions and plans;
  single, batch and multi-select questions with typed answers. A long card
  scrolls inside at most about 60% of the screen, with its buttons pinned to
  its bottom edge and Stop always in reach.
- **Photos and files**: up to four photos, PDFs or text files per message,
  10 MB each. Large photos are shrunk in the browser, the server checks every
  file's real type from its bytes, and sent files show on the message as chips,
  with thumbnails for photos you sent from that browser. Hermes gets them
  uploaded to the session before the prompt. Paseo agents get images and text
  files up to 100 KB inline, and PDFs and larger text files through Paseo's
  upload. Files can also be dragged onto the page from the desktop. They go to
  the open chat's next message, or to the new chat while its sheet is open. A
  file the server would refuse (a .docx, a folder) is flagged when it's
  dropped, not when the message is sent. A stray drop never makes the browser
  open the file in place of Signalbox.
- **"/" commands and skills**: a "/" menu in the message box and the New sheet.
  Hermes commands run the way the Hermes desktop app runs them (`slash.exec`,
  then `command.dispatch`); skills show as you typed them; output stays in the
  timeline; slow commands finish live; `/new` opens the New sheet. Paseo agents
  list their own commands (stored agents aren't woken to ask), get "/" text as
  a message and run it themselves.
- **Model, reasoning and mode**: chips above the message box, with a ring that
  shows how full the context window is. Hermes models and reasoning levels
  switch for one chat only, never changing Hermes' saved defaults; expensive
  models ask first, and a switch during a turn takes effect on the next one.
  Paseo agents offer their models, thinking levels and modes, with the same
  mode tiers as at launch, without waking stored agents to read them.
- **Images from your machine**: images an agent shows in a reply or a tool
  call, whether as markdown images, `MEDIA:` tags, links, paths or known tool
  fields, appear in the timeline and open in a full-screen viewer. They're read
  through Hermes or Paseo, never by path from the browser.
- **Project bridge** (optional, off by default): agents in one project, across
  Hermes and Paseo, get five MCP tools (`list_chats`, `read_chat`,
  `send_message`, `start_chat`, `wait_for_reply`) through a stdio server,
  `bridge/signalbox-bridge.mjs`, that talks to a loopback listener in
  Signalbox. Messages arrive labelled as coming from another agent, and wait
  until the chat is idle with no approvals waiting. Rate limits and a loop
  breaker hold agents back. New chats start only in the project folder, only in
  modes that ask you, and only a few per hour. Chats show who started them,
  and Settings shows the last hour's activity with a Pause switch.
- **Replies on the bridge**: a bridged message carries the sender's chat as a
  reply address, when Signalbox knows the sender, and says how to answer with
  `send_message`. `wait_for_reply` waits up to 120 seconds (45 by default) for
  the other chat to answer or finish its turn, and gives its status when time
  runs out. An answer to a chat that's waiting for it goes to the wait instead
  of into the chat.
- **Hermes chats identified on the bridge** by the `signalbox-identity` Hermes
  plugin, which adds the calling chat's session id to its Signalbox tool calls.
  Signalbox takes the id only for a chat it lists. Identified Hermes chats sign
  their messages with their title, get replies and `wait_for_reply`, are left
  out of their own `list_chats`, show as "started by" on the chats they start,
  and count for the loop breaker.
- **Paseo agents ordered by real activity**: the inbox, the Projects view and
  the bridge's `list_chats` order Paseo agents by their last user message or a
  run Signalbox saw start or stop, not by Paseo's `updatedAt`, which also moves
  when Paseo reloads or resumes an agent.
- **Hermes password prompts on your phone** (optional, off by default): with
  `hermes.secretPrompts` on, Hermes' sudo, secret, vault master password, 2FA
  code and save-a-login prompts become cards you answer on the phone, instead
  of a notice to use your PC. A sudo card shows the command and asks for a
  second tap, a code card opens a number keypad, a login card shows the exact
  site and takes a username and password, and any of them can be declined.
  The answer goes to Hermes exactly as typed, in the shape the Hermes desktop
  app sends.
- **Hermes connection**: dashboard sign-in from Settings, checked with Hermes
  before it's saved; a JSON-RPC WebSocket client with heartbeat and jittered
  reconnects; approvals from chats started in the Hermes desktop app or
  terminal; waiting cards checked against what Hermes still has open, so a
  restart, a stopped chat or a lost cancel doesn't leave a card stuck; new
  chats with an optional folder; follow-ups and Stop; following a chat that
  Hermes continues under a new id after compressing its context. Signalbox
  resumes a chat only when it's live in Hermes or you act in it, so opening a
  chat that was killed mid-turn never makes Hermes re-run that turn, and a
  re-run that a command or model change would start is cancelled.
- **Paseo connection** through the pinned `@getpaseo/client` 0.5.1, with the
  Paseo app's timeline reconciliation rules; launching agents in a recent or
  custom folder with vetted permission-mode tiers; follow-ups that steer a
  working agent as the Paseo app does; Stop.
- **Installable web app**: add it to your home screen to open it full screen;
  light and dark themes; unsent drafts kept per conversation.
- **Deployment tooling**:
  - `deploy/install.sh` checks that only root can modify the source, every
    directory above it, and the `node` and `npm` it runs. It installs
    dependencies with npm install scripts disabled, runs the tests, builds,
    installs to `/opt/signalbox`, and installs and enables `signalbox.service`.
    It starts the service only once the config has no placeholders left.
  - `deploy/setup-tunnel.sh` checks for a root-owned checkout, a root-owned and
    signed-in cloudflared, an existing config, an installed Signalbox, and a
    valid hostname and tunnel name. It creates a dedicated Cloudflare Tunnel or
    reuses the live one, including tunnels cloudflared lists with a zero
    `deleted_at` (`0001-01-01…`), and installs its credential again if the
    tunnel was recreated. It routes your hostname to the tunnel, fills in
    `publicOrigin` and the Access team and AUD tag from the login redirect,
    points the tunnel at `listen.port`, installs `signalbox-tunnel.service`,
    and restarts both services.
  - `deploy/setup-bridge.sh <user>` copies the bridge token to that user and
    registers the bridge with their Hermes, pi, OpenCode and Claude Code,
    working as that user, backing up every file it edits, and changing only its
    own entry. For Hermes it also installs the `signalbox-identity` plugin in
    `~/.hermes/plugins` and enables it (`--no-hermes-plugin` skips this).
    `--dry-run` shows the changes; `--remove` undoes them. `install.sh`
    installs the bridge's agent side to
    `/opt/signalbox/bin/signalbox-bridge.mjs`.
  - The scripts use root's own home and settings, even when `sudo` keeps
    yours.
  - `deploy/lib.sh` holds the checks both scripts share.
  - Sandboxed systemd units for the app and the tunnel. `signalbox.service`
    stops retrying after 5 failed starts within 60 s.
  - `deploy/config.example.json` and `deploy/cloudflared.yml.template`.
  - A `.gitignore` that keeps local configs and credentials out of commits.
- **Development tooling**: a demo mode with built-in demo data behind a local
  stand-in for Cloudflare Access; a headless-Chrome UI check that fails on page
  errors and CSP violations; a read-only end-to-end run against your own Hermes
  and Paseo; a protocol-faithful fake Hermes dashboard for tests; a Paseo
  compatibility harness that CI runs against Paseo 0.5.1 and the latest
  release, where a failure against the latest release is reported without
  failing the build.
- **Documentation**: setup, configuration, architecture, Hermes and Paseo
  integration, development, security and contributing guides.
- **Tidying up**: archive or delete a thread from its ⋯ menu; **Archive
  folder** in the Projects view (the folder stays hidden until something new
  starts there); **Settings → Tidy up** to archive every thread idle for more
  than 7, 14, 30 or 90 days after showing the count; and an **Archived threads**
  list to restore or delete them. Archiving uses Hermes' and Paseo's own
  archive, so their apps hide the threads too. See
  [docs/hermes.md](docs/hermes.md#archiving-and-deleting) and
  [docs/paseo.md](docs/paseo.md#archiving-and-deleting).
- **Cloud agents** in Settings: an on/off switch for each Paseo agent that runs
  on a cloud model (Claude Code, Codex, OpenCode). The switch is Paseo's own,
  so a switched-off agent can't be started from anywhere: the New sheet, the
  bridge, other agents or the Paseo app. See
  [docs/paseo.md](docs/paseo.md#cloud-agents).

### Fixed

- Hermes: two inbox refreshes that overlapped (the one after connecting, and
  yours) each fetched the sub-agent run list; they now share one request.

### Security

- The Cloudflare Access token is checked three times: at Cloudflare's edge, by
  cloudflared (`access.required`), and by Signalbox on every request and
  WebSocket upgrade (RS256 signature, issuer, audience, expiry, and an email
  allowlist compared as plain ASCII; service tokens are rejected). The one
  exception is a `GET` for the six files a browser needs to add the app to the
  home screen (the web manifest and icons). They skip Signalbox's own token
  check but stay behind Access and cloudflared.
- CSRF protection for API calls (a custom request header, `Sec-Fetch-Site`, an
  exact `Origin` and JSON-only bodies), exact-origin checks on WebSocket
  upgrades, and Host checks against DNS rebinding.
- A strict Content-Security-Policy and related headers. Markdown is rendered
  without raw HTML and passed through DOMPurify; remote images become plain
  links.
- Approval cards that can't be disguised: full commands, invisible characters
  and padding made visible, long commands expanded before Allow unlocks,
  deny-only when a command is too long to send, a ¾ s tap guard on new cards,
  and server-side checks that every answer was really offered. Nothing is
  answered automatically.
- Hermes password and secret prompts are answered from the web only with
  `hermes.secretPrompts` on; otherwise they get a notice. The server checks
  each answer against a card still waiting in that chat, and a sudo password
  can't be sent for a command too long to show. The answer goes only to
  Hermes and nothing keeps it: it isn't logged, stored, added to the timeline
  or the card, or sent to other devices, and no error repeats it, not even an
  error from Hermes.
- Hermes "/" commands that turn approvals off, answer them away from their
  card, or upload your logs (`/yolo`, `/approvals <mode>`, `/approve`, the
  memory and skill approval gates, `/debug`) are refused by the server.
- Attachments are checked before any agent sees them: the type comes from the
  bytes (PNG, JPEG, GIF, WebP, PDF or UTF-8 text only), with limits on count
  and size and cleaned-up names. Files always travel as bytes, never as a path
  for an agent to read.
- Paseo modes that turn every safeguard off are never offered and are rejected
  by the server. Modes that act on their own need explicit consent, also
  checked by the server, both at launch and when you switch an agent's mode.
- Images from your machine are shown only through links the server signs per
  conversation, with a key that changes at every start. System folders,
  credential folders and the Hermes and Paseo stores (apart from their image
  and upload folders) are never read, and only real PNG, JPEG, GIF or WebP
  images up to 20 MB are served, under a `sandbox` Content-Security-Policy.
- The project bridge listens on `127.0.0.1` only, never through the tunnel,
  and takes only its bearer token (32 random bytes, compared in constant time,
  never logged). It refuses browsers (any `Origin`, a foreign `Host`) and
  anything but JSON up to 64 KB. It offers no way to reach approvals, modes or
  models, refuses "/" commands, and never interrupts a working chat. A caller's
  Paseo agent id or Hermes session id counts only if it matches a chat
  Signalbox lists, and the bridge passes a Hermes session id on only when
  Hermes started it.
- Live WebSockets close when the Access token expires and re-authenticate
  through Cloudflare every 30 minutes.
- Fail-closed configuration: loopback-only listen, Hermes (`http(s)://`) and
  Paseo (`ws(s)://`) addresses, an HTTPS public origin, a
  `*.cloudflareaccess.com` issuer, unknown keys refused at any level, and no
  option to turn authentication off.
- The service runs as a systemd `DynamicUser` with no access to `/home`,
  `ProtectSystem=strict` and a syscall allow-list. The tunnel credential is
  passed to cloudflared with `LoadCredential`. The installer only builds root-
  owned code with a root-owned `node` and `npm`, and the tunnel setup only runs
  a root-owned `cloudflared`.
- The Hermes password is stored only on the host (mode 600). Hermes' session
  tokens stay in memory, so Signalbox signs in with the password when the
  service starts and when you save it in Settings. After that it's re-sent only
  when Hermes explicitly reports an expired session, never on connection
  errors.
- Supply chain: exact dependency versions, a lockfile, npm install scripts
  disabled, and `npm audit` in CI. The CI workflow can only read the
  repository, its GitHub Actions are pinned to commit SHAs, checkouts don't
  keep their credentials, and every job has a timeout.
- An independent adversarial review covered the whole codebase before this
  release. Its findings and fixes are listed in [SECURITY.md](SECURITY.md).

[Unreleased]: https://github.com/vankoala/signalbox/commits/main
