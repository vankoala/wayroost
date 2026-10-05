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

The settings verbs use a separate root-owned `settings-targets.json`. Its
`configWrites` flag defaults to false and does not add fields to `supervisor.json`
or the component registry. Status advertises the three implemented verbs and a
directory check for each target, backup, audit and lock path. Launcher keys keep
the `server` scope for rollback compatibility; their access is restricted to
status, config reads and their catalogue applies.

Hermes observations call its installed environment and configuration loaders,
model resolver and approval resolvers with a fixed packaged Python program.
The supervisor runs it as the config owner in a transient unit with
`PrivateNetwork=yes`, a five-second unit limit, a three-second subprocess limit
and a 1 MiB JSON output limit. The interpreter refuses writes, process launches
and network operations; the unit exposes the filesystem read-only. The disposable
probe suppresses only Hermes' home-initialization and config-backup hooks before
calling its environment loader, config loader and value resolvers. Config
normalization and variable expansion remain in Hermes' installed runtime.
Configure the `hermes-config` target's `resolver` with its interpreter and import
root, for example `{ "python": "/opt/example/hermes/.venv/bin/python", "modulePath":
"/opt/example/hermes" }`. The resolver and module must pass the root-only trust
walk. Without this setting effective observations are unavailable.
Optional `resolver.home` supplies the owner's startup `HOME`; otherwise the owner
process's home is used. `HERMES_HOME` remains the config file's containing directory,
including for nested profiles.
Optional `resolver.environment` supplies approved non-secret startup variables;
Hermes' own environment loader handles dotenv decoding, interpolation and
precedence. `HERMES_MANAGED_DIR` can
be supplied there; a configured `hermes-managed` target selects its containing
directory. Every loader failure, exception, timeout or malformed output reports
`unavailable`, including failed reads for which Hermes supplies fallback values.
Reader and parser exceptions remain failures even when a later loader catches them.
Snapshot failures and unit failures use the same code.
Missing runtimes, unsupported housekeeping hooks and attempted writes also leave
effective observations unavailable. Dependent Checks rows remain unknown; persisted
YAML is never substituted for effective values. File hashes still refer to
persisted bytes for write preconditions. The separate `hermes.allowlist` view
supplies persisted command text for revocation; comparisons use the effective
`hermes.safety` output.

Agent availability uses the optional top-level `agentStatus` in this site file:
`{ "home": "/home/me", "runAs": { "user": "me", "uid": 1001 }, "binaries": {
"claude": "/home/me/.local/bin/claude", "codex": "/home/me/.local/bin/codex",
"copilot": "/home/me/.local/bin/copilot" } }`. The `wayroost.agents` view runs
fixed status-only probes as that owner with a read-only home and no public
network. The server's home isolation stays enabled. Only three installation and
authentication flags are returned; command output and account identities are
never returned.

Config requests use the schemas in `shared/supervisor-config.ts`. The supervisor
passes the validated request and site configuration over stdin to the packaged
`config-entry.js`, through `systemd-run --wait --pipe`, as the target's uid. No
parameter reaches command arguments or a shell. The writer has a private network,
strict filesystem protection, no new privileges and a 30-second runtime limit.
Only the target folder and its backup and audit folders are writable. Install the
compiled supervisor and its dependencies beneath root-owned directories; the
Node binary, entry point and optional consumer loader pass the executable trust
walk at each launch.

Provision each backup and audit directory as its target's owner with mode 0700
before enabling writes. Backup data lives beneath `backupDir/files`; this also
keeps the core's shared audit lock within the configured backup folder. The executor
retains ten backups per target; completed backups older than thirty days expire
under the target lock. The core's unfinished commit records pin its backups. The `file` lock path must be the target plus
`.wayroost-settings.lock`, pi's lock the target plus `.lock`, and Paseo's lock the
target plus `.wayroost.lock`. pi reads also take its mkdir lock, with a heartbeat;
this writer refuses an existing lock and does not reap pi's locks. Paseo shares
the existing flock implementation. Untrusted directories and mismatched owners
or modes return fixed codes before launching a write.

For Paseo, set the site's `loader` to the root-owned installed module exporting
`readPersistedConfig` from `@getpaseo/server`. Validation creates a private home
with `config.json` beneath the target's audit folder and calls
`readPersistedConfig(home)`. That loader strips removed fields before its strict
persisted schema; the protocol's mutable schema is not used for validation.
The private copy is removed after validation, and loader output is suppressed.
[Paseo's persisted loader](https://github.com/getpaseo/paseo/blob/v0.9.2/packages/server/src/server/persisted-config.ts)
defines that runtime interface.

Set `WAYROOST_PASEO_URL` to the daemon's loopback WebSocket address in the root
supervisor unit. If authentication is enabled, supply `paseo-password` through
systemd's `LoadCredential`; the supervisor reads it from `CREDENTIALS_DIRECTORY`.
Reload happens through the supported client after the isolated writer finishes.
The supervisor reads checked file snapshots before and after reload,
checks both content hashes against the committed write, and compares the view's
values with `getDaemonConfig` from the supported client. Restart-required or
override-controlled paths, differing effective values, outside saves, connection
failures and failed reloads return `outcome_unknown` with the target and backup
id. Provider entries removed by undo are checked against their effective
enabled defaults even when they no longer appear in the persisted view. If no
reload connection is configured, Paseo writes return `not_configured` before
launch. Tests inject the unit runner, consumer validator and reload adapter.

Each apply or undo launches exactly one transient writer unit. There are no
recovery units or owner receipts. A failure after the launch attempt, including
a launch error, timeout, lost or malformed result, core audit failure, failed
reload or supervisor audit failure, returns the fixed result
`{ ok:false, code:"outcome_unknown", target, backupId }`. The supervisor reserves
the backup id and saves it in the launch record before starting the unit. The
writer saves that rollback snapshot under the target lock before running the
core; it uses the reserved id for both success and failure results. The core's
temporary backup is removed after successful coordination. Lost output and
launch errors retain the reserved id, although the backup may not exist if the
unit never reached backup creation. That result makes no claim
about whether the write committed, and never exposes upstream text or values.
Preflight refusals before launch retain their specific fixed codes.

The target file's content hash is the source of truth. Before applying, retain
config.read's hash and the intended values. After `outcome_unknown`, call
config.read again: compare its values against the intended values and its hash
against the pre-apply hash. Intended values with a different hash show the
requested state is present; the pre-apply hash shows the original bytes are
present. Any other state needs reconciliation before another write. For undo,
compare against the token's backup and written hashes. An absent or unreadable
target, or intended values unchanged from the original state, cannot establish
that a particular unit completed. A read may precede a still-running unit's
completion, so keep checking until the state is settled. Retrying the same
request id returns its recorded result and never repeats the write or launches
a recovery unit; use a new id only after reconciling the file.

The supervisor records one strict, value-free row per unit launch attempt in
`config-audit.jsonl`, including `outcome_unknown`: caller, operation, target,
key names, any known backup id and hashes, and the fixed result. Private request
records bind request ids to caller and request digests before launch and persist
the result afterward. Reads also save launch metadata, without storing their
returned values. Success stays provisional until the audit append finishes;
pending metadata overrides a provisional log row after a failed append or save.
If a crash loses final success publication, the durable pending record still
prevents replay and identifies the reserved backup for hash reconciliation.
An interrupted request remains `outcome_unknown` without inspecting owner
storage. Request-record saves and log appends are attempted independently.
Once storage is available, reconciliation repairs missing rows
and replaces changed rows atomically, preserving one row per launch. No audit
or request record contains parameters or values. Undo must match the backup id
and hashes in the root-held audit, then the core checks the live file's hash and
the backup's actual bytes under the target lock. An outside edit is left intact.
Undo returns a reverse backup token on success. Failed executor output is
discarded; only one schema-checked JSON line is accepted.
Delayed applies are refused with `invalid_parameters`. Operations needing a role
catalogue or a required state record (move, restore or intended values) return
`not_configured` before launching until that executor is installed.

The Codex read-only view parses TOML and projects only the root approval policy
and sandbox mode. Forbidden control characters and bare carriage returns are
rejected throughout the document, including comments and multiline strings.
Read-only managed Hermes files may be owned by root with no
group or world write bits. Explicit drvfs reads also accept the documented
root:root 0777 shape; descriptor, symlink, hard-link, UTF-8 and size checks remain
in force. These policies never enable writes or change the reader's uid.
Failed transient units remain loaded until their systemd `Result` is captured;
`timeout` is captured before `reset-failed` collects the unit. Reads retain
the fixed timeout code; launched writes return `outcome_unknown`.

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
