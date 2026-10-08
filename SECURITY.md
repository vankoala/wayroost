# Security

Wayroost lets you drive coding agents on your machine from anywhere. Those
agents can run commands, so anyone who gets control of Wayroost effectively has
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
| A website you visit while signed in | CSRF, cross-site WebSocket hijacking, DNS rebinding against `127.0.0.1:19010`. |
| Hostile agent output | Prompt injection that makes an agent print HTML or scripts, tracking images, a command that hides its real payload, or a path meant to pull a private file onto your screen. |
| Other local processes | A process that reaches the app port directly, or squats on the Hermes port. |
| A stolen or lost device | A phone that was paired and is now in someone else's hands. |
| Agents on your machine | With the project bridge on: an agent, or a prompt injection in one, pushing other agents around, looping messages, or starting runaway chats. |
| Misconfiguration | A wrong tunnel route, a missing Access policy, an unsafe config value. |

## Authenticated desktop loopback listeners

Installed Wayroost uses HTTPS/WSS on the main listener `127.0.0.1:8881` for
the tunnel and phones, and the local listener `127.0.0.1:8883` for the desktop.
Supervisor rescue uses HTTPS on `127.0.0.1:8880`. The tunnel targets only 8881;
the local listener alone can allow PC-only writes after its live check. Each
installer creates an independent self-signed ECDSA P-256 certificate, valid for ten years, with SANs `127.0.0.1` and
`localhost`. Private keys remain root:root, 0600; systemd `LoadCredential`
provides private copies to the services, including the server's DynamicUser.
Private keys are never printed or logged. Public fingerprints are SHA-256 over
the certificate's DER SubjectPublicKeyInfo, written as `sha256/<base64>`.

Run `sudo wayroost pair-desktop` on the PC. Paste its combined token into the
bundled desktop recovery form. It carries the single-use code, local port and
both pins. The main and local listeners share the server certificate; pairing
pins the local listener before sending credentials.
The desktop checks the pasted server pin during TLS before sending the code,
then verifies the paired identity before saving the pins with Electron
`safeStorage`. The rescue key is separately checked using the supervisor pin
and encrypted. First rescue setup can save a key and its explicitly supplied
pin while the server is down; it does not infer a server pin.

The app and rescue sessions reject unknown certificates. App requests are
restricted to the pinned origin and its WSS origin, preventing redirects,
HTTP downgrades and different ports from carrying cookies or headers.
Electron's verifier protects page loads, renderer HTTP/WebSocket and native
`session.fetch`/`net.WebSocket`. The native rescue and enrollment clients inspect
the peer SPKI, hostname and certificate dates on each socket before writing any
HTTP bytes. A mismatch displays “This is not your Wayroost server” and sends no
cookie, pairing code, desktop marker or bearer key. No trust on first use is used.
Pin changes restart the desktop so Chromium cannot reuse cached trust decisions.

For upgrades without `localListener`, re-run the server installer as root. It adds
the local listener on 8883 and its allowed HTTPS origin without overwriting an
existing listener or enabling `pcOnlyWrites`. Older saved pins without a port use
8883. Once that listener is running, pair again with a fresh token to save its
port and TLS pin. Keep `pcOnlyWrites: false` until the live desktop check passes;
see [settings rollout](docs/settings-rollout.md#desktop-listener).

Root can explicitly rotate either certificate:

```sh
sudo wayroost rotate-tls server
sudo wayroost rotate-tls supervisor
sudo wayroost pair-desktop
```

For rescue setup while the server is down, run `sudo wayroost fingerprints`.
It reads the root-installed public certificate files without contacting either
listener. Save the supervisor fingerprint with the install-time rescue key.
Never take a fingerprint from the live listener: it could belong to an impostor.

Rotation generates a new key and restarts only the selected Wayroost service.
The desktop rejects the new certificate until a fresh single-use pairing token
is entered; changing a saved rescue pin also requires that token. Reinstallation
retains certificates and refuses incomplete pairs. HTTP is available only in
explicit development mode (`npm run desktop:dev`, dev server configs), never
in the installed Wayroost configs.

After suspected key compromise, certificate rotation alone does not retire
credentials captured under the old key. After server rotation and re-pairing,
revoke every old desktop device in Settings → Devices & access → Devices.
After supervisor rotation, root must replace the `desktop-rescue` SHA-256
entry in `/etc/wayroost/supervisor-keys.json` with the hash of a newly generated
256-bit rescue key, preserving the separate server entry. Restart the supervisor
and save the new rescue key with the fresh pairing token in the desktop form.
Generate and display that key only in a private root terminal, never in logs.

Development uses a separate `wayroost-desktop-dev` directory for user data,
encryption state and session cookies before taking the single-instance lock.
It never opens installed credentials. The existing primary deployment behind
cloudflared keeps its HTTP backend until cutover; its development flag stays off.

Normal browsers cannot pin certificates. The browser path on the PC relies on
its device cookie and normal HTTPS validation; use the public tunnel/tailnet
origin rather than loopback, where browser sign-in remains disabled. The desktop
app is the hardened path against a local process impersonating a stopped
listener. Phones still use the Cloudflare tunnel and their device cookie. At
Wayroost cutover, configure cloudflared's backend as HTTPS with the server
certificate as its origin CA; do not disable origin certificate verification.

`desktop/src/tls-check.ts` runs in Windows CI against invented keys and asserts
zero decrypted HTTP bytes and zero upgrades for mismatches across all Electron
transports, including rotation on the same origin. Linux tests cover native
socket pinning, TLS listeners, generation, permissions and installer plans.

## Layers

**1. Cloudflare Access (edge).** Only the emails in your Access policy get
through. Everyone else is stopped at Cloudflare and never reaches your machine.

**2. cloudflared.** The tunnel is configured with `access.required`, so
cloudflared independently rejects requests without a valid token for your
application.

Layers 1 to 3 apply when Cloudflare Access is configured (`access` in the
config), and only to requests through a public origin. Every request, local or
public, also needs a paired device: see [Device sign-in](#device-sign-in-pairing).

**3. Wayroost verifies the token itself.** On every WebSocket upgrade and
every HTTP request through a public origin, apart from the one exception below, it checks the
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

- **API calls** need a custom header (`x-wayroost-request: 1`, or the legacy
  `x-signalbox-request: 1` during M1), `Sec-Fetch-Site: same-origin` (when the
  browser sends it), an exact `Origin` match for anything that changes state,
  and `Content-Type: application/json`. Requests are classified by the route
  that matched, so percent-encoded paths can't skip these checks. No CORS is
  enabled.
- **WebSocket upgrades** must come from your exact origin.
- **Several origins, each checked on its own.** The config's `origins` list
  (the tunnel, a tailnet name, the PC's own `http://127.0.0.1:<port>`) sets
  which `Host` values are accepted, which blocks DNS rebinding. A request's
  `Origin` must be the origin its own `Host` belongs to, so a page on one
  origin can't drive another. A local origin that arrives carrying
  Cloudflare's `Cf-Ray` or `Cf-Connecting-Ip` header came through the tunnel
  with a forged `Host`, and is refused.
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

Wayroost always sends an explicit mode and never relies on the daemon's
default. Hermes agents run with Paseo's auto-accept switched off, and Wayroost
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
  file to open with their own tools, never inline. Wayroost doesn't look inside
  them: a zip or a macro-enabled workbook reaches the agent as it is.
- At most 4 files per message, 10 MB each.
- Names lose any directories and control characters.
- Files are always sent as bytes. Wayroost never passes an agent a path to read
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
- **Wayroost can't read your files itself.** The Hermes dashboard (which
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

- **Sandboxed service:** Wayroost runs under a systemd `DynamicUser`:
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
(file mode 600) and never sent back to the browser or logged. Wayroost keeps
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

## Device sign-in (pairing)

Every browser, phone and the desktop app signs in as a **paired device**. There
is no unauthenticated mode: the server refuses to start unless device sign-in or
Cloudflare Access is on, and device sign-in is on unless the config turns it off.

| Request through | Needs |
| --- | --- |
| A public origin (tunnel, tailnet, relay), Access configured | A valid Access token **and** a paired device |
| A public origin, no Access | A paired device |
| A local origin (a loopback host such as `http://127.0.0.1:<port>` listed in `origins`; `https://` too) | A paired device, and only the desktop app's requests (see below) |

**The device cookie.** Pairing sets `wr_device=<id>.<secret>`: `HttpOnly`,
`SameSite=Strict`, `Path=/`, `Max-Age` 400 days (renewed on use, at most
hourly), and `Secure` everywhere except a plain-http loopback origin, where
browsers would drop it. The secret is 256 random bits. The server keeps only
its SHA-256 hash, in `<stateDir>/devices.json` (mode 600, written to a temp file
and renamed into place), and compares hashes in constant time, with the same
work for an unknown device id. A damaged store stops the server rather than
being replaced by an empty one. A cookie that no longer matches gets a 401
(`unpaired`) and is cleared, but only when it was the one `wr_device` cookie
sent and has the shape of ours: several, or a malformed one, may come from
another site on the same host with a narrower `Path`, and a `Path=/` clear
would sign out the real one.

**Only the desktop app signs in on a local origin.** Browsers scope cookies by
host, not port, and `SameSite` treats every port of `127.0.0.1` as one site,
so a device cookie a browser held on `http://127.0.0.1:<port>` would be sent to
any other web server on `127.0.0.1` it opened, such as one an agent starts and
links to in a chat; that server would get a desktop's full rights. So on a
local origin the server pairs and signs in only requests carrying
`x-wayroost-app: desktop`, which the desktop app adds to every request and a
browser never sends. A browser there is refused at pairing, and any
`wr_device` cookie it presents is ignored (not cleared: it may belong to
another port). The header is not a secret and not the protection itself: what
matters is that our own web app, in a browser, never takes a cookie on a local
origin: it never sends the header. Other sites can't send it either, since a
custom header needs a CORS grant the server never gives and the `Origin` check
refuses them. It does not prove the client is the desktop app: script running on
our own origin, a browser extension or someone typing in the developer tools
could send it, but each of those already controls the session and still needs a
pairing code. The desktop app keeps its cookie in its own storage, and its
window navigates only to its own origin, so the cookie never goes to another
port. Local is decided by the host, not the scheme: an `https://` loopback
origin gets the same rule, because `Secure` doesn't scope a cookie to a port
(and browsers send `Secure` cookies to `http://localhost` too). Every
spelling of the PC counts as local: all of `127.0.0.0/8`, `::1` and its
IPv4-mapped forms, `localhost.`, `*.localhost`, `0.0.0.0` and `[::]`.
`publicOrigin` can never be one of them. Recovery prints pairing
links for `https://` origins only.

**Pairing codes** are 128 random bits in base32, single use (used up by any
attempt, right or wrong), valid for 10 minutes, held in memory only and only as
hashes. A paired desktop asks for one in Settings → Devices, which shows it as a
QR code of `<origin>/pair#<code>`, drawn in the page (no outside QR service).
The code rides in the URL fragment, which browsers never send to a server, and
the pairing page takes it out of the address bar as soon as it has drawn (each
new pairing link opened in the same tab too) and posts it only when you tap
Pair. A phone's code can't make a desktop.

**Limits.** 10 pairing attempts a minute. After 20 failures in an hour pairing
locks, even for valid codes, until a paired desktop unlocks it or root asks for
a recovery code. The lock survives a restart.

**Recovery.** `pair-code` (`scripts/pair-code.ts`, installed as
`dist/server/pair-code.js`; `sudo wayroost pair` or `sudo wayroost pair-desktop` where `install-wayroost-server.sh` installed it) asks the running server
for a code over a Unix socket, `<stateDir>/pairing/pair.sock`. The folder is
mode 700 and the socket mode 600, both owned by the service user, inside
systemd's private state directory, so only that user and root can connect;
agents, which run as your own user, can't. The socket takes one line (the device
kind) and answers with one code; it has no other verb and no network listener.
A recovery code also lifts a pairing lock.

**What each kind may do.** A desktop can do everything, including offering
codes, unlocking pairing and renaming or revoking any device. A phone can rename
or revoke only itself; the power and "PC only" settings routes ask
`deviceKind(request)` and treat a phone (or a request with no device) as the
more careful kind.

**Revoking** a device deletes it, so its cookie stops working at once, voids
the pairing codes it asked for (each code remembers the device that offered it,
so a revoked desktop can't come back through a code it took beforehand), and
closes its open WebSockets with close code 4403. Every other socket is still
recycled every 30 minutes, which re-runs every check. A change (any POST, PUT,
PATCH or DELETE) is checked twice: when it arrives, and again against the live
device store after its body has arrived, right before the handler runs. A device
revoked while its request was still uploading changes nothing (403). The only
change exempt from that second check is redeeming a pairing code
(`LIVE_DEVICE_EXEMPT` in `server/src/app.ts`); a test enumerates every mutating
route in the app's route table and holds it to the check or to that list.

**Logs** name a device by id and kind only. Codes, secrets and cookies never
appear, which the tests check by capturing the logs of a full pairing,
refusals, a revoke and a recovery.

**Pages without a device.** The app shell and its files, the pairing call
(`POST /api/pair`, still under the API rules above), and a connector's sign-in
callback (`/connect/callback/<name>`) work without a device. The shell is static
and makes no API call that succeeds without one. The callback is a cross-site
redirect from the service's own sign-in page, so the `SameSite=Strict` cookie
doesn't come with it, and without Access anyone who can reach the origin can
call it. So the server forwards it to Hermes only while a sign-in that a
signed-in device started for that connector is open: for 10 minutes after
Connect, at most 3 times, and closed by success or Cancel. When the service's
sign-in address carries an OAuth `state` (the usual case), only a callback with
that same state is forwarded or counted, so a stranger's made-up callbacks
can't use up the real one's tries. Any other call gets "No sign-in is waiting"
and never reaches Hermes. Connect while Hermes already has a sign-in open
("already open") leaves the window of the sign-in this server started as it
was (state, tries and all), and opens none for a sign-in it didn't start (one
from before a restart): nothing would tie a callback to that one, so it is left
to expire. Hermes then accepts a forwarded callback only
for the sign-in it started (its OAuth state). Access, when configured, still
guards it on public origins too.

## The project bridge

The [project bridge](docs/bridge.md) lets agents in one project list, read,
message and start each other's chats, and wait for each other's answers. It's
off unless you turn it on (`"bridge": { "enabled": true }`). When it's on:

- **Loopback only.** Its listener binds to `127.0.0.1` on its own port (19012 by
  default). The tunnel only routes the web app's port, so the bridge can't be
  reached from the internet, and Cloudflare Access plays no part in it.
- **A bearer token is the only credential.** Wayroost makes it from 32 random
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
  Wayroost's own `mcp__signalbox__*` calls, never raises (Hermes blocks a
  call whose hook fails), and does nothing in a Hermes that Paseo runs. The
  agents' side passes the id on only when Hermes started it.
- **Logs** record each call's tool, caller, target and outcome, never the
  message, a title, a folder or the token.

Its limits, honestly:

- **Every agent runs as the same OS user.** Anything running as that user can
  read the token copy and call the bridge. The bridge can't tell your agents
  apart from any other process of yours.
- **Identity headers are claims, not proof.** A Paseo agent id or Hermes
  session id counts only if it matches a chat Wayroost lists, but a caller
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

### Worker updates (the task log)

[Worker updates](docs/bridge.md#worker-updates) let Wayroost tell a Hermes
chat about the Paseo workers it started. It's the one place Wayroost itself
writes into a chat, so:

- **It only speaks for workers the chat provably launched:** started by the
  bridge for that chat, or named by the chat's own `paseo run` result: a
  terminal or process tool result Hermes recorded for a command that starts
  with `paseo run`, ran cleanly, and printed the worker's full id as the row
  under its own run table's header (or in its JSON), within ten minutes of the
  worker's creation. Text in a message, worker output further down a result,
  and outputs with two run tables never count. The `signalbox.parent-hermes-chat`
  label alone is a claim anyone running `paseo` could make; an unproven worker
  gets nothing, and at most 40 of them (10 per chat) are followed at once.
- **It never carries an instruction from a worker.** Wayroost writes the
  state lines and the next step; the worker's last message (or Paseo's error)
  follows, quoted line by line with `> ` and stripped of hidden characters.
  An approval wait is information only, and says not to answer it: approvals
  stay with you.
- **It goes through the bridge's queue:** idle chats only, nothing waiting on
  you, never while paused, at most one message per worker per state and six
  per chat in ten minutes. Settings has a switch to turn it off.
- **It reads, never acts:** it reads Paseo's agent list and the chat's own
  stored messages through Hermes' dashboard, like a chat's page does. A
  worker's last message is read only while Paseo has it loaded, so nothing is
  resumed to read it.
- **It is off in shadow:** a shadow server runs no bridge and so no task log.
  The relay's own start, rounds and saves also sit behind the shadow gate, and
  Hermes chat moves stay in memory there.
- **Limits:** Completion updates may repeat wait results. Waiting does not
  suppress a later worker update. Delivered updates are persisted per worker
  run and state to prevent repeated relay deliveries across restarts.
  Delivering to a chat that came from WhatsApp runs that turn in the dashboard,
  as any bridge message does.

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
  with mode 660, group `signalbox-voice`, which only Wayroost joins. Requests
  carry audio or text, never paths.
- **Its supply chain is root's.** The program, a venv of hash-pinned wheels, and
  models checked against the publishers' SHA-256 all live in root-owned
  directories, so an agent running as your user can't change what turns your
  voice into text, or put words in your mouth.
- **Nothing is stored or logged.** Neither Wayroost nor the speech service
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
  signed with Wayroost's own VAPID key (RFC 8292). The push service sees only
  ciphertext, its size and timing. Wayroost sends only over HTTPS to the
  push services of Chrome, Firefox, Safari and Edge, never to an address a
  browser simply claims. Quiet hours hold card notifications back.
- **Subscriptions are added through the API.** A device subscribes under the
  same Access, CSRF and Host rules as every other call. At most 10 are kept, and
  ones the push service reports gone are dropped. The VAPID key pair and
  subscriptions are in `push.json` (600) in the state folder. The VAPID
  contact is your `publicOrigin`, not your email.
- **The service worker only shows notifications.** `/sw.js` displays what was
  pushed and opens a Wayroost page (a same-site path only) when you tap it. It
  has no fetch handler, so it can't cache, change or see requests.

## Scheduled jobs and mail triggers

- **Unattended runs get the least by default.** Hermes runs cron jobs while you're away and
  approves their tool calls by itself. So every job or mail trigger Wayroost creates carries
  an explicit `enabled_toolsets`, starting at "Nothing" (`todo, no_mcp`). Web search, web plus
  flights & maps, and Everything are opt-in, and Everything comes with a warning.
- **Mail stays data.** A mail trigger at any level below Everything can't open the message, so a
  crafted email can't steer it into the inbox or anything else. Only the details the gate
  script passes in reach the model.
- **Edits are partial.** A schedule or name change never rewrites a job's tools, and the For-you
  level changes only the pulse jobs' schedules.
- **What Wayroost can't see.** A job with no list falls back to Hermes'
  `platform_toolsets.cron`. Wayroost shows it as "Hermes decides" with a warning.

## Shadow mode

`role: "shadow"` keeps Wayroost from doing unattended work. The server does not
bind the agent bridge, ingest pulse cards, relay messages, send automatic phone
pushes, generate schedule ideas, probe connectors on a listing, persist lineage
reports, or resume backend sessions from reconnects, polls or stream gaps.
Automatic feed housekeeping and startup application-state creation/repair are disabled.
Approvals can still be shown in an open browser, and a signed-in person can
still send, approve, interrupt, change settings, manage schedules or explicitly
test notifications. Authentication and connection hygiene remain active.

Shadow defaults to `/var/lib/wayroost-shadow` and refuses primary state at
`/var/lib/wayroost`, legacy `signalbox` paths, and their resolved aliases or
subdirectories. Before any store or listener starts, an exclusive
`.wayroost-role` marker claims the state directory. It prevents opposite roles
from sharing custom paths even when they start concurrently. The marker is the
only shadow startup state write; it persists and is never overwritten. Shadow
refuses unmarked nonempty directories and invalid/unreadable ownership, so old
primary state fails closed too. Use separate directories when changing roles;
startup never migrates or resets existing data.

The helper, mail gate and launch hooks use the same fail-closed role policy.
Shadow wins across config and environment, and a helper request header can only
narrow its role. Invalid config or role resolution never grants primary: the
server stops and Python gates suppress unattended work. A missing mail runtime
or unreadable spec prints `{"wakeAgent": false}` and exits 0, preventing Hermes
from launching an error-reporting agent.
Primary installers supply scoped, explicit role configs for the helper, hook
and plugin; mail gates use explicitly primary specs when no role environment is
provided. These fallbacks do not rescue invalid explicit role/config sources.
Missing or invalid fallback/spec roles keep the actor shadow.

Shadow refuses new mail triggers before creating a helper folder or cron job.
Shadow revalidates helper capabilities before each request and sends operations
only to `/v1/shadow/...`. The namespace forces shadow handling; legacy helpers
reject it before acting, including when replaced after health verification.
There is no fallback to legacy routes. Old helpers are not
compatible with shadow; their shared legacy gate may ignore
spec roles. Role-aware primary helpers can serve signed-in shadow requests;
separate shadow helpers expose read-only skills to avoid concurrent state writers.
New primary trigger jobs use a separate Wayroost gate filename that old helpers
cannot overwrite. Existing shadow-tagged jobs retain their actual backend
state and cannot be resumed or run. Enabled legacy jobs warn to pause them;
pausing/deletion remain available even when ownership is unresolved. Recreate wanted
triggers at cutover. See [the cutover checklist](docs/shadow-cutover.md).

Launch hooks are global per user and still report to the primary bridge. Scope
shadow role/config environment to shadow processes; exporting it into primary
agent shells suppresses primary lineage reports too. The role gate is retained
so shadow or unresolved processes never post to the primary. A folder-only Hermes
plugin copy preserves caller identity but disables launch reporting without its
runtime; the installer requires and copies that runtime.

An existing config without a role stays primary. Shadow is an operational role,
not a restriction on most signed-in user actions; mail-trigger creation and
changes through a separate shadow skills helper are intentionally refused.

## Known limits

- **Cloudflare sees your traffic.** Cloudflare terminates TLS at its edge, so
  your traffic is visible to Cloudflare (unlike, say, Paseo's end-to-end
  encrypted relay).
- **Your email account is the key.** Whoever controls your Access identity
  (your email or identity provider) can sign in. Use 2FA there, and keep the
  Access session duration at 24 hours, as in the setup guide, or shorter.
- **Hermes password storage.** The Hermes dashboard only supports password
  sign-in, so Wayroost stores the password. It signs in with it every time the
  service starts, when you save it in Settings, and when Hermes reports an
  expired session, for example after Hermes restarts with a new signing secret.
  A process squatting on the Hermes port at one of those moments, such as when
  Wayroost starts while Hermes is down, could capture it. Limiting when it's
  sent narrows this but doesn't eliminate it.
- **Passwords you answer from the phone pass through Cloudflare.** With
  `hermes.secretPrompts` on, the sudo password, secret, master password, code
  or login you type travels through the tunnel. TLS ends at Cloudflare's edge,
  so Cloudflare can see it in transit, like everything else you send.
  Wayroost doesn't keep it, but Hermes does what it always does with it: it
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
- **The desktop app's local origin rests on the app.** A loopback cookie
  reaches every local port, so on a local origin only the desktop app signs in
  (see [Device sign-in](#device-sign-in-pairing)). Anything that sends the app's
  header, such as a program running as you, can still pair there with a code,
  but codes come only from a paired desktop or root. The test and demo setups
  (`SIGNALBOX_DEV_ALLOW_LOOPBACK`) use a plain-http public origin in a browser
  and have this weakness; never use them for real.
- **Anyone who can use a paired device is you.** A device stays signed in for
  400 days of use. Revoke a lost phone in Settings → Devices from a desktop.
  A program running as you on Windows can read the desktop app's cookie, as it
  can read Paseo's daemon password today.
- **Approvals are the last line of defence.** Wayroost gives agents the same
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
