# Bridge names and compatibility

New registrations use MCP server `wayroost` and Hermes plugin
`wayroost-identity`. Hermes tools use `mcp__wayroost__*`, and pi's direct
tools use `wayroost_*`. New envelopes say “via Wayroost”. Internal wrapper
filenames and historical messages remain readable.

## Both-name transition

`bridge.legacyNames` defaults to `true`. Both names use the same bearer
token, caller identity, project guards, rate limits, queues and approval
restrictions. Setting it to `false` refuses legacy calls.

A harness's registration label is not transmitted by MCP. Canonical
registrations therefore carry `WAYROOST_BRIDGE_NAME=wayroost` in their
environment. The wrapper sends that name in `X-Bridge-Name`; an unstamped
launch identifies as `signalbox`. Both unstamped launches and explicit
`WAYROOST_BRIDGE_NAME=signalbox` launches are refused after cutoff. Old
wrappers without the HTTP header are also legacy. Auditing the full harness
inventory before cutoff prevents leftover old labels from exposing tools.

The plugin maps both tool prefixes to Hermes' same stored session id.
It supplies `_wayroost_caller` for the canonical prefix and
`_signalbox_caller` for the legacy prefix. The wrapper strips both and sends
the same identity header; conflicting identities are refused. Paseo still
uses `PASEO_AGENT_ID`. A tool prefix cannot grant a different identity or
privilege.

The plugin reads `wayroost-bridge.json` beside its installed source on each
call. It mirrors the server setting:

```json
{"bridge":{"legacyNames":true}}
```

Missing settings retain the transition default; malformed settings refuse
legacy calls. `WAYROOST_BRIDGE_LEGACY_NAMES=true|false` can supply the value
locally; keep any environment override consistent with the mirror. The
server remains authoritative. Enable exactly one identity plugin. The
`signalbox-identity` compatibility entry point uses the canonical
implementation and mirror, and refuses bridge calls after cutoff.

Token and address files now use `~/.config/wayroost/bridge-token` and
`bridge-url`. Readers prefer them and fall back to the old
`~/.config/signalbox/` files when the new files are absent. Explicit
`WAYROOST_BRIDGE_TOKEN_FILE` and `WAYROOST_BRIDGE_URL` take precedence.
Deprecated `SIGNALBOX_*` environment aliases are credential/address
fallbacks, rather than identity selectors.

## Owner-side registration steps

`deploy/bridge-names.py` provides `plan`, `forward`, `verify`, `reverse`,
`cutoff` and `audit`. Run it as the owner with Python 3 and `python3-yaml`
for Hermes YAML. It reads only explicit configuration files. It never
reads conversations, sessions or memories, discovers homes, launches an
agent, or restarts a service. Diagnostics report JSON-pointer paths without
configuration values.

Supply an explicit manifest, for example:

```json
{
  "targets": [
    {"kind":"hermes","path":"/home/me/.hermes/config.yaml","map":"/mcp_servers"},
    {"kind":"hermes","path":"/home/me/.hermes/cron/jobs.json"},
    {"kind":"pi","path":"/home/me/.pi/agent/mcp.json","map":"/mcpServers"},
    {"kind":"claude","path":"/home/me/.claude.json","map":"/mcpServers"},
    {"kind":"claude","path":"/home/me/.claude/settings.json"}
  ],
  "inventory": [
    {"kind":"hermes","path":"/home/me/.hermes/config.yaml","map":"/mcp_servers"},
    {"kind":"hermes","path":"/home/me/.hermes/cron/jobs.json"},
    {"kind":"pi","path":"/home/me/.pi/agent/mcp.json","map":"/mcpServers"},
    {"kind":"claude","path":"/home/me/.claude.json","map":"/mcpServers"},
    {"kind":"claude","path":"/home/me/.claude/settings.json"}
  ],
  "pluginMirror":"/home/me/.hermes/plugins/wayroost-identity/wayroost-bridge.json"
}
```

`targets` selects documents to migrate. Include Hermes cron jobs and Claude
settings **before forward and before reverse**, so their allowlists and
permission restrictions change with the registration. A shared file is
listed once. `inventory` must contain the full installed harness/profile
inventory, including profiles used by Paseo and all selected documents.
The helper cannot establish completeness beyond this owner-supplied list.
It checks every supported map in each inventory document, including maps
other than the one named in its entry.

Paseo agents inherit their harness registrations. Supported maps are
`/mcp_servers`, `/mcpServers`, pi's older `/mcp-servers`, OpenCode's `/mcp`,
and explicit `/agents/providers/<id>/mcpServers` maps. Use `kind: "paseo"`
for a Claude harness or the harness's own kind for Hermes, pi and OpenCode.
Reference-only targets are Hermes `cron/jobs.json` and Claude
`settings.json`. JSON must be strict JSON. Hermes YAML supports block and
flow syntax, including a flow mapping for the whole document. YAML aliases,
merges and duplicate keys are refused. Names to rename must use plain or
quoted scalars; block scalar names (`|` or `>`) are refused during planning.

Outside the selected bridge entry, all registration steps refuse unrecognized strings
that equal either bridge name or begin with `mcp__<name>__` or `<name>_`.
These supported references are renamed in the same receipt:

- Exact Hermes `platform_toolsets.*` list members.
- Exact `enabled_toolsets` members in selected Hermes `cron/jobs.json`.
- Literal `mcp__<name>__` prefixes in Claude `permissions.allow` and `deny`.
- Literal `mcp__<name>__` prefixes in OpenCode `tools` and `permission` keys.

Both-name registration collisions and permission-key collisions are refused.
Exactly one identity plugin may be enabled; the other name may remain disabled.
With no enabled identity plugin, a single disabled identity name is accepted
and stays disabled. Configurations with no enabled identity plugin, including
`--no-hermes-plugin` setups, also migrate; their receipt records
`identityPlugin: "none"`. The audit reports their Hermes registrations in
`unverifiedHermes`, because caller identity is not verified by a plugin.
Duplicate names and an identity name in both lists are
refused. Name changes preserve each plugin's enabled or disabled state, swapping
an inactive alias when necessary. The receipt records the original list state.

```sh
python3 deploy/bridge-names.py plan --manifest /home/me/bridge-manifest.json
python3 deploy/bridge-names.py forward --manifest /home/me/bridge-manifest.json --receipt /home/me/bridge-receipt.json
python3 deploy/bridge-names.py verify --manifest /home/me/bridge-manifest.json --receipt /home/me/bridge-receipt.json
python3 deploy/bridge-names.py reverse --manifest /home/me/bridge-manifest.json --receipt /home/me/bridge-receipt.json
python3 deploy/bridge-names.py verify --expect reverse --manifest /home/me/bridge-manifest.json --receipt /home/me/bridge-receipt.json
```

`plan` writes nothing. `forward` stores a private 0600 receipt before its
first publication. Receipts contain hashes, list provenance and name/stamp
edit spans; they contain no whole configuration copies or bridge-entry credentials.
Forward preserves command, arguments, restrictions, enablement and other
fields, adding only the canonical launch stamp besides the name changes.
JSON and YAML edits retain surrounding bytes and comments.
The helper validates the complete expected document semantics, including
references and plugin lists, before publishing edits.

`verify` checks semantic state: the expected registration key, a bridge
entry equal to the recorded hash, the recorded identity plugin state, and renamed
supported references. Unrelated formatting and owner cache writes do not
block verification. `reverse` restores exact original bytes if the file
still equals the forward result. Otherwise it reverses only the references
recorded as migrated in the receipt, preserving pre-existing canonical rules
and unrelated later changes. The receipt hashes the original prefix of each
migrated list and every enclosing list in both states. It also records
pre-existing canonical reference pointers and their enclosing-list hashes.
Deletions, movement or
edits within those prefixes are refused before publication, including deletions
among identical rules and replacement of a cron job by one with the same allowlist.
For cron documents, the enclosing prefix includes the complete job objects;
reverse the receipt before editing recorded jobs or their allowlists. Document
settings outside those prefixes are preserved. After reversal, only canonical
supported references recorded as pre-existing may remain. Reverse and
`verify --expect reverse` refuse leftover migrated aliases and unrecorded
canonical references, reporting their JSON pointers. This includes later
toolset members, appended canonical cron jobs and new canonical permission
rules. Resolve these references under the
configuration hold before undoing the registration; pre-existing canonical
rules stay untouched. Receipts lacking enclosing-list provenance refuse semantic verification; migration after document changes also
refuses. An unchanged forward result can still be reversed exactly. A reused
receipt refuses any additional reference migration it did not record. To include
new legacy references, fully reverse, then run `plan` and `forward` with a fresh receipt.
Unsupported references are refused during verification and in either migration direction.
Bridge-entry changes and name collisions are refused. Ownership, modes, no-follow
paths and singly linked regular files are also checked. Partial publication
can resume in either direction; both directions are idempotent.

The helper uses a private advisory receipt lock, atomic per-file replace,
fsync and read-back verification. It is not a multi-file atomic transaction.
**Hold competing configuration writers through migration, cutoff and all
acceptance checks.** Serialize owner steps with your own maintenance lock.

## Finish or undo

1. Install the updated wrapper and canonical identity plugin, retaining the
   old deployment for rollback. Setup refuses an old wrapper registration
   and points to `forward`. It stages and enables the new plugin before
   disabling the old one. Failed staging leaves configuration untouched;
   failed switches restore the snapshot bytes exactly. Ambiguous identity
   enablement requires manual repair; setup never creates a legacy-enabled
   fallback state.
2. With writers held and compatibility still true, run `plan`, `forward`
   and `verify`. For a target with an enabled legacy identity plugin,
   `forward` and `verify` require a `plugin.yaml` named `wayroost-identity`
   in the explicit plugin mirror folder. This check also ties cutoff to the
   installed plugin. Targets with no enabled identity plugin can migrate
   without installing one. Restart the appropriate applications through their
   service manager and start fresh harness sessions. Check caller equality, project
   guards and approval restrictions.
3. Run the cutoff helper against the full inventory:

   ```sh
   python3 deploy/bridge-names.py cutoff --manifest /home/me/bridge-manifest.json
   python3 deploy/bridge-names.py audit --manifest /home/me/bridge-manifest.json
   ```

   `cutoff` refuses leftover `signalbox` registrations, unstamped canonical
   launches and old supported references. It then writes the plugin mirror
   to `false` and reads it back. `audit` is read-only and refuses completion
   unless the full inventory is canonical and the mirror exists and is
   false. Hermes registrations without an enabled identity plugin are
   reported as unverified, including `--no-hermes-plugin` setups, without
   blocking cutoff. Cutoff creates the explicit mirror folder when absent.
   Audit is required before setting server
   `bridge.legacyNames=false`.
4. Set the server setting to false, keep environment overrides consistent,
   restart through the coordinated service manager, and prove canonical
   calls work while old-prefix, unstamped and explicit old-name calls fail.
   Keep writers held through these checks.
5. To undo, restore true in the server, plugin mirror and environment first.
   Run `reverse` and `verify --expect reverse` under the same holds, restore
   the old plugin deployment with exactly one identity plugin enabled, and
   restart the applications. Unrelated later settings remain intact; a
   modified bridge entry needs owner reconciliation before reverse.
