# Settings rollout

The server reads `rollout` from its site config, normally `/etc/wayroost/config.json`:

```json
"rollout": { "settingsPages": false, "revokes": false, "chatFirst": false }
```

Every absent switch defaults to false. Keep all three off while the server runs as a shadow and while devices are being paired. Installing supervisor config verbs enables reads without exposing later settings writes. A primary server still refuses writes until the relevant switches are enabled.

When you are ready to allow settings changes, enable `settingsPages`. Until then, the settings pages show current values and Checks, with site-setting write controls disabled. Settings write routes, including their older paths, refuse with `not_rolled_out`. Refreshing Checks remains available. Other authorization, primary-role and PC-only gates still apply after rollout.

Device notifications are per-device actions and are not gated by `settingsPages`: subscribing, unsubscribing and **Send a test**
remain available on read-only pages. Existing browser subscriptions are
re-registered with the server even when settings writes are disabled, so pairing
or a server reinstall can restore delivery.

To allow command revocation and skill staging, enable `revokes`. Both also require `settingsPages`. Turning either switch off closes the corresponding apply and undo paths. To make the basic new-chat box the default, enable `chatFirst`. When it is off, Advanced opens by default; Basic remains available. A device's saved Basic or Advanced preference wins over the site default, and blocked browser storage uses the site default.

Restart the server after changing its site config to flip a switch. Turning switches off restores read-only settings or the Advanced default without removing current values or device preferences.

## Desktop listener

The main listener stays on `127.0.0.1:8881` for the tunnel and phones. The desktop uses a separate local listener:

```json
"listen": { "host": "127.0.0.1", "port": 8881 },
"localListener": { "host": "127.0.0.1", "port": 8883, "pcOnlyWrites": false },
"origins": ["https://127.0.0.1:8881", "https://127.0.0.1:8883"]
```

The tunnel must target only the main listener. Both listeners serve the same server TLS certificate. Desktop pairing includes the local port and verifies its TLS fingerprint before sending the pairing code or cookie. The app saves that port with the encrypted `listener-pins`; absent ports default to 8883. A different port requires fresh pairing. Rescue remains on 8880.

When upgrading a config without `localListener`, re-run the server installer as
root. It adds the local listener and HTTPS origin on 8883 with `pcOnlyWrites: false`
and preserves any existing listener. Saved desktop pins without a local port use
8883. Once the listener is running, obtain a fresh `sudo wayroost pair-desktop`
token and pair again to save the local port and verify its TLS pin.

Keep production `pcOnlyWrites` false until the live desktop check passes: the paired desktop must reach the local listener from Windows, and the same identity replayed through the main listener must be refused for a PC-only operation. Fixture tests do not certify the live Windows connection.

## Revoke restarts

Supervisor config has a separate capability, `restartWhenIdleCertified`, defaulting to false. A revoke still saves and audits the change while this flag is false. The Safety page offers **Restart now**, explaining that it can cut active WhatsApp turns, phone calls, jobs, background commands and delegated work; it schedules no idle restart. The supervisor also refuses direct Hermes idle-restart requests while uncertified.

Enable this capability only as a separate step after the production executor's drain, restart, cleanup and interruption cases pass. Then revokes schedule a tracked idle restart and the page offers both restart choices. For rollback to a supervisor with an older strict config parser, remove `restartWhenIdleCertified` from supervisor config first.

## Owner-run Hermes resolver

The effective resolver runs as the target's owner. Its trust walk covers `resolver.python`, `hermes_cli/config.py` under `resolver.modulePath`, and the dependency paths listed below when `venv` is set. These paths may be owned by that owner or root behind a directory owned by either with no group or other access (`mode & 0077 == 0`). Ancestors above that private directory must also be owned by that owner or root and must not be group- or world-writable. Directories below it may be writable by group or others. Symlinks and foreign owners on the walked paths are refused.

For example, `/home/me` at 0750, `.hermes` at 0700 and install directories at 0775 satisfy the owner rule. Configure real interpreter and source files without symlinks. Both paths need a private ancestor. This rule is used only for the owner-run resolver; root-run executable trust remains strict. It provides no isolation from programs running as the same owner.

Code files must be regular files that nobody else can write. World-writable files are refused. Group-writable files are accepted only when `/etc/group` lists no members or just the owner and `/etc/passwd` lists no other account with that primary group. An unresolved group is refused. Multiple hard links are allowed because every alias shares these inode permissions.

When a code file has any group access bits, the resolver also refuses access ACLs
(`system.posix_acl_access`). An isolated root-trusted `/usr/bin/python3` checks
attributes without following symlinks; errors, timeouts and unexpected output
refuse the path. Directory ACL masks are already covered by the ancestor mode
checks. Root-run trust is unchanged.

Set the optional `resolver.venv` in `settings-targets.json` when Hermes' dependencies
live in a separate uv-managed environment. Point it at the absolute venv directory,
for example `/home/me/.hermes/installs/example/environments/example-hash/venv`.
Keep `resolver.python` pointed at the real interpreter file: the venv's `bin/python`
symlink is refused by owner trust. Omitting `venv` keeps the existing import behavior.

The resolver reads `pyvenv.cfg` with a 16 KiB limit and without following symlinks.
Both metadata readers reject control and format characters, including a BOM;
newlines separate the fields.
Its `home` must equal the directory containing `resolver.python`, and the major/minor
of `version_info` must match the running interpreter. Python also requires the
dependency directory to equal the exact path checked by the Node trust walk. It adds exactly
`<venv>/lib/python<major>.<minor>/site-packages` with `site.addsitedir`, including `.pth`
files and their owner code. Unless `include-system-site-packages` is `true`, it first
removes the interpreter's `site-packages` and `dist-packages` entries. The Hermes
module path and venv dependencies come first; when system packages are enabled,
the interpreter's entries remain after them and the paths added by `.pth` files.
Errors and mismatches return `unavailable`.

The resolver script does not import `pm` or call its dependency activation. Hermes
may import pm helper modules such as `pm.environments`, `pm.paths` and `pm.extras`
(definitions only).
The resolver never activates dependencies, takes a Hermes runtime lock or generation
lease, runs publication recovery, or writes files; the audit guard refuses lock opens
and other writes.

Each `.pth` file must be a regular file, read without following symlinks and with
a 1 MiB limit checked both before and during the read. The guard replaces only
`site.io` during dependency loading, including Python versions where `site` uses `_io`,
and leaves import readers unchanged. Open, stat and stream errors
return `unavailable` even when Python's `site` module catches them.

The owner trust walk covers the venv directory, `pyvenv.cfg`, `lib`, the Python version
directory and `site-packages` under the same private ancestor rule. Symlinks
and foreign owners on those paths are refused. `pyvenv.cfg` and the `site-packages` directory also
follow the code-file writability and access ACL rules above; intermediate directories
below the private ancestor may still be writable. Root-run trust remains strict.
Package files, `.pth` files and paths they add are not separately trust-walked.
They are owner code and must stay behind the same private ancestor. This claims no
isolation from that code, including symlinks within packages or paths added by `.pth`.

`HERMES_HOME` must be an initialized Hermes home.
Hermes re-ensures directories during import. A fixture must pre-create the pinned
directory skeleton: `cron`, `sessions`, `logs`, `logs/curator`, `memories`, `pairing`,
`hooks`, `image_cache`, `audio_cache` and `skills` (from `_HERMES_HOME_SUBDIRS`).
`HERMES_HOME` itself and every listed directory must already have mode 0700, or the
mode specified by `HERMES_HOME_MODE` when that startup variable is configured.
`SOUL.md` must already exist and must not contain Hermes' legacy template, which
Hermes would replace during initialization.
An `exist_ok` mkdir of an existing directory is tolerated; creating a missing
directory or changing permissions is still refused.

A Hermes dependency update changes the environment hash. Re-point `venv` after
every dependency update: one line in `settings-targets.json`. While the old environment
still exists, the resolver may keep resolving against its previous dependencies and
workspace. Once Hermes removes it, the stale path fails closed with `unavailable`.
