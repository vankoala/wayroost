# Wayroost M1 install plans

These scripts install the supervisor and Wayroost server under an admin's control.
Development and tests run them only with `--dry-run`. They do not build from
source, use the legacy app's config/state, or change its units.

Build the artifacts in a root-owned checkout with Node 22 or newer before
the admin installs them:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run build:supervisor
npm run build
```

The supervisor installation plan uses the site's existing launcher and keeper paths:

```bash
bash deploy/install-supervisor.sh --dry-run --status-only \
  --components-file /opt/stack/components.json \
  --launch-script /opt/stack/launch.sh \
  --coder-script /opt/stack/launch-vllm.sh \
  --hold-dir /home/me/stack/logs
```

The supervisor runs both launchers as root, so they must live in a root-owned
place such as `/opt/stack`: the file, every folder above it and any symlink on
the way must be owned by root and not writable by group or others. A script
under your home folder does not qualify, even if the file itself is root's,
because you can rename the folders above it. The installer refuses such a path
(including one kept from an earlier `supervisor.json`), and the supervisor
checks again before every launch, so a launcher that changes later fails its
action instead of running. The same applies to the first word of every command
the supervisor runs, probes included: a health, busy or installed probe from
`components.local.json` whose program fails the check never runs, even in
status-only mode, and counts as no answer (a busy probe as busy). A launcher must also not source or run files your user
can write; the check covers only the launcher itself.

To install, the admin executes the same arguments as root without `--dry-run`.
The installer creates the `wayroost` socket group,
root-owned code, `/etc/wayroost` (0750), state (0700), config (0600), and the
supervisor unit (0644). Systemd creates `/run/wayroost` as root:wayroost (0750);
the supervisor creates its socket with mode 0660.

First installation needs an interactive terminal. Two keys contain 32 bytes
of entropy from `/dev/urandom`, encoded as hex. Only their SHA-256 hashes go in
`supervisor-keys.json` (0600). `server-key` (0600, root:root) contains the server's
raw key with no trailing newline. The desktop rescue key is printed once to
`/dev/tty`, bypassing stdout/stderr, and is never saved. Save it in the desktop
app's recovery form; pairing the desktop takes a separate code from
`sudo wayroost pair-desktop`. Terminal session recording should be off for this step.

Reinstalling preserves both keys and never prints the rescue key again. A
missing half of the key pair is an error; restore it or explicitly purge before
installing again. Launcher and hold paths merge with the existing supervisor
config. `--status-only` refuses every action, including diagnostics and rescue
restart. Status-only is the default, also in `supervisor.example.json`. To
enable actions, the admin re-runs the installer with `--enable-actions` to set
`statusOnly: false`.

The shipped [component example](components.example.json) uses invented model
names, ports and GPU indices. Supply your installed profiles, probe URLs, unit
names, user-unit owners and GPU assignments with `--components-file /absolute/path/components.json`.
For live installation, that source file and every directory along its path must
be owned by root and not writable by group or others, including directories
holding symlinks. Dry runs accept local fixtures without installing them.
The installer validates the full registry with the supervisor's schemas before
changing installed files, then atomically writes the validated snapshot to
`/etc/wayroost/components.local.json` as root:root, mode 0600 without reopening
the source. The supervisor repeats the schema and root-only path checks before
loading commands.
Without an operator file or an existing registry, installation writes the generic
example and forces status-only mode, even with `--enable-actions`. Reinstallation
preserves the installed entries; a registry that resolves to the generic example
keeps actions disabled regardless of formatting or key order. Registry files
remain local and are retained on removal.

The supervisor runs as root and uses `ProtectSystem=strict` with writable
exceptions for state and runtime. It deliberately omits `NoNewPrivileges`:
root still needs `systemctl` and `systemd-run`, whose transient actions run
outside the supervisor's filesystem namespace.

The server installation plan is:

```bash
bash deploy/install-wayroost-server.sh --dry-run
```

The server gets its own code tree `/opt/wayroost/server`, config
`/etc/wayroost/config.json` (0600), and `wayroost-server.service`. Its config is
always normalized to `role: "shadow"`, `127.0.0.1:8881`, state
`/var/lib/wayroost-shadow` (the server refuses a shadow in a primary-owned
directory such as `/var/lib/wayroost`), and web assets under its own code tree.
Bridge, helper and feed are disabled. The unit also sets `WAYROOST_ROLE=shadow`,
uses DynamicUser and StateDirectory `wayroost-shadow` (0700), and joins the
socket group. The installer also installs `/usr/local/sbin/wayroost` (root, 0750):
`sudo wayroost pair` prints a single-use code for a phone and `sudo wayroost
pair-desktop` one for the desktop app, through the running server's recovery
socket and with `/etc/wayroost/config.json`; it takes no paths from its caller.
Systemd supplies these credentials:

| Credential name | Source | Consumer path |
| --- | --- | --- |
| `supervisor-server-key` | `/etc/wayroost/server-key` | `$CREDENTIALS_DIRECTORY/supervisor-server-key` |
| `config.json` | `/etc/wayroost/config.json` | `%d/config.json`, selected by `WAYROOST_CONFIG` and M1's `SIGNALBOX_CONFIG` fallback |
| `paseo-password` (when its protected source exists) | `/etc/wayroost/paseo-password`, or `--paseo-password-file` | `$CREDENTIALS_DIRECTORY/paseo-password` |

Generated config includes `https://127.0.0.1:8881` and `https://127.0.0.1:8883`
in `origins` and enables device pairing, while retaining the public HTTPS origin,
Access and any other configured origins. The main listener on 8881 serves the
tunnel and phones; the desktop uses the local listener on 8883. Local pairing
still requires the desktop app header.

Re-installing an older config without `localListener` adds
`{ host: "127.0.0.1", port: 8883, pcOnlyWrites: false }`. An existing local listener
is preserved, including its port and write policy; the installer never enables
PC-only writes. Older desktop pins without a local port default to 8883. After
installing and starting the server with the local listener, obtain a fresh
`sudo wayroost pair-desktop` token and pair again to save the port and pin its TLS.
Keep production `pcOnlyWrites` false until the
[live desktop check](../docs/settings-rollout.md#desktop-listener) passes.
The password source must be root-owned, mode 0600, under a protected directory.
Its contents are never copied into JSON or printed by the installer. A plain
dry run does not examine host files; fake-root checks use invented fixtures.

For the API-only worker approval setting, the admin can also plan the owner
helper with explicit owner and config arguments:

```bash
bash deploy/install-wayroost-server.sh --dry-run \
  --safety-owner demo-owner --safety-paseo-config /home/me/demo-paseo/config.json
```

The built server includes `safety-helper.js`. The helper unit runs as the
Paseo owner, with a writable exception for that config's directory, its own
state/runtime directories, and `ProtectHome=read-only`. The web server retains
`ProtectHome=yes` and `DynamicUser=yes`. Systemd supplies `safety-helper-key`
to both units and `safety-helper.json` to the owner helper. If present, the
Paseo password credential also reaches the helper under `paseo-password`.
It serves the shadow server, so its unit sets `WAYROOST_ROLE=shadow`: it changes the
owner's Paseo config only when a paired desktop changes the setting, never
at startup or on its own timer. Status reads are pure in both roles. At cutover,
change the Safety companion's separate role override to primary to enable
startup/timer reconciliation; see [cutover](../docs/shadow-cutover.md).
Reinstalls retain the helper connection and shared key. Supply explicit owner,
config and custom password arguments again when updating the helper unit.
Server removal stops the helper but retains its setting, undo record and key;
it never removes or undoes the owner's Paseo config. The helper uses the system's
`/usr/bin/flock` to serialize Wayroost config writers, retries changed revisions,
and verifies both the resulting file and daemon policy before confirming. Config
conflicts stay pending and keep their undo backup. Cloud-agent switches also
require this helper; the web server does not patch the Paseo config directly. See
[worker approvals](../docs/worker-approvals.md) for API status and coverage limits.

The unit can read its config without granting the dynamic user access to the
root-only key directory. The first server install writes the example with
`YOUR-` placeholders and leaves the unit stopped. The admin fills in this
Wayroost config directly and re-runs the installer; no legacy config is
read or copied. Updates always force the shadow address, state path and role.

The generated config also points the server at the supervisor's socket,
`/run/wayroost/supervisor.sock`. The server takes the supervisor key from the
`supervisor-server-key` credential, never from a key file named in this config.

The merged server validates and enforces the effective role, and rejects
shared state before constructing stores or listeners. Reinstalling forces
shadow config and units; repeat the coordinated [cutover](../docs/shadow-cutover.md)
changes before primary operation.

Removal plans are:

```bash
bash deploy/install-supervisor.sh --dry-run --remove
bash deploy/install-supervisor.sh --dry-run --remove --purge
bash deploy/install-wayroost-server.sh --dry-run --remove
```

Removal stops/disables the named Wayroost unit before deleting its code,
config and state. Supervisor removal preserves both key files unless `--purge`
is explicit. Server removal also deletes DynamicUser's private state directory,
and preserves supervisor keys. Shared directories are removed only when empty;
the socket group is removed only after both Wayroost units are absent and it
has no members. Local registry overrides are admin-owned and stay in place.

Both installers generate independent ECDSA P-256 self-signed certificates with
SANs for `127.0.0.1` and `localhost` and ten-year validity, using Node’s built-in crypto without additional packages.
`server-tls-key.pem` and `supervisor-tls-key.pem` are root:root, 0600; certificate
files are public 0644 inside the protected config directory. The units supply
`loopback-tls-key` and `loopback-tls-cert` through `LoadCredential`. Keys never
enter installer output; only SHA-256 SPKI fingerprints may be printed. Reinstall
retains pairs and refuses an incomplete pair. Dry runs generate no key material.

Installed configs use TLS on main port 8881, desktop local port 8883 and
supervisor rescue port 8880. Both server listeners share the server certificate.
Root's `sudo wayroost pair-desktop` prints a combined token with the pairing code and
the local listener port and both fingerprints. Paste it into the desktop's bundled
recovery form. Save the separate supervisor rescue key and fingerprint there for recovery.
`sudo wayroost fingerprints` prints both public fingerprints from installed
certificate files even when the server is down. Never take a fingerprint from
the live listener.

Explicit root rotation is `sudo wayroost rotate-tls server` or
`sudo wayroost rotate-tls supervisor`; it replaces that service's certificate
and key and restarts only its own unit. Obtain a fresh token with
`sudo wayroost pair-desktop` and pair again. Certificates survive removal,
like saved credentials, until explicitly rotated or removed by the admin.
After suspected key compromise, revoke every old desktop device in Settings →
Devices & access → Devices after server rotation and re-pairing. For supervisor
compromise, root must replace the `desktop-rescue` SHA-256 entry in
`/etc/wayroost/supervisor-keys.json` with the hash of a newly generated 256-bit
rescue key, preserving the server entry, then restart the supervisor and save
the new key and token in the desktop. Keep that key out of logs.
Certificate rotation alone leaves device cookies and the rescue key valid.
See [configuration](../docs/configuration.md#loopback-tls) for the HTTPS tunnel
backend and origin CA at cutover. Never set `noTLSVerify` to bypass TLS.

Run the safe installer checks with `bash tests/deploy-dryrun.sh`. They are also
included in Vitest. `--root /fake-root` is strictly test-only: it requires
`--dry-run`, prefixes all planned disk destinations, and never redirects a real
installation. A bare dry run uses templates instead of reading host config or
keys. The checks stub out host-changing commands and confirm the fake root's
files are unchanged; shellcheck runs if it is installed.
