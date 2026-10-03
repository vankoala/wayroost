# Workers' approvals come to me

Settings → Safety & access has the switch, separate from Hermes safety
commands. It says what the setting protects, where it stands in Paseo, which
providers it can't cover, and its known gaps: agents already running keep their
old limits until they restart, and the limit is a guardrail in Paseo, not a
boundary. Every paired device sees it; only a paired desktop can change it, and
turning it off asks first. The same setting is in the API:

`GET /api/worker-approvals` requires the usual device sign-in and public-origin
Access checks. `PUT /api/worker-approvals` accepts exactly `{ "enabled": true }`
or `{ "enabled": false }` and also requires a paired desktop. A phone or an
Access identity alone cannot change it.

The response includes the saved `enabled` choice, `config` (`pending` or
`written`), `reload` (`pending`, `applied`, or `failed`), `application`
(`pending` or `partial`), uncovered provider IDs, and known limitations.
Without a reachable helper it reports pending coverage. A failed save returns
424; after a timeout, read the status before retrying because the owner may
have finished saving. Failed daemon discovery leaves the saved choice unchanged.

The owner-side helper starts with the choice on. It owns a separate Wayroost
state file, `worker-approvals.json`, containing the choice, per-provider undo
records and a pending reload flag. Private state saves use
mode 0600 temporary files, synced and renamed in the same directory. Malformed
existing state is an error instead of resetting the backup. Turning the setting
off preserves preexisting disabled tools and later owner edits. A temporarily
invalid provider keeps its undo record across helper restarts, including while
the setting is off; restoration resumes when the owner repairs that entry.
Worker and reviewer tools stay disabled in both directions.

The helper automatically merges the policy into the owner's Paseo config, then
reloads the daemon. Every Wayroost writer of that config, including the Safety
setting, owner helper and cloud-agent switches, uses `withPaseoConfigLock`: an advisory `flock` on
`<config filename>.wayroost.lock` next to the config. If that directory is not
writable, the lock is in the configured Wayroost state directory, named with
the config path's hash. Writers must run as the configured owner with the same
state directory; the lock file is retained so waiting writers share its inode.
The helper holds the lock across reading the config and fresh Safety state,
merging, writing, reload, and final verification. There are no other production
Paseo config writers outside that helper in this package.

Before atomic rename, the helper rereads the config and compares its content
hash, modification time, size and inode with the revision it read. A changed
revision restarts the merge from the owner's latest content, with at most three
attempts. Both the prior and intended undo backups are journaled before writing.
A failed or uncertain write retains the appropriate backup or recovery journal;
a journal is recovered only when the config matches its before or after content
hash. An ambiguous journal is retained for manual recovery.

After rename, the helper rereads the entire file and verifies all owner settings
and exactly the intended policy change. A mismatch reports a configuration
conflict with `config: pending`, `reload: pending` and `application: pending`,
shown in Settings, and retains the undo backup. Confirmation also requires
matching disk revision and effective daemon policy at the end of the request.

A writer that does not take this lock, such as Paseo or a person editing the
file, can still write between the final revision check and atomic rename.
The operator has accepted that remaining race.

Status requests inspect disk and effective daemon policy without taking the
lock, saving state, rewriting config or reloading, in both roles. A primary
helper reconciles at startup and every five seconds. A helper serving a shadow
server (`WAYROOST_ROLE=shadow`, as the installer sets up) reconciles only on a
deliberate paired-desktop setting change. A reconciliation plans
the policy for built-ins and configurable custom entries. Providers discovered
without configurable entries, including plugin collisions with role IDs, stay
untouched and appear in `uncoveredProviders`. The config target, daemon URL and
state directory are fixed by the service configuration.

Cloud-agent switches also use the helper: they merge only the fixed cloud
provider's `enabled` flag, with the same lock, bounded revision comparison,
post-write check and final disk/daemon verification. Without a reachable helper,
cloud switches return 424 instead of making an uncoordinated write. The adapter
refreshes the daemon's provider snapshot after a verified switch.

The RPC accepts only the Safety boolean or a known cloud-provider ID and boolean,
with no paths, commands, arbitrary config or daemon methods. It uses a Unix socket with
mode 0660 in a directory with mode 0750, plus a distinct shared credential.

The helper uses the Paseo client's password-authenticated `getProvidersSnapshot`,
`reloadDaemonConfig` and `getDaemonConfig` calls, with a fresh client closed after
each request. It confirms the effective provider policy after reload, including
restrictions removed when switching the setting off. Every
reconciliation also checks the live policy when
no reload is pending, even if the disk config has not changed. Drift persists a pending reload before retrying; a failed policy read
also persists pending status instead of reporting the earlier policy as applied.
A reload that changes no paths still counts as applied when the effective policy
matches, so a helper restart or lost reload response does not leave it retrying
indefinitely. A provider first observed in an effective snapshot keeps the
request pending until a later reconciliation accounts for it; an absent config
entry is not evidence that the setting covers that provider. The helper
retains the pending flag when the policies differ, retries failed requests, and
reports pending application when providers require a restart or are controlled
by an override.
No existing agent is stopped or restarted automatically.

Paseo's provider limits are a guardrail. Started agents retain their earlier
policy, and removing or substituting MCP caller identity can bypass restrictions
with the same token. Agents running as the owner can also edit the config. This
package does not install a host command wrapper. The API includes all
four limitations and never reports complete enforcement. A guarantee that no
agent can approve another agent's work still requires authenticated ownership
checks and an explicit session migration in the later hub work.
