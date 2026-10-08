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

The effective resolver runs as the target's owner. Its interpreter and source paths may be owned by that owner or root behind a directory owned by either with no group or other access (`mode & 0077 == 0`). Ancestors above that private directory must also be owned by that owner or root and must not be group- or world-writable. Directories below it may be writable by group or others. Every symlink and foreign owner is refused.

For example, `/home/me` at 0750, `.hermes` at 0700 and install directories at 0775 satisfy the owner rule. Configure real interpreter and source files without symlinks. Both paths need a private ancestor. This rule is used only for the owner-run resolver; root-run executable trust remains strict. It provides no isolation from programs running as the same owner.

Code files must be regular files that nobody else can write. World-writable files are refused. Group-writable files are accepted only when `/etc/group` lists no members or just the owner and `/etc/passwd` lists no other account with that primary group. An unresolved group is refused. Multiple hard links are allowed because every alias shares these inode permissions.

When a code file has any group access bits, the resolver also refuses access ACLs
(`system.posix_acl_access`). An isolated root-trusted `/usr/bin/python3` checks
attributes without following symlinks; errors, timeouts and unexpected output
refuse the path. Directory ACL masks are already covered by the ancestor mode
checks. Root-run trust is unchanged.
