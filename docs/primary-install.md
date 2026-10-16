# Installing a primary runtime

The runtime, owner helper and explicit server installer publish into Wayroost
paths beside a retained Signalbox installation. They share `plan`, `forward`,
`verify` and `reverse` modes. The default mode is `plan`. Production runs require
root; `--root /absolute/fake-root` confines filesystem publication and every
systemctl call to an offline test root. It is not a live deployment option.

All path arguments are normalized once when parsed: repeated slashes (including
a leading `//`), `.` components and trailing slashes become one absolute path
with a single leading slash. Parent traversal (`..`), control characters and
symlinked ancestors are refused. Publication and receipt paths use that canonical
identity. Paths rendered into units and drop-ins use the canonical logical
destination; under `--root` they name the path production would use, while
receipts record its location inside the fake root.

The existing server invocation without new flags retains its original shadow
installation behavior, including enablement and restart. Use the explicit modes
below for primary installation or artifact updates.

## Prepare artifacts as an unprivileged user

Build with Node 22 or newer. Install dependencies and run builds as your ordinary
user, before invoking an installer. The explicit installers never invoke a
package manager, run prepared code or build anything as root.

Production also requires the installer scripts, shared deployment libraries,
unit and CLI templates and every ancestor directory to be owned by root and not writable
by other users. Place reviewed installer files in a protected installation tree
before invoking them. This trust check is separate from artifact verification:
the prepared `--from` directory may remain owned by the unprivileged builder,
with its contents pinned by the independently retained manifest digest.

A prepared runtime directory contains:

```text
SHA256SUMS
bin/signalbox-bridge.mjs
bin/signalbox-claude-hook.py
bin/signalbox-helper.py
bin/signalbox_mail_trigger.py
bin/signalbox_skills.py
bin/wayroost_runtime.py
```

Copy the bridge from `bridge/`, the hook from `claude-hook/` and the four Python
helper files from `helper/`. These files use Node and Python standard libraries;
the helper's connector subprocesses use the owner's existing environment.
Any additional runtime dependencies must be prepared under `bin/` and included
in the manifest. Do not include a role file: the installer generates it from
the required `--role primary|shadow` flag.

A prepared server directory contains `dist/server/`, `dist/web/`, `package.json`,
the production `node_modules/` tree and optionally `package-lock.json`. Include
all dependency files. Prepare a copy with symlinks dereferenced, including npm's
`.bin` entries; installers refuse symlinks in source and destination paths.
Do not include caches, credentials, development dependencies or unrelated files.

Generate a manifest in each prepared directory as your ordinary user:

```bash
cd /home/me/wayroost-build/runtime
find bin -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum SHA256SUMS
```

For the server, use `find dist node_modules package.json package-lock.json`
instead of `find bin`, omitting `package-lock.json` if it is absent. Each entry
has a lowercase SHA-256 digest, two spaces, then a relative file path. All files
must be listed exactly once, except `SHA256SUMS` itself. Supply its trusted digest
with `--manifest-sha256`; the installer checks both the manifest and every file
before publication. Manifest paths follow the same traversal and control-character
restrictions as command-line paths. Retain that digest independently of the
prepared directory.

## Runtime

The default prefix is `/opt/wayroost/runtime`. All runtime files are published
under `bin/`, with their existing filenames. The role file is
`bin/wayroost-role.json`. There is no implicit runtime role and no service action.

```bash
sudo bash deploy/install-wayroost-runtime.sh --mode plan \
  --from /home/me/wayroost-build/runtime --manifest-sha256 "$RUNTIME_DIGEST" \
  --role primary --receipts /var/lib/wayroost-install/receipts --receipt runtime-release
```

Repeat with `--mode forward` and the same arguments to publish. Use `--prefix`
to choose another absolute prefix. Legacy `/opt/signalbox`, `/etc/signalbox` and
legacy state destinations are refused, including paths reached through symlinks.

## Owner helper

The helper unit uses the configured non-root owner, the runtime's role file and
the helper's loopback-only listener. Its default port is 19013. The operator
provisions a credential file separately; the installer references its path
through `LoadCredential=token:` without reading, copying or generating its bytes.
Production requires an existing regular source file and directory ancestors,
all owned by root and not writable by other users. Symlinks are refused anywhere
in the source path. These checks inspect metadata only and leave the source intact.

Install the runtime before setting up the production helper. Its executable,
imported modules, mail gate, role file and all other files under `bin/` must be
regular files owned by root and not writable by other users. Runtime directories
and their ancestors must also be root-owned and protected; symlinks are refused.
The installer checks the runtime during preflight and again immediately before
an explicitly requested start.

```bash
sudo bash deploy/setup-wayroost-helper.sh --mode plan \
  --owner demo-owner --home /home/me --hermes-home /home/me/.hermes \
  --token-file /etc/wayroost/helper.token --port 19013 \
  --receipts /var/lib/wayroost-install/receipts --receipt helper-release
```

Repeat with `--mode forward` to install the unit. Add `--enable` to enable it and
`--start` to start it. Neither action is implicit. `--home` defaults to the
owner's passwd home and sets the helper's `HOME`, keeping Linux skill directories
under the selected writable home. `--hermes-home` defaults to `<home>/.hermes`.
The runtime prefix uses `--prefix`; the unit directory uses `--unit-dir` and
defaults to `/etc/systemd/system`. Helper and server units may also use
`/run/systemd/system`, `/usr/local/lib/systemd/system` or `/usr/lib/systemd/system`;
other directories are refused because the units must be discoverable through
systemd's [system unit search paths](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html).
An existing unit or mask in a higher-priority search directory prevents publication.
Retries, verification and activation check that the selected unit path still takes
precedence. Remove the conflicting override separately before proceeding.
The sandbox retains all the original helper's protections and writable paths,
and adds a restrictive umask. The original helper
and its drop-ins are never changed.

Unit paths must omit whitespace, quotes, backslashes, colons, percent signs and
dollar signs. Template markers supplied inside paths are preserved literally.

Enablement publishes a receipted link in `/etc/systemd/system/multi-user.target.wants/`,
including when the unit uses another supported directory. Undo
restores or removes that link after checking its canonical destination and owner;
it does not invoke a broad `systemctl disable` operation.

To translate selected environment settings, add both flags:

```bash
  --drop-ins /etc/systemd/system/signalbox-helper.service.d \
  --allow-environment SIGNALBOX_SHOP_CDP,SIGNALBOX_SKILLS_WINDOWS_HOME
```

Only `[Service]` `Environment=` assignments for those keys are translated into
`wayroost-helper.service.d/50-imported-environment.conf` (0600). Later source
files override earlier ones. Empty Environment assignments reset the selection.
An explicit translation with no selected assignments replaces an existing import
with an empty drop-in; reversal restores its previous bytes.
Other directives, including `EnvironmentFile`, are ignored. The installer never
copies execution directives or reads environment files. Role, port and home
keys controlled by the installer cannot be overridden through translation.
Plans and receipts contain only selected key names and value hashes. Values
appear in the installed drop-in, never stdout, stderr or JSON receipts. A
translation accepts systemd quoting and C escapes, including `\s`, `\xHH` and
Unicode escapes. Unsupported escapes, shell-style partial quoting and dynamic
systemd specifiers are refused. Literal percent signs use `%%` in source
assignments. Hashes describe the decoded values delivered to the helper.
Hexadecimal and octal escapes represent bytes, which must form valid UTF-8;
Unicode escapes represent characters.

Continuation lines join only after an odd number of trailing backslashes, with
the final backslash replaced by a space and the next line's indentation retained.
A blank or whitespace-only line ends the continuation. Comments inside a
continuation are refused.

For a selected Windows home, explicitly grant write access to each required
skill root as well:

```bash
  --writable-path '/mnt/c/Users/Demo User/.agents/skills' \
  --writable-path '/mnt/c/Users/Demo User/.claude/skills'
```

Each path must be one of `.agents/skills`, `.claude/skills`, `.codex/skills`,
`.pi/agent/skills`, `.config/opencode/skills` or `AppData/Local/hermes/skills` under the imported
`SIGNALBOX_SKILLS_WINDOWS_HOME`. The installed drop-in grants `ReadWritePaths`
only for the explicitly selected roots, tolerating roots that do not yet exist.
Referenced skill roots may be owned by the helper user. They retain containment
and symlink checks; published unit files still require protected parent directories.
Source `ReadWritePaths` directives are never copied. Plans and receipts expose
only the drop-in hash, preserving the same value redaction as Environment
translation. Without `--writable-path`, translation grants no additional writes.

## Server

An artifact update leaves installed config and units byte for byte intact:

```bash
sudo bash deploy/install-wayroost-server.sh --update-artifacts --mode forward \
  --from /home/me/wayroost-build/server --manifest-sha256 "$SERVER_DIGEST" \
  --receipts /var/lib/wayroost-install/receipts --receipt server-release
```

To publish primary config and unit as well, add `--primary --publish-unit
--publish-config --config-source /home/me/wayroost-build/primary.json`. The
prepared config must already declare `"role":"primary"`; it is published
verbatim, mode 0600. `--role shadow` is also available for explicit shadow
publication. `--config-path` defaults to `/etc/wayroost/config.json`.

Primary publication (`--primary` or `--role primary`) also publishes
`/usr/local/sbin/wayroost`, mode 0750, from the protected `deploy/wayroost.sh`
template. Add `--publish-cli` to an artifact update to refresh the CLI explicitly:

```bash
sudo bash deploy/install-wayroost-server.sh --update-artifacts --publish-cli --mode forward \
  --from /home/me/wayroost-build/server --manifest-sha256 "$SERVER_DIGEST" \
  --prefix /opt/wayroost/server --config-path /etc/wayroost/config.json \
  --receipts /var/lib/wayroost-install/receipts --receipt server-release
```

`--publish-cli` is also accepted with explicit primary publication. The wrapper
includes `hold`, `release` and `quiet`, plus the pairing and certificate commands.
It uses Node selected from the invocation's PATH, `<prefix>/dist/server/pair-code.js`
and `--config-path`; repeat custom paths when updating. Select the intended Node
executable in PATH before invoking the installer. Production checks its trusted
ownership and Node version (22 or newer).

A role-less `--update-artifacts` without `--publish-cli` preserves the wrapper's
bytes, metadata or absence. CLI publication never discovers a role or executable
from installed units, drop-ins, environment files or masks. Explicit shadow
publication keeps its existing behavior; `--role shadow --publish-cli` is refused.
Publication paths still refuse symlinks.

The wrapper is an atomic, receipted publication. Plan leaves an older wrapper
intact or a fresh path absent; verify checks the published wrapper, and reverse
restores its exact prior bytes, ownership and mode or removes a newly installed
wrapper. Wrapper publication does not enable or restart any service.

The primary unit declares `WAYROOST_ROLE=primary` and `StateDirectory=wayroost`.
It retains the template's sandbox and any installed base unit's optional
`LoadCredential` and `SupplementaryGroups` directives, including optional Paseo
authentication, helper credentials and local speech socket access. The
`config.json` credential always uses the selected `--config-path`. Unit publication
retains an installed Node executable path, or selects Node from PATH for a new
unit. Production validates its ownership, ancestors and Node version (22 or newer).
Executable and config paths follow the same unit-path restrictions as the helper.
Existing drop-ins stay in
place. This installer
does not generate credentials, change owner settings, install auxiliary services
or create service state. Provision its referenced credentials and socket group
before starting it. Add `--enable` for enablement or `--restart` for restart.
Enablement requires an existing unit or explicit `--publish-unit`.
Without these flags, it performs neither action. Artifact-only updates do not
even reload units; explicit unit publication performs `daemon-reload`.

## Receipts, recovery and reversal

The receipt directory is 0700 and each JSON receipt is 0600, owned by root.
Offline tests use the invoking user's ownership with the same private modes.
The receipt records each published file and newly created directory, old and
new hashes, modes, numeric owners, enablement links and unit enablement state. It contains no
file contents or environment values. Opaque originals needed for undo are
stored separately in the sibling `<receipts-directory-name>-undo/<receipt-id>/`
directory (0700, with 0600 copies). Keep both stores protected until undo is no
longer needed. Plans create receipts but do not change publication targets.
Publication targets must stay outside both stores and the deployment lock,
including their pending files. Names matching `.wayroost-<32 lowercase hex digits>`
are reserved for transaction temporaries. Overlap checks treat single and double
leading slashes as the same filesystem root without following symlinks.

Reuse the same receipt id and forward arguments after an interruption. Already
published bytes and metadata are accepted; changed inputs or unexpected target
changes are refused. File replacement is atomic and the journal is saved before
publication. Publication, undo and reverse temporary paths are reserved in the
journal before creation. Recovery removes only those identified temporaries
after checking their type, ownership and permissions. All installers share
`/var/lib/wayroost-install/.deployment.lock`, independent of the selected receipt
store, so overlapping forward and reverse runs serialize. Directory ownership
and modes are applied explicitly, including beneath setgid parents. Full
receipts are saved at transaction state transitions rather than after each file.
Completed forward runs require every publication and enablement state to still
match the receipt, and do not repeat service actions. A crash
during a service action can require repeating that explicitly authorized action.

Enablement targets are recorded and compared by their canonical destination,
including absolute and relative spellings. Reversal retains the original link
spelling when restoring a pre-existing link.

Verification and reversal need only the receipt and its store. They validate
against the canonical prefix recorded in the receipt, independent of the default
prefix or a supplied `--prefix`. Earlier receipts with equivalent slash spellings
are normalized on loading; matching directory entries are merged. Conflicting
entries are refused before publication changes.

```bash
sudo bash deploy/install-wayroost-runtime.sh --mode verify \
  --receipts /var/lib/wayroost-install/receipts --receipt runtime-release
sudo bash deploy/install-wayroost-runtime.sh --mode reverse \
  --receipts /var/lib/wayroost-install/receipts --receipt runtime-release
```

Use the corresponding helper or server script for their receipts. Reverse
preflights every receipted path and undo hash, then restores original bytes,
ownership and permissions or removes newly published paths. A hand edit,
metadata change or unreceipted addition prevents reversal. An interrupted
reverse also resumes from its journal. Reverse never starts, stops or restarts
services. If forward changed enablement, reverse requires `--enable` to restore
it. Coordinate running writers and service activation separately.
