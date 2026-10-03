# Supervisor core

The supervisor runs fixed verbs on registry components only. It never takes a
command line, a path or a shell string from a caller. In adopt mode it calls
the existing launcher and systemd; those stay the source of truth until M4.

Run `npm run supervisor:dev` in this clone. It prints a Unix socket path and
separate server/rescue development keys, flips fake component states on a
timer, and never executes systemctl, systemd-run or the built-in registry
commands. Only 127.0.0.1:8898 is bound; state lives in a temporary directory
within the clone and is removed on SIGINT/SIGTERM.

```bash
curl --unix-socket <printed socket> -H "Authorization: Bearer <server key>" \
  http://localhost/v1/status                                    # server key, socket only
curl http://127.0.0.1:8898/v1/status \
  -H "Authorization: Bearer <rescue key>"                       # rescue key, status + restart wayroost-server
curl -X POST --unix-socket <printed socket> \
  -H "Authorization: Bearer <server key>" \
  -d '{"paseoRunning":0,"hermesRunning":0,"calls":0}' http://localhost/v1/busy
```

## Routes

- `GET /v1/status` — every component: state, plain sentence, since, details;
  plus the running action, the whole-PC `busy` state and any components that
  are `notSetUp` (left out of status with "Not set up on this PC.").
- `GET /v1/events` — Server-Sent Events: `status`, `action` and `line` frames
  for server keys; rescue keys receive only `status` frames, with no action output.
- `POST /v1/actions` — `{ verb, target, profile?, when? }` → `{ actionId }`,
  or 409 with the action already running. Actions run as
  `systemd-run --unit=wayroost-act-<id> --property=CollectMode=inactive
  --property=KillMode=process --wait --quiet` with
  `StandardOutput=append:<log>` and `StandardError=append:<log>`, then the fixed
  argv after `--`. `KillMode=process` keeps a server that a launcher leaves
  running in the background (as `launch-vllm.sh` does with `nohup … &`) alive
  after the launcher exits; with the default `control-group` mode, systemd would
  kill it when the action unit stops. As when the launcher runs from a terminal,
  such a server is then managed by the launcher (its pidfile and `stop` verb),
  not by the action unit. Output goes directly to `actions/<id>.log` and is tailed for
  progress. A supervisor restart cannot close the launcher’s output pipes.
  Metadata is atomically written and synced to `actions/<id>.json` before
  acceptance and execution. Startup reconciles all `wayroost-act-*` units
  before binding either listener, restoring their lifecycle locks and caller
  metadata. Interrupted actions and outcomes lost when a unit is collected are recorded
  as failed; they are never replayed. Manager failures keep the lock until a
  successful probe confirms the unit stopped. Shutdown (SIGINT/SIGTERM) ends
  the supervisor's local waits and polls at once and sends SIGTERM to the
  local `systemd-run --wait` client's process group only (the unit's processes
  belong to systemd, not to that group); a launched action keeps running in
  its unit and is reconciled at the next start. The same holds for actions
  recovered at startup: shutdown ends their in-flight `systemctl show`,
  `list-units` and `reset-failed` queries (and a running diagnostics action's
  queries) without waiting for them, and records nothing for those actions.
  When an idle wait, a launch preparation or a diagnostics action ends (on
  shutdown or at the idle deadline), the busy, live-profile and health probes
  it started end with it: their HTTP requests are aborted and their commands
  end with their whole process group (SIGTERM, then SIGKILL after 0.5 s), so a
  shell probe's subprocesses go too, even if the parent exits and descendants
  have redirected their output. An aborted command's wait settles within
  1.5 s even if a descendant left the group and still holds its output. Once
  aborted, the runner spawns nothing more. Status collections (`GET
  /v1/status`, an event stream's first status and its poll) end the same way
  when their client leaves, and on shutdown before the listeners close: a
  request still waiting then gets 503 with `Connection: close`. Incomplete
  uploads to `/v1/actions` or `/v1/busy` are destroyed on shutdown, and any
  remaining HTTP connections (including incomplete headers) are closed.
- `GET /v1/actions/:id` — state, progress lines, result. `diagnostics` returns
  one JSON object: versions (node, supervisor), and per component the unit
  state and health result. Never log contents.
- `POST /v1/busy` — server key only, on the socket. The Wayroost server pushes
  `{ paseoRunning, hermesRunning, calls }` every ~10 s. Busy is any count above
  zero; counts older than `busyStaleMs` (default 60 s) are unknown, which
  `when: "idle"` treats as busy but never waits past `idleLimitMs` on. The
  deadline covers the whole wait up to the launch: probing the live profile,
  the ownership check and creating the log must also finish before it. The
  production runner checks `systemd-run` itself before spawning it, so the
  deadline and shutdown are checked again inside the runner, after that check
  and with nothing awaited before the spawn; a refusal there launches nothing.

Keys are 256-bit random, stored as SHA-256 hashes, compared in constant time.
A `server` key works on the Unix socket only and may call every verb; a
`rescue` key works on the TCP listener and may read status/events and restart
`wayroost-server` only.

## Configuration

Production configuration is strict JSON, selected by `WAYROOST_SUPERVISOR_CONFIG`
(default `/etc/wayroost/supervisor.json`): `socket`, `rescueHost`, `rescuePort`,
`keysFile`, `stateDir`, `registryOverrides`, `idleLimitMs`, `pollMs`,
`busyStaleMs`, `statusOnly` and `adopt`.

With `statusOnly: true`, status and events remain available, component
action lists are empty, and every action verb (including diagnostics and the
desktop rescue restart) is refused with HTTP 403 before it can queue or write
an audit record. It defaults to true; development explicitly opts into actions.
The installer and [shipped example](../deploy/supervisor.example.json) also
default to status-only. Enabling actions requires `--enable-actions`.

The built-in registry in `registry.ts` uses invented profiles, ports and GPU
indices. The [generic example](../deploy/components.example.json) matches it.
Production loads the root-owned `registryOverrides` file and checks its entire
path before accepting commands; missing or untrusted installed files fail startup.
The installer supplies this file, retaining status-only mode until an operator
provides the installed layout. Components that
talk to the site's launcher take their commands from `adopt`:

```json
{ "adopt": { "launchScript": "/path/to/launch.sh", "coderScript": "/path/to/launch-vllm.sh", "holdDir": "/path/to/logs" } }
```

- `main-model` needs `launchScript`: start/restart launch its default profile,
  stop runs `stop-model`, and `switch-model` runs the launcher with the profile
  id. Each profile answers on its own health URL; the live profile is the one
  that answers, and none answering means down or starting.
- `paseo` needs `launchScript` and `holdDir`: start and restart take the safe
  `restart-paseo` path; the hold file is `<holdDir>/paseo-hold`. Stop is omitted
  and refused until an admin provides a genuine stop argv.
- `coder` needs `coderScript` and `holdDir`; the hold file is
  `<holdDir>/coder-hold`.
- While what a component needs is unset it stays out of `status.components`,
  appears under `notSetUp` with "Not set up on this PC." and refuses actions
  with the same sentence.

Unit-backed components carry `unit: { name, scope, user? }`. With scope
`system` the argv is `systemctl <verb> <name>`; with scope `user` it is
`systemctl --user -M <user>@ <verb> <name>`. User units require an owner;
without one they remain not set up and are not probed or acted on.
Health probes and start/stop/restart argv are derived
from the unit unless an entry gives its own.

`components.local.json` (path `registryOverrides`) adds or overrides entries
with the same shape, merged field by field by id. All commands are argv
arrays. Profile overrides merge before adopt argv is derived; explicit argv
remains authoritative. Optional unit components get a separate installation
probe, so an installed but stopped phone remains visible with its Start action.
Only an explicit absence hides it (`show` answering LoadState `not-found`). A
query that fails, for example while the owner's user manager is unavailable, and
any other LoadState (`masked`, `error`, `bad-setting`) leave it visible. A local
optional component may provide its own `installed` probe; with `expect` set, only
its `absent` line (if given) means absent, and a non-zero exit, no output or any
other line means unknown. An HTTP `installed` probe is absent only on a 404;
other error statuses and connection failures are unknown.
`keysFile` is an array of name/scope/sha256 records.

Hold and release run the packaged hold helper in their transient unit. It
anchors each directory with open file descriptors, uses `O_NOFOLLOW`, refuses
symlinks and nonregular files, and unlinks only through the anchored directory.

Only the latest 200 output lines (at most 4096 characters each) and 100
completed actions stay in memory. Older details are read from disk with a
bounded log tail. SSE action/status frames contain summaries; each stream
waits for `drain` and retains at most 256 KiB, including Node’s pending writes.
Clients that exceed that limit are disconnected. Socket startup removes only
a stale socket owned by the supervisor after checking it is inactive; live
sockets, symlinks and regular files are refused.

One JSON line per action goes to `audit.jsonl` (id, time, caller, verb, target,
profile, outcome) — never key material, never action output. Before appending,
recovery truncates an invalid unfinished final row or adds the missing newline
to a complete row, preserving earlier records. The id makes audit recovery
idempotent across restarts. Version metadata is packaged in the
emitted supervisor build.

Build with `npm run build:supervisor`; the entry point is
`dist/supervisor/supervisor/src/index.js`. The deploy unit assumes that tree
is copied under `/opt/wayroost/supervisor`. The admin installer and rollback
plans are described in [deploy/README.md](../deploy/README.md); no service is
installed by a build or test.

For a checkout restricted to assigned development ports, run the full suite with
`TMPDIR="$PWD/.test-tmp" WAYROOST_TEST_PORTS=8898,8899 npx vitest run` after
creating `.test-tmp`. This opt-in guard assigns ephemeral fixtures to the two
allowed ports and runs files sequentially; it never chooses a live port.

Some tests check the root-ownership rule against real system files (`/`,
`/usr/bin`, `true`, `sleep`, `systemctl`), so the suite expects them to be owned
by root, as on a normal Linux install or a CI runner. In a sandbox that maps
them to another uid, those cases fail by design.


Installed rescue listens on **HTTPS** at `127.0.0.1:8880`. Its independent P-256
certificate and root-only private key are created by `install-supervisor.sh`
and delivered through `LoadCredential`; the Unix socket remains HTTP over a
protected filesystem socket. Only `supervisor:dev` (explicit `development: true`)
uses plain loopback HTTP. Save the public SPKI fingerprint with the install-time
rescue key in the desktop recovery form. A key alone cannot authenticate the
listener. Rotate with `sudo wayroost rotate-tls supervisor`, then use a fresh
`sudo wayroost pair-desktop` token to re-pin. See [security](../SECURITY.md#authenticated-desktop-loopback-listeners).
`sudo wayroost fingerprints` reads the installed public certificate files even
with the server down. Never take a fingerprint from the live listener.
For suspected key compromise, also replace the rescue key following the security
instructions; certificate rotation alone leaves it valid.
