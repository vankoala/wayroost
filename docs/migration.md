# Explicit primary migration

Migration is an attended maintenance operation. Stop every legacy, primary,
helper and provider writer first. These tools check each unit named with
`--stopped-unit` through `systemctl show -p LoadState --value` (requiring `loaded`)
and `systemctl is-active`; a missing unit, active unit or
unproved status refuses the operation. Repeat the flag for **every** writer.
They do not stop or start services, change the pipeline switch, open listeners,
or decide which installation should run. Keep writers stopped after an
interruption until resume and verification finish.

The owner tool and the root tool have different authority. Never run npm as root.
Build the settings executable as the configured owner. The state tool runs as
root against physical private paths; systemd's public symlinks are refused.
All example paths and units below are invented.

## Owner preferences and provider policies

`npm run migrate:settings -- MODE ...` builds `scripts/migrate-settings.ts` with
esbuild and runs the result on Node 22. Modes are `plan`, `forward`, `verify`,
and `reverse`. The prepared, root-owned `settings-targets.json` must configure
`wayroost-settings` and `paseo-config` for this owner, with their original locks,
private backup/audit directories, and installed Paseo validator. Writes require
`configWrites: true`. No new package is needed.

```sh
npm run migrate:settings -- plan \
  --targets /etc/wayroost/settings-targets.json \
  --legacy-dir /home/me/migration/legacy-preferences \
  --legacy-paseo /home/me/migration/legacy-paseo.json \
  --legacy-config /home/me/migration/legacy-config.json \
  --stopped-unit example-legacy.service \
  --stopped-unit example-primary.service \
  --stopped-unit example-paseo.service
```

Use the same arguments with `forward`, then `verify`. For reverse, use the same
paths and `reverse` while the primary owner targets contain the current choices.
If the legacy Paseo config is already the prepared Paseo target,
`--legacy-paseo` may name that exact file. Other source/target overlaps refuse.
`--legacy-config` is the owner-readable legacy server configuration; its
`notifications.timeZone` is the selected legacy zone. The tool updates only that
notification field on reverse and retains the remaining configuration.

The owner must have legitimate access to the preference inputs. If the legacy
state is private to a service user, the operator supplies a stopped, owner-readable
preference staging directory containing only these named input files. This tool
does not grant access to a private service tree. After reverse, the operator
publishes these selected preference files back with the legacy service's
ownership before enabling its writers. The owner tool cannot chown root/service
files. Keep the staging inputs and owner receipt private.

| Input | Forward owner target | Reverse |
| --- | --- | --- |
| Legacy Paseo `agents.providers` | Cloud flags for claude/codex/opencode and **complete** `paseoTools` objects for every configured provider | Current flags and policies; existing unrelated provider fields remain |
| `worker-approvals.json` | Selected legacy boolean, full undo backup and any prepared state recorded separately in the migration snapshot | Current representable choice and a usable legacy undo backup; mixed policies refuse before writes |
| `hermes-safety-commands.json` | `enabled` → `safetyCommandsEnabled` | Current value → legacy `enabled` |
| `wayroost-settings.json` | Notification `rules`, `quietHours`, `push` | Current notification fields; old feed hours/push updated too |
| Legacy configuration | `notifications.timeZone` → `timeZone` | Current selected zone, including deliberate absence |
| `worker-updates.json` | `enabled`, `defaultMinutes` | Current values |
| `voice.json` | Local voice and app read-aloud provider choice | Current version-2 legacy-compatible choice |
| `feed.json:settings` | Proactivity `level`, `lessLike` | Current preferences; cards, closures and notification dedup remain untouched |

If `feed.json` is absent during reverse, only its saved `settings` block is
restored before applying current preferences. Old cards, closures, notification
dedup and other operational fields are never recreated from that snapshot.

Before the notification store's first seed, feed settings supply legacy hours
and push. Once a notification document exists, its omitted fields use notification
defaults; feed fields do not fill them in. The app and migrator share the legacy
readers in `shared/legacy-settings.ts`. Empty, malformed, BOM-prefixed or
wrong-typed feed, worker-update, voice and safety-command preferences use exactly
the app reader's defaults. Migration prints a fixed warning naming only the
store and problem class, never the contents. Invalid individual fields retain
valid siblings and use the reader's field defaults. Incomplete or non-object
feed push values use the whole-object default.
The checked notification reader, approval-state reader, Paseo configuration
reader and server configuration parser still refuse invalid inputs. Notification
documents must pass the legacy schema and 128 KiB limit. Their permission mask
must allow the checked reader to accept them: special mode bits, group write
and all other-user permissions refuse migration in every mode. Permitted modes,
including group read, are preserved on reverse; incompatible saved modes refuse
restoration before writes. Feed push
settings are ignored once a notification document exists. Absent fields remain
absent when the effective default agrees. Two legacy defaults differ from the
owner schema: absent worker updates mean enabled and absent feed level means
normal. Forward writes those choices explicitly. Reverse writes false/off
explicitly if those primary fields are absent, so legacy defaults cannot turn
them back on. An absent zone stays unconfigured; verification never invents a
machine-specific zone. Reverse fills both push booleans when the primary object
is partial, because the legacy notification reader requires a complete push
object; it leaves an absent object absent when its default meaning agrees.
Legacy JSON uses the last occurrence of a duplicate key. Worker updates use
the legacy numeric coercion for time boxes and treat only literal `false` as
disabled. Safety commands require literal `true`; invalid voice choices and
feed preferences use their reader defaults. Normalization retains absent keys.
When a legacy reader defaults over bytes the editor cannot edit, reverse uses
the existing write-through core's atomic restoration path. It validates the
replacement first and retains the exact previous bytes in a private backup;
empty, malformed, BOM-prefixed and wrong-typed preference stores can therefore
receive the current choices too.
Legacy configuration validation uses the migrator's environment, including
`WAYROOST_ROLE` (or `SIGNALBOX_ROLE`) and `WAYROOST_DEV_ALLOW_LOOPBACK` (or its
legacy alias), just as the app does. Run it with the legacy service's role and
development overrides. Supervisor credentials are not needed to migrate the
time zone; this parser call does not resolve or read credentials.
Unsupported provider definitions remain uncovered in the legacy policy reader.
Migration still carries their complete, valid tool policies. Wrong-typed provider
flags are ignored and use the default; they never discard sibling policies.
Destination validation refuses launch definitions that cannot be represented.
Unknown less-like fields are stripped by the shared reader. An effective list
that exceeds the owner schema's bounds cannot be represented unchanged and
refuses before writes; it is never truncated or clamped.
Before publishing or updating the receipt, a single preflight reads all stores,
validates every destination, backup and audit directory, lock and final output
document, and exercises the consumer, file and existing audit locks. Reaper
paths are included, including nested reapers, so a stale target lock cannot
hide a live or unsafe reaper. A refused preflight changes no documents or receipt.
The path inventory reserves whole backup and audit storage roots, the receipt
and all configured and generated locks and reapers before reading inputs or validating
providers. Sources and destinations cannot overlap those artifacts; the receipt
and its lock, along with the private snapshot directory, are the only migration
artifacts allowed in their designated backup root. Plan checks the same private
backup and audit directories before provider validation; missing directories
refuse without creating them.
Both directions validate against the destination consumer schemas, including
the legacy server configuration. A primary time zone that cannot be represented
by the legacy configuration refuses reverse without changing any files.
Before any forward write, including receipt publication, the tool checks both
primary targets' final edited bytes against their 4 MiB reader limit. A Paseo
target that is also the legacy source must fit the legacy reader's 2 MiB limit.
Legacy Paseo inputs also use that limit in every mode. Before any reverse write,
the tool checks every destination against its reader limit: 128 KiB for
notifications, 2 MiB for the legacy Paseo configuration, and 16 MiB for approval
state. Feed, worker updates, voice, safety commands and the legacy server
configuration have no byte cap in their readers. These checks include preserved
formatting and UTF-8 encoding. New documents receive the same checks. Oversized
edits refuse without changing files or the receipt; reduce the stopped input or
current policy before retrying.
Legacy readers decode malformed UTF-8 with replacement characters, except the
notification reader, which rejects it. Forward and verification use those same
decoding rules and retain raw source hashes. Reverse requires valid UTF-8 in
every destination because the shared write-through editor reads it strictly;
an invalid destination refuses before any receipt, lock or document changes.

Policies are never reconstructed by invoking the approvals boolean operation.
Custom, inherited and role providers retain their full policy objects and new
providers retain the definition needed to load them. Each exact provider ID uses
its own policy and defaults; `extends` does not inherit tool restrictions.
Reverse refuses partially restricted approval tools or a mixture of enabled
approval policies that cannot be represented by the legacy boolean. Fully
disabled role providers can coexist with either choice. A historical unresolved
prepared approval write requires
resolution against its recorded original revision before reverse can proceed.
Pre-existing tool restrictions remain in the reconstructed legacy undo state.
When no legacy undo record attributes a restriction to the option, reverse
conservatively retains it in the undo baseline.

All settings replacements and receipt updates use `SettingsWriteThrough`, the
same atomic replacement, backups, verification and audit as the supervisor, with
`withConsumerLock` and the configured exact lock paths. A missing document is
exclusively bootstrapped with the complete intended document inside those locks,
flushed, then replaced by the core. If interrupted after that first publication,
the receipt already identifies its paths and phase, and settings are already valid
regardless of the configured filename. Repeating the operation resumes normally.
Ordinary supervisor settings saves still require an existing document. Files keep
owner, group and modes; unrelated configuration values survive.

`<owner backupDir>/migration.json` records paths, hashes, byte sizes, the selected
legacy choice, restoration metadata and target hashes. Raw legacy snapshots,
including provider policies and approval undo state, live separately as immutable
0600 files in the owner's 0700 `migration-snapshots` directory, named by SHA-256.
These snapshots retain the **entire legacy Paseo and server configuration files**,
including unrelated fields, until the operator finalizes the migration. They live
at `<wayroost-settings.backupDir>/migration-snapshots/<sha256>`; the `paseo` and
`configuration` references in `<wayroost-settings.backupDir>/migration.json`
identify those files. Keep the snapshot directory private and never publish it.
The receipt contains no raw configuration values. Snapshot reads check owner,
mode, hash and size and apply each legacy store's own byte limit. Uncapped legacy
preferences and approval state up to 16 MiB do not consume receipt space.
Retain the receipt and its snapshots together for resume and reverse. This receipt
format is version 2; older embedded-snapshot receipts refuse before writes.
After the primary cutover is accepted and the operator finalizes it, remove
`<wayroost-settings.backupDir>/migration-snapshots` and its `migration.json`
receipt together only when resume and reverse are no longer needed. This is an
explicit operator action; the tool does not expire snapshots. Retain the separate
settings backup and audit histories.
On the next run, interrupted snapshot temporaries are removed only when their
hash-and-UUID names match this tool's format and metadata confirms owner-held,
single-link regular 0600 files. Other files remain untouched. Plan exercises the
shared locks and removes only Paseo lock files it created itself.
Settings values are not printed, including on errors: the tool's own errors
retain their reasons; foreign errors use fixed messages per error class.
Both audit histories and all backups remain. Before
publication, update or resumed target writes, its edited bytes must fit the 4 MiB
reader limit, with space reserved for completion hashes and subsequent phase
names. An oversized receipt refuses before target writes. Old undo tokens are
not valid across different paths or backends. A prepared forward run resumes
with its saved choices only while the
legacy preference and configuration hashes still match, including the source of
the time zone. The prepared receipt records the intended Paseo output hash before
publication. When the legacy and primary Paseo paths are the same, resume accepts
only the original or intended file revision and copies policies from the saved
snapshot. Other edits, including cloud-agent flags, refuse before writes. A
prepared shared-path receipt without that intended hash refuses; restore the
original snapshot and prepare a new receipt while retaining the old history.
Completion is recorded after semantic verification succeeds.
A completed run verifies instead of recopying. Use a fresh prepared target/receipt for a subsequent
cutover, retaining the old history. `verify` compares effective values, unordered
notification rules and tool sets rather than byte formatting. Reverse uses current
primary settings, never the old snapshot as the new choice.

## Opaque operational state

`python3 deploy/state-transfer.py MODE ...` runs as root. Supply existing physical
legacy and primary state directories whose immediate parents are root-owned
and private (0700), plus a separate root-owned private journal directory. Every
ancestor must be a real root-owned directory without group/other write access.
Neither input may be shadow-owned; role markers on either path or any ancestor
are checked. A primary tree not yet claimed by the application is allowed. Role
markers are never copied or created by this tool.

```sh
python3 deploy/state-transfer.py plan \
  --legacy-dir /var/lib/private/example-legacy \
  --primary-dir /var/lib/private/example-primary \
  --journal-dir /root/example-migration \
  --stopped-unit example-legacy.service \
  --stopped-unit example-primary.service
```

Run `forward` then `verify` with identical paths and family selections. Omitting
`--family` selects every family below; repeat it to select a subset. Tasks and
lineage must be selected together so provenance is retained.

| Family | Fixed names moved together |
| --- | --- |
| `feed` | `feed.json`: cards, closures, proactivity, less-like and notification dedup |
| `tasks` | `tasks.json`, `task-events.jsonl`, `task-event-totals.json`, `task-events.jsonl.retention` |
| `lineage` | `lineage.json`, `hermes-chat-moves.json` |
| `voice` | `voice.json` |
| `schedule-ideas` | `schedule-ideas.json` cache |
| `paseo-client-id` | `paseo-client-id` |
| `hermes-sign-in` | `hermes-credentials.json`, including the saved sign-in |

Absent members are part of the family snapshot. Transfer does not concatenate
event journals or regenerate caches. Stores must be private regular files with
one link. Binary bytes are copied without parsing or decoding; SHA-256 and size
are checked before and after copying, and exact mode and destination ownership
are checked after publication. Only paths, hashes, sizes, modes and transaction
control metadata appear in output, journals or receipts. Opaque stage, archive
and rollback files contain store bytes and remain protected by root-private
parents; do not publish them.

Have systemd prepare the primary `StateDirectory` with the service's existing
`DynamicUser=yes` and 0700 convention before transfer, then stop the service.
The tool uses the prepared primary directory's numeric uid/gid for copied files,
rather than assuming a stable dynamic uid. With systemd's id-mapped state
storage, the outside-namespace owner can be `nobody`; copies receive that same
uid/gid and systemd maps ownership for the service. Without id mapping the
prepared directory's dynamic uid/gid are used. The tool never starts the service
or guesses an account. Reverse similarly uses the retained legacy directory's
current service ownership. Test the service's access through its normal unit
before releasing the maintenance hold.

Each transaction holds a root journal lock. A durable prepared manifest precedes
staging; every selected member is staged and every destination original backed
up before any publication. Each publication has a flushed write-ahead checkpoint.
The stopped writers are the visibility boundary: files may be partly published
after process termination, and **must not be opened by writers until resume
finishes the entire transaction**. Repeating the same command verifies and
finishes all selected members, including deletions for absent source members.
Changed source bytes or an unrelated destination edit refuse resume. Completed
transactions verify without overwriting later current state. The directory and
file flushes cover prepared manifests, staged copies, publication and receipts.

Reverse reads the **current** primary family. Because an opaque tool cannot
interpret schema compatibility, the operator confirms each compatible family
with repeated `--compatible FAMILY` flags after checking the legacy reader's
format contract. Unconfirmed families are copied into `reverse-archive`, and
legacy values stay intact. Confirm tasks and lineage together. This avoids
silently resetting an unsupported current store. For a fully compatible reverse,
add every selected family:

```sh
python3 deploy/state-transfer.py reverse \
  --legacy-dir /var/lib/private/example-legacy \
  --primary-dir /var/lib/private/example-primary \
  --journal-dir /root/example-migration \
  --stopped-unit example-legacy.service \
  --stopped-unit example-primary.service \
  --compatible feed --compatible tasks --compatible lineage --compatible voice \
  --compatible schedule-ideas --compatible paseo-client-id --compatible hermes-sign-in
```

`reverse-rollback` keeps legacy originals with hashes, sizes and modes in
`reverse-receipt.json`; `forward-rollback` retains the primary originals. Neither
is automatically expired. After reverse, `verify` and repetitions of the completed
`reverse` command use its receipt to check current primary sources, compatible
legacy destinations, retained incompatible originals, archives and rollback
copies, including absent members. Each file's hash, size,
mode and ownership must match; archived families need not match the legacy files
that were deliberately retained. Once a reverse journal exists, verification
requires its matching reverse receipt and never falls back to forward verification.
An interrupted reverse without a receipt must be resumed before verification.
Verification uses the existing transaction lock and creates no files.
Reverse requires the forward receipt to match its completed journal, including
paths, families, file metadata and retained-copy locations. Before creating a
lock or journal, transfer checks existing transaction directories, journals,
receipts, temporary files, staged copies and publication paths. Invalid existing
artifacts refuse without changing the transaction; interrupted valid copies
remain resumable.
Finalization is a separate operator action: retain the
receipts and delete only the listed stage/rollback/archive copies after accepting
the result and deciding which archives must remain. The tool has no automatic
cleanup or service restart command.

When preferences use owner-readable staging, follow this rollback order with
every writer still stopped:

1. Complete opaque reverse into the legacy tree, restoring current compatible
   feed and voice families along with the other selected operational state.
2. Refresh the owner-readable staging inputs from the restored legacy tree
   **before generating reversed preferences**, especially the complete `feed.json`
   and `voice.json`. Retain their current operational and unrelated fields, use
   private owner-readable copies, and remove staging files whose source is absent.
   Retain the original owner migration receipt and its configured paths.
3. Run the owner tool in `reverse` against the refreshed staging inputs and current
   primary owner targets. It changes preference fields while retaining the current
   cards, closures, notification dedup and unrelated voice fields in those inputs.
4. Publish the reversed staging preferences back to the legacy tree with the
   service's ownership, then verify the semantic owner/legacy choices before
   starting any writer.

When the owner has direct access to the legacy inputs, run opaque reverse first,
then owner reverse and semantic verification on that tree. Fresh operational state
and current preferences are both required before starting legacy writers.

## Stores that stay in place

Device registry, push VAPID identity/subscriptions, browser cookies, pairing
codes/directories/sockets, bridge tokens, state-role markers and state locks
never transfer. Naming one through `--family` refuses. Devices pair afresh and
re-enable push per device; legacy/shadow identities remain available for rollback.
A primary pairing socket is created by its own runtime. Saved Hermes sign-in is
the explicit exception: it transfers opaquely, without inspecting the credential.

Conversations, sessions, memories, backend credentials, OAuth tokens, vaults,
phone settings, skills, model/role wiring and connector configuration remain
with their existing owners. These tools do not inspect or migrate them.
Registration/trigger transitions need their own scoped operation. Role-specific
settings audit/recovery journals remain separate. Pending OAuth flows, live
connections, voice streams, bridge queues and in-memory admission holds need
operator-controlled quiescence; file copying cannot preserve them.

Pipeline startup never seeds or reconciles preferences from legacy stores.
Migration and reverse migration are explicit steps before changing the startup
switch described in [the cutover checklist](shadow-cutover.md).
