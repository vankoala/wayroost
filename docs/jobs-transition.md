# Moving triggers and scheduled jobs

`deploy/jobs-transition.py` requires Python 3.10 or newer, runs as the job owner
and refuses root. Unsupported interpreters are refused before any mutation. It
inventories selected scheduling metadata, prepares a reviewable plan, moves jobs to primary,
verifies the result, and reverses the move. It starts no listener and changes no
service, connector credential, conversation, or system configuration.

Run it during an attended quiet window. Stop new scheduling edits and hold the
helper's other writers for the entire transaction. Pausing a registration does
not cancel a running execution: the tool refuses further changes until that
execution has finished. The transaction and home locks exclude other instances of this
tool, including runs using a different transaction directory. The existing helper functions have no cross-process store lock, so the
operator's writer hold is required for their shared folders and gate publication.
Do not edit selected jobs until verify or reverse completes. Deleting a selected
registration during an interrupted forward prevents both retry and reverse;
restore that registration before retrying forward.

Recreated mail triggers deliberately start with no seen-message state. **Their
first run establishes the seen-message baseline and acts on no old mail.** This
is the accepted transition behaviour; it can skip mail that arrived during the
maintenance window. Set `accept_baseline: true` in each reviewed recreation.
Confirmed primary triggers retain their registration, folder and checkpoint.
Shadow specifications are never promoted by editing their role.

Plan, forward and reverse use one preflight for initial runs and every retry,
before any journal write or recovery mutation. It checks
selected behaviour names for existing active duplicates across every decision,
including `leave-paused`; pause extra registrations before retrying. It also
refuses existing running claims on selected registrations and replacement copies
found during recovery. Executions starting after preflight are checked again
when pausing, rewiring and activating writers. It checks checkpoint readability
and parent traversal, permissions for helper
creation and retained historical folders, and receipt metadata and temporary files.
Malformed or inconsistent existing receipts refuse without pausing jobs.
Receipt directories accept only metadata and private atomic-write temporary files;
unused helper copies and staging trees refuse before any journal write.
An interrupted metadata write can be retried without copying helper contents.
Recovery compares retained trigger and relay checkpoints with saved paused
snapshots before any journal write or mutation. A pending activation still
requires equality while its registration is paused; after activation succeeds,
regular checkpoint advancement is allowed. Reverse takes a fresh paused snapshot
so advancement between forward and reverse is preserved.
After correcting a refused path or permission, retry the unchanged selection;
no journal edits are needed.

On retry, completed pauses must still be paused until their recorded activation
has started. Completed script and pulse wiring must match the recorded target,
including absent wiring fields. A committed relay launcher must retain its saved
hash, and replacement markers must identify at most one registration. Pending
wiring accepts only the recorded before or after state. Correct any changed
state before retrying; a refusal leaves the journal and registrations untouched.
Mutation responses and changes occurring after preflight are checked again during
the run and leave a journal that can be retried.

## Owner API access

The built-in transport uses Node and the repository's `playwright-core`
dependency. Run a full `npm ci` with dev dependencies in this source checkout.
By default it launches `node` from PATH. If Node is outside PATH, supply
`--node /absolute/path/to/node`; the path must name an executable regular file.
It launches its own Chromium using `launchPersistentContext`, with a fresh
profile directory under the transaction directory, mode 0700. Playwright uses
its pipe transport; no listening TCP port is opened. A browser debugging TCP
endpoint would expose control of signed-in sessions to other local processes,
so the tool does not accept a CDP endpoint or attach to an existing profile.

Use an installed Google Chrome, or supply `--browser-executable
/usr/bin/chromium` for another Chromium executable. Supply `--dashboard-origin
http://localhost:8080` in every mode. Only `inventory` requires and opens
`--wayroost-origin https://example.com`; other modes use only the dashboard,
so reverse and verify can run while Wayroost is stopped. Origins contain
no path, query or authentication material. Sign in to the dashboard in the new
window, and to Wayroost for inventory, then press Enter in the terminal to continue.
Inventory pairs a device with Wayroost. Afterwards, revoke that temporary
device in **Settings → devices**. Each invocation uses
a fresh profile and closes that window and removes the profile when it finishes,
including on an API refusal. An interactive terminal is required. After an
abrupt process termination, any retained private `browser-*` profile blocks
every mode, including use of a broker. The refusal uses constant cleanup instructions.
Stop its browser, then manually remove the retained `browser-*` profiles from
`--state-dir` before retrying; the tool
never automatically removes a profile left by an earlier run.

Each request runs as a same-origin browser fetch with the session cookies;
the browser handles authentication. The transport never asks for cookie values
or opens a saved sign-in, token, connector header or credential file. GET
responses are projected inside the browser before any result crosses into Node
or Python: only scheduling metadata, connector state, selected bridge wiring
and OAuth status are returned. Claims become presence booleans and callbacks
become origins. Mutations are serialized and awaited, and their response bodies
are discarded. Expired sessions, redirects and API errors refuse with private
details suppressed.

Google, WhatsApp and Shopping use their native backend status for enablement:
`connected` and `needs-sign-in` mean enabled, while `off`, `not-connected` and
`unknown` do not confirm an enabled backend. MCP connectors require an installed
registration; their authentication status is recorded separately.

An existing integration can still use the optional `--owner-api
/home/me/bin/owner-api` executable instead of the browser transport. No custom
executable is required for any of the five modes. An executable receives one
JSON request on stdin and returns one JSON response on stdout. Request bodies
can contain the reviewed action; keep request logging off. Its stderr is captured
and never forwarded. The interface is:

```json
{
  "service": "dashboard",
  "method": "GET",
  "path": "/api/cron/jobs",
  "fields": ["id", "name", "script", "workdir", "schedule", "deliver", "enabled", "state", "enabled_toolsets", "no_agent", "run_claim", "fire_claim", "latest_execution.status"]
}
```

```json
{"status": 200, "data": [{"id": "fake-job-id", "name": "Demo", "enabled": false, "state": "paused"}]}
```

The broker must project GET responses to the requested `fields` **before**
returning them. Array responses retain their API shape (`[]` or `{ "jobs": [] }`);
dotted paths select nested fields, and `*` selects registration keys. For
`run_claim` and `fire_claim`, return only a boolean presence indicator, never the
claim contents. Strip user information, query strings and fragments from
`oauth.redirect_uri`, retaining just its origin. For configuration PUTs, `fields` names the four bridge environment keys. The
broker must preserve all unrelated environment entries within its authenticated
context, replacing each selected key with its supplied value or removing it if
absent from the supplied `env`. The built-in browser performs this merge before
submitting the existing configuration API's environment replacement; unrelated
values never leave the browser. Mutation responses need only an empty object. A nonzero exit or non-success status is a refusal. All private
error details are suppressed. Do not put authentication material in the command
line, request JSON, or response JSON.

The broker dispatches these existing calls; it must serialize each mutation
and wait for it to complete before answering:

| Service | Existing calls |
| --- | --- |
| `dashboard` | `GET /api/cron/jobs`, `POST /api/cron/jobs`, `PUT /api/cron/jobs/:id` with `{ "updates": ... }`, `POST /api/cron/jobs/:id/pause`, `POST /api/cron/jobs/:id/resume` |
| `dashboard` | `GET /api/config?include_defaults=false`, `PUT /api/config` with a field-scoped `mcp_servers` environment patch, `GET /api/mcp/oauth/flows/:id` |
| `wayroost` | `GET /api/connectors` for authentication status |
| `paseo` (optional) | The daemon client's `scheduleList()`; request method `scheduleList`, path `""` |

Optional direct Paseo schedule inventory requires an existing `--owner-api`
integration with the daemon's `scheduleList()`; the built-in browser transport
supports the dashboard and Wayroost APIs only and refuses direct daemon calls.
Paseo schedules remain in their daemon and cannot be selected for mutation here.

Trigger operations import the selected installed copy of
`helper/signalbox-helper.py` and call its `list_triggers`, `install_gate`,
`put_trigger`, and `delete_trigger` functions. No helper listener or helper bearer
token is needed. `--helper-role-config` names its scoped public role configuration;
environment/configuration shadow restrictions still apply. The helper must
confirm primary before any forward or reverse mutations. Inventory retains only
the roles from the helper listing, never its queries.

## Inventory and reviewed selection

Use explicit absolute paths. The transaction directory belongs to the owner and
must be mode 0700. The tool creates journals, metadata receipts and lock files
mode 0600. Keep this directory outside source control and separate from every
selected helper folder. Overlapping paths are refused before any job is paused.

```bash
python3 deploy/jobs-transition.py inventory \
  --home /home/me/demo-home --state-dir /home/me/jobs-transition \
  --helper-source /home/me/runtime/signalbox-helper.py \
  --helper-role-config /home/me/runtime/wayroost-role.json \
  --dashboard-origin http://localhost:8080 --wayroost-origin https://example.com
```

Add `--include-paseo` for retained daemon schedules. Job output contains only id,
name, script, workdir, schedule, delivery target, enabled state, tool level/pin,
and helper-confirmed role. Missing or unconfirmed trigger roles are `unknown`.
Non-trigger cron jobs have `unknown` role because the helper has no ownership
record for them. Connector output contains only id, enabled/trust state,
authentication status and callback origin. There are no actions, searches, run
output, conversations or credentials in inventory, plan output or journals.

Create a private selection file yourself; do not export cron prompts into it.
The job ids are the inventory ids, including the complete trigger name prefix.
A selection can omit unrelated jobs and paused triggers. Every active trigger
whose role is shadow or unknown must have a selection decision; plan and forward refuse
and verify fails while any such trigger is undecided. Refusals contain only
the undecided ids and roles. An omitted decision on an unknown-role job
defaults to `leave-paused`; a known-role job requires an explicit decision.

```json
{
  "version": 1,
  "jobs": [
    {"id": "fake-primary-id", "decision": "keep"},
    {
      "id": "fake-shadow-id",
      "decision": "recreate",
      "query": "label:demo",
      "action": "Summarize new messages for me.",
      "accept_baseline": true
    },
    {"id": "fake-unknown-id", "decision": "leave-paused"}
  ]
}
```

`keep` requires a helper-confirmed primary trigger. For a regular scheduled job,
`confirm_primary: true` records the owner's explicit resolution of its unknown
ownership; a primary helper must still confirm the target runtime before apply.
Pulse jobs use this resolution and keep their identities. `recreate` requires a
reviewed action; mail also requires a reviewed query and baseline acceptance.
A primary trigger uses `keep`. Optional reviewed `skills` and a `tools` level (`none`, `web`, `travel`, `all`)
may be supplied on recreation. Existing tool pins are retained unless a level is
selected. A reviewed level replaces the tool pin for regular jobs as well as mail
triggers, in both forward and reverse. Unpinned mail triggers default to `none`
and use the primary creation prompt; recreated mail triggers never inherit
script-only execution. Regular
jobs retain script-only execution, schedule and delivery;
no unreviewed skill list or prompt is read from a source job.

Unknown ids, repeated selections, missing actions/queries, shadow `keep`, unsafe
helper folders and an unselected active copy with the same name are refused.
Each selected trigger folder must have only one scheduler registration, even
when another registration uses a different name or is paused. Equivalent paths
with a trailing slash or dot also share a folder. Reverse and retries check the
full scheduler listing before mutations, including historical and planned
replacement folders; resume checks again before activation. Resolve conflicting
registrations before retrying.
Behaviour names must be unique among wanted selected copies. This conservative
name check cannot establish whether differently named, unselected jobs perform
the same action; resolve those during selection review.

Replace `inventory` with `plan --selection /home/me/jobs-selection.json` to
validate and print the metadata-only proposed moves. Plan does not pause or
create jobs. Static preconditions are checked in plan and again at forward start,
before writing a journal or pausing any job: selection consistency, bridge
presence and wiring values, checkpoint file shape, gate publication destinations,
the entire rollback helper source tree, shared folders, same-name
registrations and undecided active triggers. Use the exact reviewed selection for forward retries: only its
digest is saved, never its actions or queries.
Each selected id's receipt destination must be absent or an owner-held directory
with mode 0700. Files, symlinks and directories with other permissions refuse
before the journal is written. Existing destination directories must be readable,
writable and traversable.
The scripts directory must be absent or a directory without a symlink. Gate,
runtime and temporary publication files must be absent or regular files without
symlinks. These paths are checked again during publication while writers are paused.
Recreated helper folders must contain only regular files and directories at every
depth, including retained logs. Symlinks and special files refuse preflight, and
the source tree is checked again immediately before recording its rollback hashes.
Every retained file must be readable and every directory readable and traversable.
The helper's mail gate and runtime publication sources must be regular, readable
files without symlinks; preflight and publication both check them.

## Pulse wiring

Keep `pulse-morning-brief`, `pulse-scout` and `pulse-relay` by name, using `keep`
and `confirm_primary: true`. Forward retains the source's enabled state. Use
`leave-paused`, or omit `activate`, for jobs paused by the proactivity level.
An explicit `"activate": true` can enable a paused `keep` or `recreate` source;
that override is recorded in the journal and shown in the plan. `leave-paused`
cannot be combined with activation. Supply this additional top-level selection field:

```json
{
  "pulse_wiring": {
    "bridge_id": "signalbox",
    "primary": {
      "bridge_url": "http://127.0.0.1:19112",
      "token_file": "/home/me/primary/bridge-token"
    },
    "legacy": {
      "bridge_url": "http://127.0.0.1:19012",
      "token_file": "/home/me/legacy/bridge-token"
    }
  }
}
```

Use the bridge registration actually present at the transition. Both sides must
already have their privately published token files. The tool changes only
`WAYROOST_BRIDGE_URL`, `WAYROOST_BRIDGE_TOKEN_FILE` and their existing compatibility
aliases in that registration's `env`, through the dashboard configuration API.
Other registration keys and environment entries keep their values. It never
opens either token file. Before the configuration PUT, it journals the four
allowlisted original values, including which keys were absent. Every present
value must match `pulse_wiring.legacy`; plan and forward start refuse a mismatch
or missing bridge before any journal write or pause. The values are checked
again while paused before that PUT, in case they changed during the transaction.
Reverse restores these exact values or absence, regardless of newly supplied
legacy wiring, and restores the relay's original registered script. MCP
environment changes take effect only after `/reload-mcp` or a gateway restart.
The operator performs that reload as part of the quiet window.

The relay's Python script is retained without reading or copying its source.
Since this repository has no per-job environment API or published relay script
implementation, the tool publishes a small private Python launcher in the
owner's scripts directory, then changes only the paused relay's script wiring.
The launcher sets the same four environment fields and executes the original
registered script with the same interpreter and arguments. The original must
be a regular `.py` file registered by basename. Its name, schedule, delivery,
execution mode and `/home/me/demo-home/pulse-relay-state.json` stay in place.
The original script must use these documented bridge environment fields.

## Forward, verify and reverse

Before forward, finish or cancel **every** OAuth sign-in in Wayroost and Hermes.
Their callback admission is process-local, and this repository offers no complete
pending-flow listing. Without `--no-pending-oauth-confirmed`, forward refuses.
For known flow ids, add repeated `--oauth-flow fake-flow-id`: their existing
status API must report `approved` or `error`, even when the confirmation flag
is present. A missing/unreachable status also refuses. Omit cancelled/expired
ids only after the owner has confirmed they are no longer pending. Keep new
sign-ins held throughout the quiet window.

```bash
python3 deploy/jobs-transition.py forward \
  --home /home/me/demo-home --state-dir /home/me/jobs-transition \
  --helper-source /home/me/runtime/signalbox-helper.py \
  --helper-role-config /home/me/runtime/wayroost-role.json \
  --dashboard-origin http://localhost:8080 \
  --selection /home/me/jobs-selection.json --no-pending-oauth-confirmed
```

Every selected source is paused and checked idle before checkpoint receipts or
wiring changes. Keep changes only the gate wiring while paused. Recreation
first writes a private metadata receipt with hashes of the old helper folder,
leaves the historical registration paused and its folder intact, and creates
a separate primary folder and registration. Historical folders remain in their
original location throughout the transaction and must stay unchanged under the
operator's writer hold. File bytes, searches, actions, run output and credentials
are never copied into receipts; hashes check the retained folder without parsing
its contents. Regular cron
recreation uses the same scheduler creation API. There is no cron-store rewrite.
Keeping the historical folder in place and verifying its hash supersedes the
original delete-after-receipt procedure; no helper-folder copy is made or deleted.

The scheduler enables registrations at creation, so replacements are created
behind a private inert Python gate that returns `{"wakeAgent": false}` and performs
no wanted action. All competing registrations are paused first. Stable new helper
folder ids, or temporary registration names for regular jobs, identify a creation
even if its response was lost. Once its id is recorded, each replacement is paused
and idle before its intended script and name are installed. Forward resumes it
only if the original source was enabled or `activate: true` was selected;
reverse resumes recreated jobs only if the current wanted source was enabled.
Kept jobs restore their original receipted enablement, including a paused job
explicitly activated by forward. Rows selected as `leave-paused` also restore their
receipted enablement on reverse, except shadow-tagged triggers, which stay paused.
Reverse preflight refuses restorations that would leave multiple registrations
enabled for the same behaviour before changing any writer. A recreated
registration that will finish paused can share a name with a restored copy.
Reverse resumes `leave-paused` rows only after every replacement has been created
and paused, so their temporarily enabled creation cannot overlap a restored copy.
The inert
gate holds execution through interruption and recovery, including for script-only
jobs. Old/new mappings are printed without private receipt paths.

The journal durably records intent **before** each scheduler/helper/script
mutation and completion afterward. Rerun the identical command after an
interruption, including one after a mutation but before its completion record.
Forward and reverse use the same exclusive transaction lock. Do not delete the
journal, bypass a refusal, start a second transaction for the same jobs, or
change the selection while an operation is recovering.

Before asking the helper to create a replacement folder, the journal reserves
its absent destination. A retry can finish a reserved, owner-held empty folder or
one containing only the helper's exclusive `.spec.json.<random>.tmp` files,
where `<random>` is exactly eight lowercase letters, digits or underscores, as
defined by the helper's shared `atomic_temp_pattern`. Each temporary must be a
regular file owned by the job owner, with mode `0600`, a link count of one
(`st_nlink == 1`), and read/write access. Existing unreserved
folders, unexpected contents and symlinks refuse recovery without being removed.
An already published primary specification is retained and synced on retry.

Run `verify` with the same common arguments, without `--selection`. It checks
wanted activation counts, historical pause state, gate/role wiring, receipts,
pulse names and checkpoint continuity. Wanted triggers must retain their original
folder or use their journaled replacement folder, and kept checkpoint hashes come
from that registered folder. Historical paused rows are checked
individually and activation counts are checked once per behaviour name. It also
requires unique registrations for selected helper folders, including historical
and replacement folders, regardless of registration name or enabled state.
Folder comparisons resolve filesystem aliases, including symlinks outside the
helper store and paths whose destination is currently absent. Kept-trigger and
pulse checkpoint equality is checked in a journaled step while the registration
is paused, immediately before resume. Activation rechecks the checkpoint even
when recovery skips a completed checkpoint step. If the resume request already
enabled the registration before an interruption, its checkpoint may advance normally.
Verify requires that equality only until
the resume step has started. After resume, normal scheduled runs may advance
the checkpoint: verify checks the same registered folder and a regular checkpoint
file, without requiring equality with a historical hash. A kept trigger whose
checkpoint was absent when paused may remain without one until its first poll;
the tool leaves that absence intact so the gate establishes its normal mail
baseline. Once present at the paused checkpoint snapshot, the file must remain
regular after resume. Forward uses the receipt's snapshot and reverse uses its
fresh paused snapshot; reverse refuses loss of a checkpoint that was already
present in the forward receipt before recording that new snapshot. Verification never
reads checkpoint content as messages. Check the first scheduled cycle through
the application's normal status UI.

Every selection involving a pulse job checks `pulse-relay-state.json` up front:
it may be absent or a regular file. Directories and symlinks refuse before any
journal write or pause, including when only the scout or morning brief is selected.
An initially absent checkpoint remains absent while the selected relay is paused;
the tool creates no state file. After relay resume, a first run may create it.
If present at the paused snapshot, it must remain a regular file after resume.
Reverse refuses a missing file recorded in any forward pulse receipt before
changing direction, and rechecks its presence before recording the paused snapshot.
This also applies to scout-only or brief-only selections and deleted pulse registrations.
The shared checkpoint belongs to `pulse-relay`; its resume step controls the
checkpoint equality check. A paused scout or brief does not prevent the active
relay from advancing that file.

For reverse, retain the legacy `signalbox_mail_trigger.py` gate in the owner's
scripts directory and keep a role-aware primary helper available. Supply a
newly reviewed selection for the same original ids and decisions: update its
recreation actions and searches to the **current wanted behaviour**. The tool
reads current names, schedules, delivery and tool restrictions from the primary
registrations, without reading their prompts or searches. It records the reverse
selection's digest for retries. For recreated rows, a currently paused wanted
registration stays paused after reverse. Kept rows restore their receipted
enablement. Rows selected as `leave-paused` restore their receipted enablement,
except shadow-tagged triggers, which remain paused.

Replace `forward` with `reverse` and omit the OAuth confirmation flag. Reverse
pauses all selected writers first and journals fresh checkpoint hashes for kept
triggers and pulse state. These hashes are compared while paused before each
kept writer resumes;
post-resume verification allows normal checkpoint advancement. The original
forward receipts are retained unchanged. It creates legacy-gate-compatible primary
registrations for the current wanted behaviours, and checks that retained historical
helper folders are intact with their historical registrations **paused**. Current connector
credentials are retained; none are restored from a snapshot. Confirmed primary
and pulse registrations keep their identity and restore their receipted enablement.
Kept triggers restore their original registered script, including an original
primary gate. Pulse restores the receipted bridge/token fields and original relay script.
Recovery and verification check these recorded values. At no point are two wanted copies
enabled together.

Before changing the journal to reverse or pausing any writer, the tool checks
all recorded registration ids. A deleted forward replacement is the current
choice `none`: no reverse replacement is created, and the mapping records a null
new id. Unselected active registrations sharing an original or current selected
name refuse reverse before the direction is journaled; only their ids and roles
are printed. Pause those registrations before retrying. Choice `none` rows add
no per-name active-copy expectation during verification. A deleted historical registration is explicitly recorded, its pause and
helper restoration checks are skipped, and its metadata receipt and historical folder
are retained. Existing
historical registrations of recreated rows remain paused. Further unexplained registration
removal during reverse recovery refuses before additional pauses.
Surviving pulse registrations must retain their recorded names before reverse
starts and on every retry. Restore a changed name before retrying; reverse never
renames a pulse registration.
Every surviving historical registration must also retain its receipted name.
A changed historical name refuses reverse before changing direction or pausing
jobs, including on retries; restore that name before retrying. Current wanted
replacement names can still be carried into new legacy-compatible registrations.
Surviving historical triggers must still register the exact receipted workdir.
Their retained historical folders must match the recorded hashes. A missing or
changed retained folder refuses before any journal write; restore the original
folder before retrying. These checks run before changing direction or pausing
jobs, on every reverse retry, and again while their registrations are paused.

An interrupted forward must be resumed to completion before beginning reverse.
An interrupted reverse resumes with its unchanged reverse selection. Repeat
`verify` before releasing the writer holds. Retain journals, receipts and paused
historical registrations for rollback evidence; cleanup is an explicit later
owner operation.

## Checks

All fixtures are invented, use temporary directories and start no listeners.
Vitest passes its own Node executable to Python as `NODE_BIN`. When running the
Python checks directly, set `NODE_BIN` before the harness clears its environment:

```bash
NODE_BIN="$(node -p 'process.execPath')" python3 -m unittest discover -s helper -p test_jobs_transition.py
npx vitest run scripts/jobs-transition.test.ts
```

The checks cover metadata privacy, invalid selections, primary/shadow/unknown
roles, mail baseline, round trips, current reverse choices, pulse checkpoints,
root/OAuth/concurrency refusals, lost creation responses, and interruptions before,
after and following completion of every forward and reverse journal step. They
also cover differently named shared-folder registrations before reverse, during
recovery after interruptions and lost creation responses, and before activation.
Symlink aliases are checked before forward and reverse, during recovery and
activation, and in verification, including absent historical folders.
They cover checkpoint advancement before reverse, same-name historical cleanup,
overlapping receipt paths, configured connectors outside the catalog and the
built-in browser transport's API contracts and privacy projection. Browser tests
use a simulated browser and fetch; they bind no port or access an existing session.
Kept triggers without an initial checkpoint are covered through forward, reverse,
activation interruptions and first-poll baselining; existing checkpoint loss and
unsafe replacements still refuse verification.

The Vitest wrapper runs the transition tests with `python3.10` when available.
If that interpreter is absent, it prints a skip notice and uses `python3`.
Browser launch tests inspect Playwright options through a simulated
context, including profile permissions and cleanup, without starting Chromium.
An enumerated refusal scan follows forward and reverse calls, including callbacks
and both owner transports. It checks preflight guards for subsequent refusals;
only responses to mutations are classified as run outcomes. It also checks guard
routing and enclosing predicates. Mutation tests prove that new refusal calls,
changed predicates, removed or unreachable guards, recovery restricted to one
direction, and omitted retry validation fail the scan. Behavioural tests exercise
unused staging refusal before writes on initial runs and retries, and private
sentinels in historical helper specifications, checkpoints and logs.
