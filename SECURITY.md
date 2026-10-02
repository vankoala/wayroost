# Security

Signalbox lets you drive coding agents on your machine from anywhere. Those
agents can run commands, so anyone who gets control of Signalbox effectively has
a shell on your machine. Every design decision starts from that fact, and no
single layer is trusted on its own.

## Reporting a vulnerability

Please report privately through GitHub's **Report a vulnerability** (Security →
Advisories) on this repository, not in a public issue. Include steps to
reproduce and the version or commit.

## Threat model

| Attacker | Examples |
| --- | --- |
| Anyone on the internet | Scanning your hostname, replaying or forging tokens. |
| A website you visit while signed in | CSRF, cross-site WebSocket hijacking, DNS rebinding against `127.0.0.1:8790`. |
| Hostile agent output | Prompt injection that makes an agent print HTML or scripts, tracking images, a command that hides its real payload, or a path meant to pull a private file onto your screen. |
| Other local processes | A process that reaches the app port directly, or squats on the Hermes port. |
| Agents on your machine | With the project bridge on: an agent, or a prompt injection in one, pushing other agents around, looping messages, or starting runaway chats. |
| Misconfiguration | A wrong tunnel route, a missing Access policy, an unsafe config value. |

## Layers

**1. Cloudflare Access (edge).** Only the emails in your Access policy get
through. Everyone else is stopped at Cloudflare and never reaches your machine.

**2. cloudflared.** The tunnel is configured with `access.required`, so
cloudflared independently rejects requests without a valid token for your
application.

**3. Signalbox verifies the token itself.** On every WebSocket upgrade and
every HTTP request, apart from the one exception below, it checks the
`Cf-Access-Jwt-Assertion` token:

- RS256 signature against your team's published keys;
- exact issuer and audience (your application's AUD tag);
- expiry, with 30 s of clock skew;
- email on your allowlist, compared as plain ASCII so Unicode look-alikes can't match;
- service tokens, which have no email, are rejected.

Any failure is a 401 or 403, and fetching keys can't be forced more than once
every 30 s.

One exception: a `GET` for one of six files a browser fetches when you add the
app to your home screen skips this check. They are `/manifest.webmanifest`,
`/favicon.svg`, `/apple-touch-icon.png`, `/icons/icon-192.png`,
`/icons/icon-512.png` and `/icons/maskable-512.png`. They hold nothing
sensitive, they still get the Host check, and layers 1 and 2 still guard them.

**4. Browser protections.**

- **API calls** need a custom header, `Sec-Fetch-Site: same-origin` (when the
  browser sends it), an exact `Origin` match for anything that changes state,
  and `Content-Type: application/json`. Requests are classified by the route
  that matched, so percent-encoded paths can't skip these checks. No CORS is
  enabled.
- **WebSocket upgrades** must come from your exact origin.
- **Host** must be your hostname or the local listen address, which blocks DNS
  rebinding.
- **Response headers:**
  - `Content-Security-Policy`: `default-src 'none'`, `script-src 'self'` with
    no inline scripts, no inline styles, and `img-src 'self' data: blob:` so
    output can't load remote images;
  - `frame-ancestors 'none'`, `X-Frame-Options: DENY`;
  - `nosniff`, `Referrer-Policy: no-referrer`;
  - same-origin `COOP`/`CORP`, HSTS, and a restrictive `Permissions-Policy`.

**5. Agent output is treated as hostile.** Markdown is rendered with raw HTML
disabled, then passed through DOMPurify:

- only `http`, `https` and `mailto` links survive;
- links open with `noopener noreferrer nofollow` and show their destination;
- remote images become plain links, so they can't beacon data out;
- forms, SVG, iframes and style attributes are removed.

The test suite feeds known XSS payloads through this pipeline. Images from your
own machine are handled separately, under layer 9.

**6. Approvals can't be disguised or auto-answered.**

- **Nothing is approved automatically.**
- **Answers are checked server-side** against the exact options offered for
  that request, in that conversation. Replays and unknown options are rejected.
- **Commands are shown in full.** Invisible and direction-changing Unicode is
  shown as `⟨U+202E⟩`, and blank-line or whitespace padding collapses into a
  visible note, so a payload can't hide below the fold.
- **Long commands** must be expanded before Allow unlocks. A command too long
  to send can only be denied from the phone.
- **A new approval card** ignores taps for ¾ s, so a double-tap can't approve
  the next request.
- **Hermes password and secret prompts** (a sudo password, a secret a skill
  needs, a password manager's master password, a 2FA code, or a site login to
  save) only get a notice saying to answer them on your PC, unless you turn on
  `hermes.secretPrompts`. With it on, they become cards you answer on the
  phone: sudo asks for a second tap after showing the command, and a login
  card shows the exact site it's for. The server checks the answer like any
  other, for that request in that chat, sends it only to Hermes and keeps no
  copy. It isn't logged, saved, added to the timeline or sent to your other
  devices, and an error never repeats it. It does pass through Cloudflare:
  see [Known limits](#known-limits).

**7. Agents can't be launched without their safeguards.** Paseo modes are
classified per provider:

- **Modes that ask you** are offered normally.
- **Modes that act on their own**, and agents with no approval step (like Pi),
  need an explicit "I understand" that the server also checks.
- **Modes that turn every safeguard off** (Bypass, Full Access, Allow All,
  Don't Ask, yolo) are never offered and are rejected.

Signalbox always sends an explicit mode and never relies on the daemon's
default. Hermes agents run with Paseo's auto-accept switched off, and Signalbox
never changes an agent's feature switches afterwards. Switching an existing
agent's mode
follows the same tiers: blocked modes are hidden and refused, and modes that act
on their own need the same explicit OK, checked by the server.

The same rule covers Hermes "/" commands. `/yolo`, `/approvals <mode>`,
`/approve`, and the memory and skill approval-gate switches are refused by the
server, because they turn approvals off or answer them away from the approval
card. `/debug` is refused too, because it uploads logs to a shareable link. An
alias is checked again after it's resolved. Other commands run with the same
power they have in the Hermes apps, including quick commands you defined
yourself.

**8. Attachments are checked before any agent sees them.**

- The file type comes from the bytes, not the name or the claimed type. Only
  PNG, JPEG, GIF, WebP, PDF and UTF-8 text are accepted, so an SVG or HTML file
  can't pose as an image. Besides those, a short list of Office documents,
  archives and data files is accepted when the bytes carry that format's
  signature *and* the name has one of its extensions (`shared/documents.ts`), so
  an executable renamed `.xlsx` is still refused. Agents get those as a saved
  file to open with their own tools, never inline. Signalbox doesn't look inside
  them: a zip or a macro-enabled workbook reaches the agent as it is.
- At most 4 files per message, 10 MB each.
- Names lose any directories and control characters.
- Files are always sent as bytes. Signalbox never passes an agent a path to read
  on your machine.
- Hermes gets files only while no reply is running, so a running turn can't
  pick them up.
- Only names and types come back to the browser, never the file contents.

**9. Images from your machine are shown only when an agent points at them.**

- **The browser never sends a path.** The server turns each image an agent
  names in a reply or tool call into a link signed with HMAC-SHA256 for that
  conversation and path, using a key made fresh at every start. Anything else,
  or a link from another conversation or an earlier run, is refused.
- **Some places are never read**, whatever an agent says: system folders
  (`/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/var/log`, `/var/lib`,
  `/var/run`, `/run`), credential folders (`.ssh`, `.aws`, `.gnupg`, `.kube`,
  `.docker`, `.config`, `.azure`, `.gcloud`, `Keychains`), and the Hermes and
  Paseo stores except their image and upload folders. This is checked when a
  link is made and again when it's used.
- **Signalbox can't read your files itself.** The Hermes dashboard (which
  applies its own rules for sensitive files) or Paseo reads each image for it.
- **Only real images are served:** PNG, JPEG, GIF or WebP by their first bytes,
  at most 20 MB, with a `sandbox` Content-Security-Policy on the response.
- **The phone** fetches only links shaped like the signed ones, with the API
  headers, shows them as `blob:` URLs, and keeps at most 30 in memory.

**10. Sessions expire.** Live WebSockets close when the Access token expires, and
re-authenticate through Cloudflare every 30 minutes, so signing out or revoking
access takes effect quickly.

**11. Fail-closed configuration.** Startup refuses:

- a non-loopback listen address;
- a plain-http public origin, or one with a path;
- an issuer outside `*.cloudflareaccess.com`;
- Hermes or Paseo addresses that aren't loopback, or use the wrong scheme
  (Hermes `http://` or `https://`, Paseo `ws://` or `wss://`);
- a relative state directory;
- unknown keys, at any level.

A local issuer (for tests) needs an explicit environment flag that the service
never sets. There is no switch to disable authentication.

**12. Least privilege on the host.**

- **Sandboxed service:** Signalbox runs under a systemd `DynamicUser`:
  - no home, and no access to `/home`;
  - `ProtectSystem=strict`, no capabilities, `NoNewPrivileges`;
  - a syscall allow-list, and only IPv4, IPv6 and Unix sockets.
- **Root-only code:** the installed code is root-owned and read-only to the
  service.
- **Tunnel credential:** cloudflared runs as its own dynamic user, and receives
  the credential through systemd's `LoadCredential`.
- **Tamper-proof builds:** the installer refuses to build from a directory that
  anyone but root could modify, including through a parent directory, so an
  agent running as your user can't swap the code that root builds. It also
  refuses `node` and `npm` binaries that anyone but root could modify, checking
  every directory and symlink on the way to them. The tunnel setup script
  applies the same checks to the checkout and to `cloudflared`. Both scripts use
  root's own home and settings, even when `sudo` keeps yours.

**13. Secrets stay on the host.** Your Hermes password is checked with Hermes
before it's saved. It is stored only in the service's private state directory
(file mode 600) and never sent back to the browser or logged. Signalbox keeps
Hermes' session tokens in memory only, so it signs in with the saved password
when the service starts and when you save the password in Settings. After that,
it re-sends the password only when Hermes explicitly reports an expired
session, never on connection errors.

**14. Supply chain.**

- **Few dependencies:** exact versions, a lockfile, and npm install scripts
  disabled.
- **Audits:** `npm audit` runs in CI.
- **Locked-down CI:** the workflow can only read the repository, GitHub
  Actions are pinned to the commit SHAs of current releases, checkouts don't
  keep their credentials, and every job has a timeout.
- **No secrets in git:** the `.gitignore` keeps local configs, tunnel
  credentials and saved sign-ins out of commits.

## The project bridge

The [project bridge](docs/bridge.md) lets agents in one project list, read,
message and start each other's chats, and wait for each other's answers. It's
off unless you turn it on (`"bridge": { "enabled": true }`). When it's on:

- **Loopback only.** Its listener binds to `127.0.0.1` on its own port (8792 by
  default). The tunnel only routes the web app's port, so the bridge can't be
  reached from the internet, and Cloudflare Access plays no part in it.
- **A bearer token is the only credential.** Signalbox makes it from 32 random
  bytes on the first start with the bridge on, keeps it in its state directory
  (mode 600) and compares it in constant time. `setup-bridge.sh` copies it to
  the agents' user as `~/.config/signalbox/bridge-token` (mode 600). It's never
  logged.
- **Browsers are refused.** A request that carries an `Origin` header is
  refused, the `Host` must be the bridge's own loopback address (which blocks
  DNS rebinding), there's no CORS, and only JSON bodies up to 64 KB are taken.
- **No approval, mode or model surface.** The five tools list, read, message
  and start chats, and wait for an answer. Nothing lists, answers or changes
  approvals (password prompts included), permission modes or models, or
  interrupts a chat. Text starting with `/` is refused, so agents can't run
  each other's commands. New Paseo agents start only in modes that ask you.
  Every message arrives labelled as coming from another agent, not from you.
- **Guards against runaway agents:** rate limits, a loop breaker, caps on the
  chats agents start, delivery only to idle chats with no approvals waiting,
  waits of at most 120 seconds (one per chat), and a Pause switch in Settings
  that refuses every tool call and ends every wait at once. (For you's card
  routes on the same listener aren't paused: a card never reaches a chat by
  itself.)
- **The agents' side** sends the token only to an `http://` address on this
  machine, and never through a proxy.
- **The Hermes plugin** (`signalbox-identity`, which `setup-bridge.sh`
  installs and enables unless you pass `--no-hermes-plugin`) runs inside
  Hermes on every tool call. It only adds the calling chat's session id to
  Signalbox's own `mcp__signalbox__*` calls, never raises (Hermes blocks a
  call whose hook fails), and does nothing in a Hermes that Paseo runs. The
  agents' side passes the id on only when Hermes started it.
- **Logs** record each call's tool, caller, target and outcome, never the
  message, a title, a folder or the token.

Its limits, honestly:

- **Every agent runs as the same OS user.** Anything running as that user can
  read the token copy and call the bridge. The bridge can't tell your agents
  apart from any other process of yours.
- **Identity headers are claims, not proof.** A Paseo agent id or Hermes
  session id counts only if it matches a chat Signalbox lists, but a caller
  with the token could claim any of them, or any folder. The claim decides how
  messages are signed, the reply address they carry, which project the caller
  lands in, and whose answers `wait_for_reply` returns: a caller posing as a
  chat could take an answer meant for it, or end its wait. The Hermes plugin
  overwrites any session id a model puts in its hidden argument; without the
  plugin, a Hermes model could pass one itself.
- **It isn't a sandbox.** Your agents can already do whatever your user can.
  The bridge makes accidents and loops unlikely and keeps risky actions behind
  your approvals, nothing more.
- **Labels don't stop persuasion.** A prompt-injected agent can still send
  convincing text to another agent. Each agent's own approvals remain the
  safety net.

## Voice mode

[Voice mode](docs/voice.md) is off unless `deploy/setup-speech.sh` turns it on.
When it's on:

- **The microphone policy opens only for this page.** `Permissions-Policy` goes
  from `microphone=()` to `microphone=(self)`; the browser still asks you.
- **Audio rides the existing, authenticated WebSocket.** Binary frames are only
  accepted on a socket that passed every check above, and only for a recording
  that socket started. A recording is capped at 2 minutes and dropped if its
  audio stops for 10 seconds; at most two can wait to be written down. The
  text goes back to that socket alone.
- **Reading aloud is an ordinary API call** (`POST /api/voice/speak`) under the
  same Access, CSRF and Host rules, with at most 1,000 characters per call and 4
  calls at once.
- **The speech service can't reach anything.** It has no network
  (`PrivateNetwork=yes`, `IPAddressDeny=any`, Unix sockets only) and runs as a
  `DynamicUser`. It parses text agents wrote (espeak-ng and ONNX Runtime read
  every reply), so its view of the system is an empty `RootDirectory` with
  only `/usr`, the libraries, its program and its models bind-mounted
  read-only: no `/etc` (apart from the loader's cache), home directories,
  `/var`, `/run` (no other sockets), `/usr/local` or Windows drives. Its socket
  is created by systemd (so nothing can take its place) and handed over open,
  with mode 660, group `signalbox-voice`, which only Signalbox joins. Requests
  carry audio or text, never paths.
- **Its supply chain is root's.** The program, a venv of hash-pinned wheels, and
  models checked against the publishers' SHA-256 all live in root-owned
  directories, so an agent running as your user can't change what turns your
  voice into text, or put words in your mouth.
- **Nothing is stored or logged.** Neither Signalbox nor the speech service
  writes audio or text anywhere.
- **Speaking is typing.** A transcript is put in the message box (or sent, if
  you chose that) like typed text: no approvals, settings or commands by voice.

## For you and phone notifications

[For you](docs/for-you.md) is off unless `feed.enabled` is set. When it's on:

- **Cards are untrusted text.** Hermes writes them from your mail and calendar,
  so an email can try to steer one. Each field is one line of plain text with a
  length cap: control and invisible characters are removed, links become
  `[link]`, and the app renders cards as text, never Markdown or HTML. Hidden
  characters go too: zero-width and direction controls, invisible fillers and
  Unicode tag characters, which no screen shows but a model would read, so
  **Do it** can't send words you didn't see. The key is a label plus an id (a
  Gmail or calendar id that **Do it** passes on), from a narrow character set
  without spaces. Unknown fields are dropped and unknown kinds refused.
- **Nothing on a card acts by itself.** **Do it** shows the exact request and
  waits for **Send to Hermes**. It then starts an ordinary Hermes chat, which
  tells Hermes to check with you before sending or changing anything, and all
  of Hermes' approvals still apply. **Not now**, **Less like this**, **Done** and
  dismissing only change the card and your preferences.
- **Posting cards takes the bridge token.** The two `/pulse/v1` routes live on
  the bridge's loopback listener, behind its token, Host and no-browser checks,
  and take at most 20 cards per call. Agents aren't offered them as tools, but
  any process with the token (every agent running as your user can read
  `~/.config/signalbox/bridge-token`) can post a card and choose its "from"
  label. That's why **Do it** shows the request before anything happens.
- **The proactivity level only touches the pulse jobs.** Settings changes go
  through the usual API checks and only pause, resume or reschedule the two
  Hermes jobs named `pulse-morning-brief` and `pulse-scout`, through the same
  dashboard calls as Settings → Scheduled jobs.
- **Notifications say little and are encrypted.** An approval notification
  names the agent and the request's short title, never the command, its
  arguments or output. Card notifications are opt-in and carry the card's title.
  Every payload is encrypted for the browser (RFC 8291), and requests are
  signed with Signalbox's own VAPID key (RFC 8292). The push service sees only
  ciphertext, its size and timing. Signalbox sends only over HTTPS to the
  push services of Chrome, Firefox, Safari and Edge, never to an address a
  browser simply claims. Quiet hours hold card notifications back.
- **Subscriptions are added through the API.** A device subscribes under the
  same Access, CSRF and Host rules as every other call. At most 10 are kept, and
  ones the push service reports gone are dropped. The VAPID key pair and
  subscriptions are in `push.json` (600) in the state folder. The VAPID
  contact is your `publicOrigin`, not your email.
- **The service worker only shows notifications.** `/sw.js` displays what was
  pushed and opens a Signalbox page (a same-site path only) when you tap it. It
  has no fetch handler, so it can't cache, change or see requests.

## Scheduled jobs and mail triggers

- **Unattended runs get the least by default.** Hermes runs cron jobs while you're away and
  approves their tool calls by itself. So every job or mail trigger Signalbox creates carries
  an explicit `enabled_toolsets`, starting at "Nothing" (`todo, no_mcp`). Web search, web plus
  flights & maps, and Everything are opt-in, and Everything comes with a warning.
- **Mail stays data.** A mail trigger at any level below Everything can't open the message, so a
  crafted email can't steer it into the inbox or anything else. Only the details the gate
  script passes in reach the model.
- **Edits are partial.** A schedule or name change never rewrites a job's tools, and the For-you
  level changes only the pulse jobs' schedules.
- **What Signalbox can't see.** A job with no list falls back to Hermes'
  `platform_toolsets.cron`. Signalbox shows it as "Hermes decides" with a warning.

## Known limits

- **Cloudflare sees your traffic.** Cloudflare terminates TLS at its edge, so
  your traffic is visible to Cloudflare (unlike, say, Paseo's end-to-end
  encrypted relay).
- **Your email account is the key.** Whoever controls your Access identity
  (your email or identity provider) can sign in. Use 2FA there, and keep the
  Access session duration at 24 hours, as in the setup guide, or shorter.
- **Hermes password storage.** The Hermes dashboard only supports password
  sign-in, so Signalbox stores the password. It signs in with it every time the
  service starts, when you save it in Settings, and when Hermes reports an
  expired session, for example after Hermes restarts with a new signing secret.
  A process squatting on the Hermes port at one of those moments, such as when
  Signalbox starts while Hermes is down, could capture it. Limiting when it's
  sent narrows this but doesn't eliminate it.
- **Passwords you answer from the phone pass through Cloudflare.** With
  `hermes.secretPrompts` on, the sudo password, secret, master password, code
  or login you type travels through the tunnel. TLS ends at Cloudflare's edge,
  so Cloudflare can see it in transit, like everything else you send.
  Signalbox doesn't keep it, but Hermes does what it always does with it: it
  remembers a sudo password for the rest of that chat and runs the command as
  root, saves a secret to its `.env` file, and keeps a login's password
  encrypted in its vault and signs in with it (the agent sees the username, not
  the password). The prompt's wording, the command and the site come from the
  agent and its skills, so a prompt-injected agent can ask convincingly, for
  example to save your login on a look-alike site. Answer only prompts you
  expect, read the command before sending a sudo password, and check the site
  before saving a login. The switch is off by default; leave it off if you'd
  rather type these only on your PC.
- **Links can carry data out.** A link in agent output can carry data if you tap
  it. Check where it goes first; hovering or long-pressing shows the address.
- **Agents can show you images from your disk.** Outside the refused folders,
  any image that Hermes or Paseo will read for an agent can appear on your
  phone, and pass through Cloudflare, when the agent names it. A
  prompt-injected agent could use that to show you a picture you didn't expect.
- **Your own quick commands run as written.** A Hermes quick command that
  aliases a blocked command, or runs a shell command, does what your Hermes
  config says, just as it would in the Hermes apps.
- **Approvals are the last line of defence.** Signalbox gives agents the same
  power they have locally. Read what you approve.

## Review history

Before the first release, an independent adversarial review covered the whole
codebase. Its findings and fixes:

| Finding | Fix |
| --- | --- |
| Percent-encoded paths (`/%61pi/...`) reached API routes without the CSRF checks | Checks classify by the matched route; every non-GET request gets the API rules |
| Some Paseo modes could run without human approval (Copilot `allow-all`, Claude `auto`, Pi with no modes) | Per-provider mode tiers, explicit consent for modes that act on their own, blocked modes rejected, explicit mode always sent |
| Approval cards could hide a payload past the visible area or the 4,000-character cut | Full commands, visible invisible characters, collapsed padding, expand-to-approve, deny-only when too long |
| A new approval card could take a tap meant for the previous one | New cards ignore taps for ¾ s |
| Open sockets outlived Access sign-out | 30-minute re-authentication cycle |
| The config accepted a local Access issuer in production | Allowed only with an explicit test-only flag |
| Unicode look-alike emails matched the allowlist | ASCII-only comparison |
| `.`/`..` ids reached Hermes REST paths | Ids must start with a letter or digit |
| Failed final answer to a multi-question request left it unanswerable | Card kept until Paseo confirms, rebuilt after reconnect |
| The installer ran code as root from a user-writable directory | Root-only source location, enforced by the installer |
| The Hermes password could be sent to a port squatter during outages | Re-sent only on an explicit expired-session reply, never on connection errors |
| A Hermes approval answered during a reconnect could be lost | Answers only go to the connection the request arrived on |
