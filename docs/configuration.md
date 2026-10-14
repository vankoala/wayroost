# Configuration

Legacy `signalbox` and `SIGNALBOX_*` names in this document stay unchanged for compatibility with existing deployments.

Wayroost reads one JSON file. `WAYROOST_CONFIG` takes precedence over
`SIGNALBOX_CONFIG`, which emits one deprecation line per process. If neither
is set, the server uses `$CREDENTIALS_DIRECTORY/config.json` when present,
then `/etc/wayroost/config.json`. Installed services require systemd 249 or
newer. Unit config paths use `/run/credentials/%n/<credential>`, where `%n`
is the full unit name, including any instance. See the
[credentials convention and specifier allowlist](../deploy/README.md).
The config is validated strictly at startup: unknown keys at any
level, unsafe values and missing fields stop the service with a clear message
instead of starting in a weaker state.

The settings pages read gateway telemetry through the supervisor's bounded
`gateway.status` view. Role prompt measurements come from the compiler's JSON
build output: save it as `roles-pack-build.json` in the server's state directory,
or set `settings.packBuildFile` to its absolute path. Only the load counts,
section counts and budgets are returned to the pages.

Set `agentStatus` in the supervisor's root-owned `settings-targets.json` to
`{ "home": "/home/me", "runAs": { "user": "me", "uid": 1001 }, "binaries": {
"claude": "/home/me/.local/bin/claude", "codex": "/home/me/.local/bin/codex",
"copilot": "/home/me/.local/bin/copilot" } }` to enable installation and sign-in
status probes. The supervisor runs a bounded, private-network unit as that owner,
with a read-only home, and returns the `wayroost.agents` observation. The server
keeps its dynamic account and home isolation. The probes invoke status commands
and Copilot's stdio auth status RPC with bounded output and timeouts; only
installed and authenticated flags are returned. Omitted or unreadable sources
remain unknown. Move any earlier `settings.agentStatus` server entry to this
supervisor setting; the server entry no longer controls probes.

A minimal primary config behind a public tunnel, using the new paths:

The local ports below are invented defaults. Set the Hermes, Paseo and model
addresses to your own installation's endpoints; explicit configuration continues
to take precedence. Keep local machine layouts in private configuration files.

```json
{
  "role": "primary",
  "listen": { "host": "127.0.0.1", "port": 19010 },
  "publicOrigin": "https://wayroost.example.com",
  "access": {
    "teamDomain": "https://example-team.cloudflareaccess.com",
    "aud": "example-access-aud",
    "allowedEmails": ["you@example.com"]
  },
  "hermes": { "enabled": true, "url": "http://127.0.0.1:19006" },
  "paseo": { "enabled": true, "url": "ws://127.0.0.1:19007" },
  "stateDir": "/var/lib/wayroost"
}
```

Replace the example hostname, Access team, AUD and allowed email with your own
values, and turn off whichever of Hermes and Paseo you don't run. This primary
example has no local origins or desktop listener, so its loopback tunnel backend
can still use HTTP. Installed desktop and shadow listeners need the TLS and
origins described in [Loopback TLS](#loopback-tls); the
[server installer](../deploy/README.md) supplies those and starts in shadow mode.
On legacy installs, `deploy/setup-tunnel.sh` fills in `publicOrigin`,
`access.teamDomain` and `access.aud` in `/etc/signalbox/config.json`. The legacy
installer leaves the service stopped while its template still contains `YOUR-`
placeholders.

## Fields

| Field | Default | Rules | Meaning |
| --- | --- | --- | --- |
| `role` | `primary` | `primary` or `shadow` | Shadow disables unattended work; paired people can still act. Requires a restart. A shadow needs device sign-in and an explicit `listen.port` that isn't a primary service port. |
| `listen.host` | `127.0.0.1` | loopback: `localhost`, an address in `127.0.0.0/8`, or `::1` (never `0.0.0.0`) | Only cloudflared (same machine) should reach the app. |
| `listen.port` | `19010` | 1–65535 | Local port for the app. `setup-tunnel.sh` points the tunnel at it. |
| `publicOrigin` | `publicOrigin` or `origins` required | `https://` origin, no path, not a loopback host | The address you open on your phone: the main entry of `origins`, and the one pairing QR codes point to. |
| `origins` | none | up to 16 bare origins: `https://` ones, plus local `http://127.0.0.1:<port>` (or `localhost`) ones | Every other address the app is opened from: a tailnet name, the relay, and the desktop's own `https://127.0.0.1:8883`. Each one's `Host` is allowed, and its requests must carry its own `Origin`; two origins may not share a `Host` (say `http://` and `https://` on the same port), since the server tells sites apart by `Host`. A local origin (any loopback host, `http://` or `https://`: all of `127.0.0.0/8`, `::1` and IPv4-mapped forms, `localhost` with or without a trailing dot, `*.localhost`, and `0.0.0.0` or `[::]`) is reached on this machine only, and needs a paired device but no Access token; only the desktop app signs in there. |
| `localListener` | none | loopback host, matching local origin, port distinct from `listen.port`, `bridge.port`, `helper.port` and 19011 (cloudflared metrics) | The desktop's PC-only listener, normally `127.0.0.1:8883`. Requires device sign-in and installed TLS. `pcOnlyWrites` defaults to false; keep it false until its live Windows check passes. |
| `tls` | none | `certFile`: absolute certificate path; `keyFile`: development only | Both server listeners share this certificate. Installed keys and certificates come from `loopback-tls-key` and `loopback-tls-cert` systemd credentials. Shadow and desktop listeners require TLS; see [Loopback TLS](#loopback-tls). |
| `rollout` | all false | `settingsPages`, `revokes`, `chatFirst`: booleans | Enable settings writes, revokes/staging, and the basic chat default separately. See [settings rollout](settings-rollout.md). |
| `devices.enabled` | `true` | required in shadow | Device sign-in: every browser pairs once with a single-use code (see [SECURITY.md](../SECURITY.md#device-sign-in-pairing)). Turn it off only in primary mode with `access` configured; shadow refuses to start without pairing, including when an environment override selects shadow. |
| `access` | none | | Cloudflare Access, an extra lock for public origins. When it's set, requests through a public origin need its token as well as a paired device; local origins need the device only. |
| `access.teamDomain` | required in `access` | `https://<team>.cloudflareaccess.com` | Your Zero Trust team. Wayroost fetches signing keys from `<teamDomain>/cdn-cgi/access/certs`. |
| `access.aud` | required in `access` | non-empty | The Access application's AUD tag. Tokens issued for any other application are rejected. |
| `access.allowedEmails` | required in `access` | at least one, plain ASCII | Who may use Wayroost, checked again after Cloudflare's own policy. |
| `access.jwksUrl` | `<teamDomain>/cdn-cgi/access/certs` | must live under the team domain | **For tests only.** Where to fetch the signing keys. |
| `hermes.enabled` | `true` | | Turn off if you don't run Hermes. |
| `hermes.url` | `http://127.0.0.1:19006` | `http://` or `https://` loopback | The Hermes dashboard. Only its origin is used; any path is dropped. |
| `hermes.secretPrompts` | `false` | `true` or `false` | Lets you answer all of Hermes' password prompts from the phone: sudo, a skill's secret, a vault master password, a 2FA code, and a login to save. When it's off, they only get a notice. What you type passes through Cloudflare; see [Password and secret prompts](hermes.md#password-and-secret-prompts). |
| `paseo.enabled` | `true` | at least one source enabled | Turn off if you don't run Paseo. |
| `paseo.url` | `ws://127.0.0.1:19007` | `ws://` or `wss://` loopback | The Paseo daemon (`/ws` is added if no path is given). |
| `bridge.enabled` | `false` | | Turns on the [project bridge](bridge.md): a listener on `127.0.0.1` that agents use to reach the other chats in their project. |
| `bridge.legacyNames` | `true` | boolean | Rename transition: accept `signalbox` alongside `wayroost`. Set false after the cutoff audit; see [finish/undo](bridge-names.md). |
| `bridge.port` | `19012` | 1–65535, not `listen.port` and not 19011 (cloudflared metrics) | The bridge listener's port. It only ever binds to `127.0.0.1`. |
| `speech.enabled` | `false` | | Turns on [voice mode](voice.md). `deploy/setup-speech.sh` sets it after installing the speech service. |
| `speech.socket` | `/run/signalbox-speech.sock` | absolute path | The speech service's Unix socket. |
| `feed.enabled` | `false` | | Turns on [For you](for-you.md): cards from Hermes' brief and daytime checks (posted through the bridge, so turn that on too), the proactivity and quiet-hours settings, and phone notifications (these need an `https://` `publicOrigin`). |
| `notifications.timeZone` | this PC's own zone | an IANA name this PC's time-zone database knows (`Europe/Berlin`, `UTC`) | Whose clock the quiet hours in Settings → Notifications are read on, so an owner away from home keeps their own 21:00. Unset means the zone this PC is set to. In pipeline mode this field is ignored; use `timeZone` in [owner-held settings](wayroost-settings.md). See [Alerts](notifications.md). |
| `settings.legacyRoutesViaPipeline` | `false` | boolean; read at startup | Route Cloud agents, Safety commands and Worker approvals through the settings pipeline. Enable only after carrying over current choices with writers stopped and verifying supervisor config verbs and `configWrites`; see [cutover](shadow-cutover.md). Capabilities alone never enable it. |
| `settings.packBuildFile` | `<stateDir>/roles-pack-build.json` | absolute path | Compiler build output used for role load counts, section counts and budgets. |
| `settings.agentStatus` | none | `home` and `binaries` with absolute paths | Accepted for compatibility but no longer controls probes. Configure `agentStatus`, including `runAs`, in the supervisor's `settings-targets.json` as described above. |
| `supervisor.socket` | `/run/wayroost/supervisor.sock` | absolute path, at most 107 bytes | Status & power: the supervisor's Unix socket. Without a `supervisor` block the power API says the supervisor isn't running. |
| `supervisor.keyFile` | none | absolute path | Development only, when `CREDENTIALS_DIRECTORY` is unset: a file holding the supervisor's server key. When the `supervisor` block is configured, a configured credentials directory must supply a readable, valid `supervisor-server-key`; otherwise startup is refused, even with a `keyFile`. Without a `supervisor` block, no supervisor credential is required. The credential wins when both are there; a `supervisor` block with neither is refused. |
| `stateDir` | `/var/lib/wayroost` for primary; `/var/lib/wayroost-shadow` for shadow | absolute path, isolated by role | Private state: the saved Hermes sign-in, the Paseo client id, the bridge token, For you's cards and phone subscriptions, and legacy Wayroost preferences. In pipeline mode, preferences use the [owner-held settings target](wayroost-settings.md); the state folder retains operational cards, queues and journals. Primary deployments carried over from Signalbox can keep `/var/lib/signalbox` (mode 700). |
| `staticDir` | next to the server bundle | absolute path | Built web assets. You won't normally set this. |

The example leaves the bridge out, so it stays off. To turn it on, add:

```json
"bridge": { "enabled": true }
```

Answering Hermes' password prompts from the phone is off too. To turn it on,
add `secretPrompts` to the `hermes` block, then restart Wayroost:

```json
"hermes": { "enabled": true, "url": "http://127.0.0.1:19006", "secretPrompts": true }
```

Read the [risks](../SECURITY.md#known-limits) first.

There is deliberately no option to turn off authentication: with device
sign-in off and no `access`, the server refuses to start.

## Loopback TLS

Installed Wayroost listener configs include
`"tls": { "certFile": "/etc/wayroost/server-tls-cert.pem" }` and the local origins
`https://127.0.0.1:8881` and `https://127.0.0.1:8883`. The desktop uses the separate
8883 listener; the tunnel targets the main 8881 listener. See [settings rollout](settings-rollout.md). Supervisor config uses
`"tls": { "certFile": "/etc/wayroost/supervisor-tls-cert.pem" }` with
`"development": false` at the root of `/etc/wayroost/supervisor.json`.
`supervisor.development` is not a server config field. Both units load `loopback-tls-cert` and
`loopback-tls-key` with systemd `LoadCredential`. Installed keys cannot use
`tls.keyFile`. Shadow servers and servers with device-enabled local origins
require TLS at startup; the existing primary deployment behind cloudflared keeps
its HTTP backend without a development flag until cutover. The supervisor refuses a
plaintext rescue listener unless its explicit development setting is true.

The installers preserve complete certificate pairs and never print private
keys. Keys are root:root 0600, certificates 0644 inside `/etc/wayroost` (0750).
The DynamicUser gets only systemd's credential copies. Root's pairing command
reads the public certificates directly to print their SPKI fingerprints.
`sudo wayroost fingerprints` reads those files offline, including when the
server is down. Never take a fingerprint from the live listener.

For local development, `WAYROOST_DEV_ALLOW_LOOPBACK=1` permits a server config
without `tls`; supervisor dev configs explicitly set `development: true`.
`npm run desktop:dev` supplies `--wayroost-desktop-dev` and defaults to HTTP on
8896/8898. Only that unpackaged mode permits the URL environment overrides.
Production installs never set development flags. TLS dev configs may provide
`tls.keyFile`; credential mode still takes precedence.
The desktop sets both user data and session data to `wayroost-desktop-dev`
before startup, isolating cookies, encryption state, keys and pins from installs.

Rotate with `sudo wayroost rotate-tls server` or
`sudo wayroost rotate-tls supervisor`; then issue a new token with
`sudo wayroost pair-desktop` and paste it into the desktop recovery form. The
app verifies the code under the supplied pin before encrypting the new pins,
then restarts to clear cached certificate decisions. The rescue key itself
is unchanged by certificate rotation.
After suspected key compromise, revoke every old desktop device through
Settings → Devices & access → Devices after server rotation and re-pairing.
For supervisor compromise, root must replace the `desktop-rescue` SHA-256 entry
in `/etc/wayroost/supervisor-keys.json` with the hash of a newly generated
256-bit rescue key, preserving the server entry, restart the supervisor, and
save the new key and fresh token in the desktop. Keep the key out of logs.
Rotation alone does not invalidate captured cookies or the rescue key.

The PC browser path relies on a paired-device cookie and normal browser HTTPS
validation; browsers cannot pin. Open the public tunnel/tailnet origin in a
browser. The desktop app is the hardened path. Phones continue through the
Cloudflare tunnel. When pointing that tunnel at Wayroost, use
`service: https://127.0.0.1:8881` and `originRequest.caPool` containing the server's
public certificate (deliver it with a credential or a readable public-only copy).
Keep certificate verification enabled. Refresh the CA copy after server rotation.
The existing primary's tunnel stays unchanged until cutover.

## Signing in: pairing devices

Each browser, phone and the desktop app pairs once. On a paired desktop, open
Settings → Devices & access → Devices and choose **Pair a phone**: it shows a QR code that opens
`<publicOrigin>/pair#<code>` on the phone. The code works once, for 10 minutes.

To pair the first device, or when no paired desktop is at hand, use the installed
server's fixed-config recovery wrapper as root on its machine:

```sh
sudo wayroost pair            # a phone code
sudo wayroost pair-desktop    # a desktop code and combined token with TLS pins
```

Both explicitly select `/etc/wayroost/config.json` and accept no extra flags or
paths. Paste the desktop token into the desktop recovery form before it
connects. These are **device pairing codes**. The supervisor rescue key is a
separate credential shown once by `install-supervisor.sh`; use the saved
installer key. The wrapper cannot recover that original key from its stored hash.

Without the wrapper, select the build and config for your installation explicitly:

```sh
sudo node /opt/wayroost/server/dist/server/pair-code.js --config /etc/wayroost/config.json --phone
```

On a legacy `install.sh` deployment, use its build and config instead:

```sh
sudo node /opt/signalbox/dist/server/pair-code.js --config /etc/signalbox/config.json            # a code for a desktop
sudo node /opt/signalbox/dist/server/pair-code.js --config /etc/signalbox/config.json --phone    # a code for a phone
```

(From a source checkout: `sudo npx tsx scripts/pair-code.ts --config /etc/wayroost/config.json`,
or `--config /etc/signalbox/config.json` for a legacy deployment.) The raw command prints the
code and a pairing link for every https origin (type the code into the desktop
app instead), and also lifts a pairing lock left by too many wrong codes. It reads the config from `--config <path>`,
`WAYROOST_CONFIG`, `SIGNALBOX_CONFIG`, `$CREDENTIALS_DIRECTORY/config.json`
(when present) or `/etc/wayroost/config.json`, in that
order, and talks to the running server over `<stateDir>/pairing/pair.sock`.

To add the PC's own address for the Wayroost desktop app, list it in
`origins`:

```json
"localListener": { "host": "127.0.0.1", "port": 8883, "pcOnlyWrites": false },
"origins": ["https://127.0.0.1:8881", "https://127.0.0.1:8883"]
```

Only the desktop app can pair or sign in at a local address (any loopback
host, `https://` ones included); a browser there gets "A browser can't sign in at this PC's own address". A
browser shares one set of cookies between every port on `127.0.0.1`, so its
device cookie would also reach any other web server on the PC, an agent's
included. In a browser on the PC, open Wayroost at its `https://` address
(the tunnel or tailnet one), like on a phone. The desktop app marks every
request with the header `x-wayroost-app: desktop` and keeps its cookie in its
own storage.

### Status & power and "when idle"

Every power action and presence report comes from a paired device: the
paired desktop acts at once, a paired phone confirms with a second tap, and an
Access sign-in without a paired device is refused. While the supervisor is set
up, the server pushes the counts "when idle" waits on (running Paseo agents,
Hermes turns, phone calls) every 10 seconds, and sends nothing when any count is
unknown. Hermes' current API can't tell this server how many turns are running
across all of its processes, so no counts are sent for now: the supervisor
treats the PC as busy, and a "when idle" action fails when its idle limit
passes instead of starting on its own. "Now" actions are not affected.

## Environment variables

| Variable | Read by | Meaning |
| --- | --- | --- |
| `WAYROOST_CONFIG` | the server, `pair-code`; helper and hooks when explicitly set | Explicit config path. `SIGNALBOX_CONFIG` is a deprecated fallback. Without either, the server and `pair-code` use `$CREDENTIALS_DIRECTORY/config.json` when present, then `/etc/wayroost/config.json`. |
| `WAYROOST_SAFETY_CONFIG` | Safety helper | Explicit helper config path. Without it, uses `$CREDENTIALS_DIRECTORY/safety-helper.json` when present, then `/etc/wayroost/safety-helper.json`. |
| `WAYROOST_LOG_LEVEL` | the server | `trace`, `debug`, `info` (default), `warn`, `error`, `fatal` or `silent`. Applies to all of Wayroost's logs. `SIGNALBOX_LOG_LEVEL`, then the existing `LOG_LEVEL`, remain fallbacks. |
| `WAYROOST_DEV_ALLOW_LOOPBACK` | the server | `1` lets the config use a local Access issuer and a plain-http loopback origin. **For tests only**: with it set, anyone who can run a local key server could mint tokens. The systemd unit never sets it. |
| `CREDENTIALS_DIRECTORY` | the server, Safety helper | Set by systemd. Supplies config credentials when explicit config paths are unset, the supervisor's `supervisor-server-key`, and `paseo-password`. |
| `TUNNEL_NAME` | `deploy/setup-tunnel.sh` | The dedicated tunnel to create or reuse: 1 to 64 letters, digits, dots, underscores or hyphens. Default `signalbox`. |
| `PORT` | `npm run demo` | The demo's address, `http://127.0.0.1:<PORT>`. Default `8890`. The demo server itself listens on the next port up, behind a local stand-in for Cloudflare. |
| `PASEO_LOG` | `npm run check:paseo` | Log level of the Paseo daemon the compatibility harness starts. Default `silent`. |
| `CHROME` | `npm run check:ui`, `scripts/e2e-local.ts`, `scripts/make-icons.mjs` | Path to Chrome. Default `/usr/bin/google-chrome`. |
| `WAYROOST_BRIDGE_URL` | `signalbox-bridge.mjs` | The bridge listener. Default `http://127.0.0.1:19012`; anything that isn't `http://` on this machine is refused. `setup-bridge.sh` sets it when `bridge.port` isn't the default. |
| `WAYROOST_BRIDGE_TOKEN_FILE` | `signalbox-bridge.mjs` | Where the agent's copy of the bridge token is. Default `~/.config/wayroost/bridge-token`. |
| `PASEO_AGENT_ID`, `PASEO_AGENT_CWD` | `signalbox-bridge.mjs` | Set by Paseo for the agents it runs: which agent is calling, and its folder. |

All existing `SIGNALBOX_*` runtime variables are accepted as fallbacks to the
matching `WAYROOST_*` name and emit one deprecation line, without the value.
Backend-owned variables such as `PASEO_AGENT_ID`, `HERMES_HOME` and systemd's
`CREDENTIALS_DIRECTORY` retain their names. Additional Wayroost variables:

| Variable | Read by | Meaning |
| --- | --- | --- |
| `WAYROOST_BRIDGE_NAME` | bridge wrapper | Stamp every new MCP registration with `wayroost`. An unset value identifies as `signalbox`; unstamped and explicit legacy launches are refused after cutoff. See [bridge names](bridge-names.md). |
| `WAYROOST_BRIDGE_LEGACY_NAMES` | bridge wrapper, Hermes identity plugin | `true` or `false`: local compatibility gate. The wrapper defaults to true; the plugin otherwise reads its `wayroost-bridge.json` mirror. Keep overrides consistent with `bridge.legacyNames`; the server remains authoritative. See [cutoff](bridge-names.md#both-name-transition). |
| `WAYROOST_ASSIST_URLS` | server | Comma-separated local model API bases. Default: `http://127.0.0.1:19001/v1`, an invented example; set this to your installed model's URL. |
| `WAYROOST_ROLE` | server, helper, mail gate, launch hooks | `shadow` or `primary`; shadow wins if either environment or config says shadow. `primary` cannot widen a shadow config. Legacy configs without a role remain primary; invalid roles/config resolution stop the server or silence Python background work. |
| `WAYROOST_HELPER_PORT` | helper | Loopback listener port; default 19013. |
| `WAYROOST_HELPER_ROLE_CONFIG` | helper | Scoped fallback role config installed with the primary helper. Explicit `WAYROOST_ROLE` / `WAYROOST_CONFIG` and their legacy aliases take precedence. |
| `WAYROOST_SHOP_CDP`, `WAYROOST_PHONE_URL`, `WAYROOST_VAULT_CMD` | helper | Existing shopping, phone and vault endpoints/command; only their environment names change. |
| `WAYROOST_SKILLS_HOME`, `WAYROOST_SKILLS_WINDOWS_HOME`, `WAYROOST_SKILLS_WINDOWS_HERMES` | helper | Existing skill-folder roots. |
| `WAYROOST_LAUNCHER` | launch hooks | Launcher identity; the Claude hook also writes the old alias for existing consumers. |

## Shadow mode

Set `"role": "shadow"` for a second server before cutover. The default is
`primary`, so an existing legacy config keeps its paths, ports and behavior.
Shadow requires explicit `listen.port`; an omitted `stateDir` defaults to
`/var/lib/wayroost-shadow`, including when an environment override selects shadow.
Ports 19010–19013 and `/var/lib/wayroost`, `/var/lib/signalbox` or `/etc/signalbox`
(including their subdirectories and resolved aliases) are rejected for shadow.
Use a separate state directory and listener port. No files are migrated or
existing jobs paused at startup.

Before any store or listener starts, Wayroost atomically creates a private
`.wayroost-role` file (`primary` or `shadow`, mode 600) in its state directory
(mode 700 when newly created). Both roles refuse a directory or ancestor owned
by the other role. The marker persists across restarts and is never overwritten.
Shadow also refuses an unmarked nonempty directory, so existing primary state
cannot be mistaken for shadow state; use a new empty directory for older shadow
installations. Unreadable/invalid markers and unresolved paths stop startup.
Primary can adopt its existing unmarked directory without changing its data.
An exclusive Linux abstract Unix socket locks the state directory by its device
and inode before any store or recovery socket starts. The process holds that
socket for its lifetime; concurrent instances of either role, including aliases
of the directory, are refused. Process exit (including a crash) releases the
lock automatically, without a stale socket file or another runtime dependency.
Role changes require a separate state directory; see [cutover](shadow-cutover.md).

The server's single `BackgroundGate` disables the bridge listener and token,
agent messages and waits, lineage reports and saves, pulse ingestion, approval
and card pushes, feed wake/prune writes, startup pulse discovery, the schedule
idea writer, implicit connector probes, and unattended backend resumes. A
Paseo timeline gap or reconnect does not fetch a stored agent in shadow.
Startup does not persist a new client id or VAPID key, or repair a push file.
The role marker and local pairing socket are shadow startup state; the instance
lock has no filesystem entry. Existing schedule
ideas, cards and state in a shadow-owned directory remain readable.

Authenticated requests still send messages, answer approvals, change controls,
manage chats/settings/schedules/connectors/skills, act on stored feed cards,
and manage notification subscriptions. **Test notification** explicitly sends
one notification. Conversation GETs, subscriptions and reconnect refreshes remain read-only in
shadow. A paired person's **Open live chat** button sends a deliberate POST,
which may load a Paseo timeline or attach a live Hermes session; an explicit action
can resume a stopped chat and cancel a pending crash replay as before.
Hermes approval-routing capabilities are advertised on that explicit action,
instead of on a shadow connection. The desktop displays its shadow attachment and suppresses native approval notifications,
while approval cards and deliberate responses remain available. Read-only status/list refreshes,
authentication maintenance, socket heartbeats/expiry and timeouts within an
explicit request stay active.

The helper and launch hooks are separate processes. A separate shadow helper
needs `WAYROOST_ROLE=shadow` or a readable `WAYROOST_CONFIG`. A Python process
with neither role nor readable config acts as shadow. Primary installation puts
`wayroost-role.json` beside the helper and Claude hook; `setup-bridge.sh` also
installs it beside the Hermes plugin. The helper unit names that scoped fallback
with `WAYROOST_HELPER_ROLE_CONFIG`; `install.sh` adds it to older helper units.
These defaults apply only when no explicit role/config environment is set, so
current or legacy shadow overrides still suppress primary launch reporting.
Missing, invalid or unreadable fallback configs disable work. Re-run
`setup-bridge.sh` when updating an existing plugin. Shadow wins across
those sources and a request's `x-wayroost-role` header; the header can only
narrow the helper's role. Invalid role headers return 400. Invalid or unreadable
role configuration disables unattended work. A shadow helper's skills are
read-only: share, exclude, remove, take-shared and refresh return an error directing
you to the primary helper. Listings read current on-disk state without spreading
skills. Signed-in skill changes through a role-aware primary helper still work.

Shadow refuses mail-trigger creation before writing any helper folder or Hermes
job. It also refuses an old helper before reading skills or writing triggers:
the health response must acknowledge shadow support before every shadow operation,
including after a helper restart or downgrade. Each operation then uses the
versioned `/v1/shadow/...` namespace, which forces shadow handling even without
a shadow header. Legacy helpers reject these routes before executing an operation,
so replacement between health verification and the operation cannot cause legacy
writes. No request falls back to an unversioned route. The skill listing must
also confirm the effective shadow role. Update both the server and helper before
using shadow; older role-aware helpers without the versioned routes are refused
too. Primary helper requests retain their existing unversioned routes.
Primary trigger creation also requires the helper to confirm the stored primary
role; a missing or invalid acknowledgement is refused and its folder is removed.
New primary triggers use `wayroost_mail_trigger.py`, which old helpers
do not overwrite; the shared legacy script is left untouched. The helper echoes
the stored role in trigger writes and listings. Both interfaces preserve the
backend's enabled/running state. Enabled shadow-tagged specs warn to **Pause this
trigger and recreate it from primary**; only paused specs are labelled inactive.
Shadow or unresolved specs can be paused and deleted, but cannot be resumed or
run from those APIs. Legacy jobs pointing to an old shared
gate must be paused or deleted: an old gate cannot honour their
role. At cutover, delete shadow-tagged jobs/specs and recreate wanted triggers
from primary; see [the cutover checklist](shadow-cutover.md).
Helper role-lookup failures mark only mail triggers as unknown; ordinary Hermes
jobs remain available for listing, editing, deletion and pulse settings.

The Claude hook and Hermes plugin are registered once per user and report to the
primary bridge. Ambient `WAYROOST_ROLE=shadow` or a shadow/unreadable
`WAYROOST_CONFIG` suppresses their launch reports. Scope shadow variables to the
shadow server/helper command or unit; do not export them globally into primary
agent shells. Retaining this gate prevents unresolved or shadow processes from
posting to the live bridge. Missing runtime code suppresses launch reports while
the Hermes caller-identity hook remains available. New mail gates use their
explicit primary spec as the scoped role config when the scheduler supplies no
role environment. Missing or invalid spec roles stay shadow. Gates read shadow specs
before resolving any process role, and print `{"wakeAgent": false}` with exit 0
on role, config, spec or runtime resolution errors so Hermes does not run an
error-reporting agent.

Jobs and relays already running in a separate primary Hermes installation
remain owned by that installation. Shadow does not pause them or suppress their
WhatsApp delivery. Their posts cannot reach the shadow server because its
bridge/pulse listener is absent. Configure any separately launched shadow
actors with the shadow role; changing the server config does not change
another process's environment.

## Files

The server config defaults to `/etc/wayroost/config.json`. State defaults to
`/var/lib/wayroost/` for primary and `/var/lib/wayroost-shadow/` for shadow.
The legacy installer and existing deployments use the following locations;
explicit config paths continue to work.

The server's bridge token is always `<stateDir>/bridge-token`, for example
`/var/lib/wayroost/bridge-token` after primary cutover. With `DynamicUser=yes`,
systemd may back the configured state directory with `/var/lib/private/`:
the legacy `signalbox.service` stores it at
`/var/lib/private/signalbox/bridge-token`, and the shipped shadow server uses
`/var/lib/private/wayroost-shadow/`. These are service state locations; the
agents use their separate copy in `~/.config/wayroost/bridge-token`.

| Path | Owner / mode | Contents |
| --- | --- | --- |
| `/opt/src/signalbox` | root; it and every parent directory writable by root only | Source. The installer refuses a directory that anyone but root could modify, including through a parent, so pick a root-only location. Debian's `/usr/local/src`, for example, is often `root:staff` with mode 2775, which is refused. |
| `/opt/signalbox` | root, read-only to the service | Installed build and runtime dependencies. |
| `/etc/signalbox/config.json` | root, 644 | The config above. It contains no secrets. |
| `/etc/signalbox/cloudflared.yml` | root, 644 | Tunnel config, generated from `deploy/cloudflared.yml.template`. |
| `/etc/signalbox/tunnel-credentials.json` | root, 600 | The tunnel's secret. systemd passes it to cloudflared with `LoadCredential`. |
| `/etc/systemd/system/signalbox.service`, `signalbox-tunnel.service` | root, 644 | The two services, installed from `deploy/`. |
| `/root/.cloudflared/cert.pem` | root | cloudflared's account certificate, from `cloudflared tunnel login`. The deploy scripts always use root's own home, even when `sudo` keeps yours. |
| `/root/.cloudflared/<tunnel-id>.json` | root | The tunnel credential as cloudflared created it. `setup-tunnel.sh` copies it to `/etc/signalbox/tunnel-credentials.json`. |
| `/var/lib/signalbox/` | service user, 700 | `devices.json` (600: paired devices, each with only a SHA-256 hash of its secret, and whether pairing is locked), `pairing/pair.sock` (600, in a 700 folder: the recovery socket `pair-code` uses), `hermes-credentials.json` (600), `paseo-client-id` (600), `bridge-token` (600) once the bridge has been on, and with For you on, `feed.json` (600: cards and settings) and `push.json` (600: the VAPID key and each device's push subscription). |
| `/opt/signalbox/bin/signalbox-bridge.mjs` | root, 755 | The bridge's agent side, a stdio MCP server, installed by `install.sh`. |
| `~/.config/wayroost/bridge-token` | your user, 600 (folder 700) | The agents' copy of the bridge token, written by `setup-bridge.sh`. |
| `/opt/signalbox-speech/` | root, read-only to the service | Voice mode: the speech service's venv and models, from `setup-speech.sh`. Its program is `/opt/signalbox/bin/signalbox-speech.py`. |
| `/run/signalbox-speech.sock` | root, group `signalbox-voice`, 660 | Voice mode: the speech service's socket, made by `signalbox-speech.socket`. |

## Ports

| Port | Bound to | What |
| --- | --- | --- |
| 8881 | 127.0.0.1 | Installed Wayroost main listener, HTTPS; the tunnel target after [cutover](shadow-cutover.md). |
| 8883 | 127.0.0.1 | Installed desktop `localListener`, HTTPS; never the tunnel target. |
| 8880 | 127.0.0.1 | Supervisor HTTPS rescue listener for the desktop. Separate from its Unix socket. |
| none | Unix socket | Supervisor server API: `/run/wayroost/supervisor.sock`. |
| 19010 | 127.0.0.1 | Server config default and legacy `install.sh` listener; the new installer uses 8881, including after cutover. |
| 19011 | 127.0.0.1 | cloudflared metrics and readiness (`GET /ready`) |
| 19012 | 127.0.0.1 | The project bridge, when it's on, and For you's card routes (`/pulse/v1/…`). Never routed through the tunnel. |
| none | Unix socket | Pairing recovery: `<stateDir>/pairing/pair.sock`, for root's `pair-code` only. |
| none | Unix socket | The speech service (voice mode) listens on `/run/signalbox-speech.sock` only, with no network at all. |
| 19006 | your Hermes setup | Hermes dashboard (Wayroost connects locally) |
| 19007 | your Paseo setup | Paseo daemon (Wayroost connects locally) |

Never route Hermes or Paseo ports through a tunnel. Only Wayroost should be
public, and only behind Access.

The default coder MCP registration name is `coder`. Its script paths come from
`coderMcp.original` and `coderMcp.gatewayCopy` in the settings targets; process
checks match their configured basenames. For example, a registration can run
`/home/me/demo/helper-mcp.py` with `python3`.

A phone line, when there is one, is checked through two loopback `/health`
endpoints. The phone server's reports the integer counters `active_calls`,
`webhooks` and `outbound_calls`. The bridge's reports `active_calls`,
`oldest_call_seconds` and `brains.persona`: the loopback `url` and the `model`
its spoken persona uses. Moving the phone to the gateway writes a systemd
drop-in on the bridge unit (`Environment=` lines in its `[Service]` section).
