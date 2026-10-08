# Wayroost desktop

From a Windows checkout, run `npm ci` in this directory, then run
`npm run desktop:dev` from the repository root. Keep `desktop/node_modules`
ignored and installed inside this checkout; a symlink to another checkout
lets dependency cleanup modify that checkout.
Development uses
`WAYROOST_URL=http://127.0.0.1:8896` and
`WAYROOST_RESCUE_URL=http://127.0.0.1:8898`. Installed defaults are `https://127.0.0.1:8883` and `https://127.0.0.1:8880`;
a packaged (installed) app ignores both variables.
HTTP requires the development flag supplied by `npm run desktop:dev`; unpackaged
apps without that flag also use pinned HTTPS. Tests use development ports and invented keys.
Development sets both user data and session data to a separate
`wayroost-desktop-dev` directory before the instance lock, so installed cookies,
encryption state, keys and pins are never opened by dev mode.
Development registers `wayroost-dev:` links and uses them in its toasts, leaving
the installed `wayroost:` handler alone. The registered launch command includes
`--wayroost-desktop-dev`, so a toast or protocol link that starts a new process
selects isolated storage before the instance lock. Second-instance activations
use the same development protocol and storage.
Only packaged builds register automatic startup at sign-in; development and
other unpackaged launches leave the installed app's login registration alone.

Before first connection, run `sudo wayroost pair-desktop` in the PC's terminal
and paste its combined JSON token into the bundled recovery form. The token
includes the single-use pairing code, local listener port (8883 by default), server
SPKI fingerprint and supervisor rescue SPKI fingerprint. The local listener uses
the server certificate; the tunnel and phones use the main listener on 8881.
The native enrollment transport validates TLS before sending the code, checks `/api/me`, then encrypts both pins with `safeStorage`
and restarts the app. The server's cookie is saved only after that check.
Without a saved pin the app never loads the remote pairing page or sends credentials.

When upgrading from a server config without `localListener`, re-run the server
installer as root to add `127.0.0.1:8883` and its HTTPS origin. Existing listener
config is preserved; a new listener starts with `pcOnlyWrites: false`. Saved
`listener-pins` without a local port use 8883. After the server is running with
that listener, obtain a fresh `sudo wayroost pair-desktop` token and pair again
to pin its TLS and save its port. Keep `pcOnlyWrites` false until the live desktop
check described in [settings rollout](../docs/settings-rollout.md#desktop-listener) passes.

The rescue form also accepts the install-time rescue key and an explicitly
pasted supervisor fingerprint, independently of server pairing. Encrypted pins
live in `listener-pins`; the separately encrypted key remains in `rescue-key`.
Unavailable encryption and Linux's plaintext storage backend fail closed.
Run `sudo wayroost fingerprints` to read public fingerprints from installed
files while the server is down. Never take a fingerprint from the live listener.

Each app and rescue session installs `setCertificateVerifyProc` before network
activity. It checks the stored SPKI hash, SAN and dates. The app's header hook
also restricts all network requests to the exact HTTPS/WSS origin. The native
rescue client verifies each socket before handing it to an HTTP request; no
bearer bytes reach a mismatched listener. Errors say “This is not your Wayroost
server”. Pins are fixed for the network-service lifetime; enrollment or re-pinning
restarts the app to discard Chromium's certificate cache. The rescue page uses
the separate in-memory `wayroost-rescue` session, with no device cookie.

Root rotation: `sudo wayroost rotate-tls server` or
`sudo wayroost rotate-tls supervisor`. A new certificate is rejected until you
paste a fresh token from `sudo wayroost pair-desktop`; a saved rescue fingerprint
cannot be changed with just a rescue key. Open **Set up recovery** in the tray
menu to paste the fresh token, including when the app still works and only the
supervisor certificate changed. The form opens beside the healthy app.
No silent trust on first use is allowed.
For suspected key compromise, also revoke old desktop devices and replace the
supervisor rescue key as described in [security](../SECURITY.md#authenticated-desktop-loopback-listeners).
Missing pins mean pairing is required, while expired certificates prompt clock
checks or rotation. A supervisor pin error leaves a healthy app visible and
clears after the next verified rescue request.

`npm run check:tls` is a Windows Electron runtime check. CI asserts matching
page, renderer HTTP/WSS, native `session.fetch`/`net.WebSocket` and rescue
transports, then swaps the listener's key on the same port and requires zero
HTTP application bytes, requests and upgrades. It also exercises Windows
`safeStorage`, explicit re-pinning and rejects credentials on rotation. This
check is not run in headless Linux; the regular Vitest socket checks run there.
The checks generate throwaway key pairs for each run and delete them afterwards;
no key material is committed, and the installer excludes the TLS check.

The window uses `persist:wayroost`. Before any window loads or socket opens, that
session gets one request-header hook (`installAppHeader`): every request to the
app origin and its WebSocket origin (page loads, the page's fetches and
WebSocket, the main process's `session.fetch`) carries
`x-wayroost-app: desktop`, the marker the server's local origin needs before it
accepts the device cookie. The hook runs for every URL and removes any existing
marker, regardless of header casing, before adding it only for those two origins.
This also strips the marker on requests redirected elsewhere. The rescue page's
session has no marker hook; `ServerClient.request()` also sets it itself.
The main process's `net.WebSocket` bypasses the session's webRequest hooks (on
Windows none of them is called for it), so `appSocketOptions` applies the same
rule to it explicitly: the socket is refused when the hook would cancel its URL,
and it carries the marker only to the app's WebSocket origin. The session's
certificate verifier still checks its TLS handshake before the upgrade request.
`npm run check:app-header` checks delivery on the wire in a real Electron run
(two local servers, the page, the main process and the rescue session), and that
the main socket's real failures (401, 403, 503, a server that closes before
answering, a server that is down) are handled as above; it runs on Windows
(the desktop CI job runs it), not in headless Linux checks.

Both `persist:wayroost` and the rescue page's session deny
every permission request, check and device request (`hardenSession`), except
clipboard writes from the app's own top frame. Packaged builds have no DevTools
and no application menu. The companion `/ws` connection runs in
the main process (Electron's `net.WebSocket`) with that partition's cookies
and the server origin, so toasts arrive while the window is closed or still
failing to load. Electron reports a refused upgrade only through that socket's
close reason, and no webRequest hook sees it, so the server client classifies
its own closes with the shared authentication classifier: an upgrade refused
with 401 or 403 (or redirected), or an authentication close (4401, 4403),
suspends approvals and toasts and stops reconnecting until a fresh identity
check or pairing succeeds. A failure before the socket opens keeps approvals
only when Chromium's reason positively names a network failure (connection
refused, reset or closed before answering, for example) or a 5xx refusal; any
other status, a certificate rejection, and empty or unrecognized text fail
closed the same way. A verified check then reconnects after the back-off, an
unpaired answer opens pairing, and any other answer keeps approvals suspended
while the check retries with its own back-off. Recognized network and 5xx
failures, and ordinary closes of an open socket, reconnect with back-off from
one to thirty seconds, reset once a socket opens. Until the
app page has loaded, the window reloads itself with back-off (2 to 30
seconds), so a sign-in start before the server is up recovers on its own.
Native socket approval updates are structurally validated before they can trigger
an authenticated snapshot refresh. Invalid payloads are dropped; three invalid
payloads on the same socket suspend its generation. Renderer data cannot answer approvals or supply toast
contents. Each toast's links carry a single-use 128-bit ticket held in the
main process; "Allow once" answers only with the unused ticket of the toast
that showed that exact approval (same source, conversation, id and creation
time). Any other `wayroost:` link, from a web page, a program or an agent,
only opens the card. A short confirmation follows each answer. A toast shows the
approval's detail (command, path, URL) under its sentence, and offers "Allow
once" only when that detail is shown whole: there is a detail (a toast with
only the agent-written title never allows), it is printable ASCII only (no
control, invisible, bidi or line-separator characters, no wide glyphs), its
estimated width fits one toast line (`TOAST_DETAIL_EM`, with conservative
per-character widths, in a two-line text element), and the server did not
truncate it; and the
approval has a once-only option (Hermes `once`; a Paseo option can't be
told from a provider action that reuses Paseo's `allow` id, so Paseo
approvals always get "Open" only). Everything else gets "Open" only. Notification IDs are remembered for the application run, including
across reconnects.

`DeviceRoutes` calls the server's `POST /api/pair { code, name }` and
`POST /api/presence { state: active | idle | locked }`. A desktop is a paired
device like any other. Authentication has three states owned by main: verified,
unverified, and unpaired. Only verified may display approvals, raise toasts, apply
snapshots, or send approval POSTs. Startup is unverified.
The server authenticates every request and owns authorization for mutations;
the desktop's authentication state controls its presentation and recovery.

Any anomalous authenticated HTTP request, app document or socket suspends work immediately:
non-success statuses, redirects (including fetch redirect errors), fetch or body
read failures, request deadlines, authentication socket closes, and unexpected
socket closes. Pending approvals, conversation metadata, notifications and tickets
are cleared before recovery. Ordinary native requests and renderer API/socket
requests remain blocked; the pairing page and its assets remain accessible.
Native requests have a ten-second deadline through body parsing. Chromium request
ownership also bounds renderer body reads and pairing attempts. Reloads cancel
old document cookie delivery while retaining current-generation authentication
losses and deadlines until main suspends that work or replacement pairing retires
it. App documents remain loadable during suspension so sign-in and pairing can
recover; document redirects and failures also suspend approvals.

Native and renderer approval snapshots share validation of nested options,
approval fields and conversation metadata before applying any part of the response.
Renderer conversation responses also validate their approval data before application.
Validation or presentation failures signal the owning generation to main, which
suspends work and clears approvals and tickets. Retired response failures cannot
suspend a newly checked session.

Recovery always uses a fresh native GET /api/me for the current pairing generation.
Its identity body has a two-second deadline and a 4 KiB limit. A verified desktop
identity restores work. Only an explicit 401 unpaired from that check opens pairing;
all other results keep work unverified and retry with one-to-thirty-second backoff.
Reloads cannot decide authentication. Preload replays main’s latest state into every
new document, and the renderer forwards anomalies without choosing a recovery state.
Suspension clears local state without echoing another signal to main.

Every native request, Chromium response, socket callback and renderer IPC belongs
to its initiating pairing generation. Starting a pairing attempt reserves a new
generation and aborts ordinary old work before replacement cookies can be accepted.
Delayed old socket closes, classifications and HTTP responses cannot retire or verify
the replacement. The cookie guard cancels stale responses and removes Set-Cookie
with any casing. Native and renderer pairing share one owner through body parsing;
query-bearing pairing requests use the same ownership rules. Encoded API prefixes
and pairing aliases are rejected; encoded conversation and approval IDs remain valid.
Failed pairing remains unverified until a current identity check succeeds.

Successful pairing also requires the native identity check before any approval work.
Verified recovery replaces the old renderer and takes a fresh snapshot. Old load
callbacks, tray entries and toast clicks cannot present or act on its approvals.
Before stopping the old window, main retires its request delivery and deadlines.
The resulting intentional `net::ERR_ABORTED` cancellations cannot suspend verified
recovery; queued failure statuses, redirects and other network errors still can.
The cookie guard records its own request and response cancellations and clears
their deadlines. Their `net::ERR_ABORTED` and `net::ERR_BLOCKED_BY_CLIENT` errors
are non-authentication events. Unowned cancellations, queued failure statuses,
redirects and other network errors retain their authentication-loss handling.
An explicit unpaired identity check opens the pairing page. If that document cannot load,
the bundled recovery page offers Open Wayroost, and the pairing document retries
with the same two-to-thirty-second back-off as the app page. A visible window
stays visible through recovery; closed and hidden starts stay in the tray. One
surface state controls window presentation. Approval links, toast clicks, tray
clicks and app activations reveal recovery while it is active, including when the
pairing document has already failed or recovery is still loading. Replacing the
renderer keeps that recovery active until a real app or pairing document loads.
Approval actions
retain their generation checks. These
document retries never resume native snapshots or sockets. Presence is
resent every five seconds while paired so unchanged active, idle or locked state
recovers after pairing or a server restart. Recovery asks for the saved
supervisor rescue key: the supervisor's install-time key, which
`deploy/install-supervisor.sh` shows once during supervisor installation. The
supervisor keeps only its hash and cannot print it again. This is separate from
a desktop pairing code, which comes from `sudo wayroost pair-desktop` on the PC
and requires a running Wayroost server; that command does not supply the rescue
key. The rescue key is checked against the supervisor's status route and
saved on its own, before and independently of server pairing, so rescue
works while the server is down. On first run without a key, the same page
opens as "Set up recovery" beside the working main window instead of the
"can't be reached" page. It does not invoke WSL or read credentials from the
live installation. The main process encrypts the key with safeStorage before
writing `rescue-key` in Electron's user data folder. It refuses unavailable encryption and Linux's plaintext backend.
The rescue listener uses `Authorization: Bearer <key>` and shared supervisor
routes. Its authentication failures concern the separate rescue credential and
never revoke the paired device. The normal page's preload sends tray update and
generation-bound suspension, owned response classifications, expiration and revocation signals, and receives native suspension.

M1 uses the existing icon as a placeholder mark. A toast, the tray and the
"Allowed once" confirmation name the role that asks and the request in the same
words as the approval's card (`shared/approval-card.ts`), from the conversation
the last authenticated snapshot carried. The card's risk only ever takes "Allow
once" away: a request it calls High opens the card instead. The tray badge
is a runtime bitmap layer. Tray health is the supervisor's status while the
rescue listener answers, made worse (never better) by the app's own
connection; without it (no rescue key yet, or the supervisor unreachable) the
app's own connection decides: socket open is "Wayroost is running.", a
dropped socket "Reconnecting", a failed page load "not answering". The
server's routine 30-minute socket recycle doesn't count as a drop. `overall`
takes priority over the pending approval count. Pause all agents is intentionally disabled.

`npm run typecheck`, `npm test`, and `npm run build` run without an Electron
window. `npm run dist` builds the unsigned per-user NSIS installer, also uploaded
by Windows CI. The packaged executable's Electron fuses turn off run-as-Node,
`NODE_OPTIONS` and the inspector arguments, and turn on embedded ASAR integrity
and ASAR-only loading (`build.electronFuses`); `npm run check:fuses` (part of
`npm run dist` and CI) reads them back from `release/win-unpacked/Wayroost.exe`.
Windows verification must cover installer execution, DPAPI,
sign-in, protocol registration, tray rendering, and notifications.
