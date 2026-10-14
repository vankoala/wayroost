# Owner-held Wayroost settings (version 1)

With `settings.legacyRoutesViaPipeline: true`, Wayroost reads its preferences
through the supervisor's `config.read` view `wayroost.settings`. Changes and
undo use `config.apply` and `config.undo` on the `wayroost-settings` target.
The target's configured owner, shared file lock, backups and audit are used by
the existing executor. The server needs no access to the owner's home.
The supervisor's config verbs and `configWrites: true` are required for writes;
the rollout switches, device scope, local-listener policy and shadow refusal
still apply. If the supervisor stops answering, the server never changes to a
private settings writer.

The target is configured in `settings-targets.json` as an owner file with JSON
format, a file lock, backup and audit directories, and normally mode `0600`.
Its location is a site choice, for example `~/.wayroost-config/settings.json`.
The strict shared schema is `shared/wayroost-settings.ts`. `CATALOGUE_VERSION = 10`
requires the matching rebuilt supervisor; an older supervisor fails closed with
`parse_failed` rather than falling back to private settings. The supervisor
validates the entire document on read, before/after editing and before undo.
Unknown fields, unknown versions, invalid nested fields and invalid notification
rules are refused with fixed error codes; parser or upstream text is not shown.

Only `version` is required. No schema defaults are inserted into the document.
Absence, explicit `false`, empty arrays and `quietHours: null` remain distinct.
Undo restores the original bytes, including absent fields. Ordinary settings
saves never create a missing owner document. Partial preferences saves merge
only the named preference group with its current owner snapshot, preserving
other groups and absent siblings.

| Field | Version-1 shape | Effective value when absent/unavailable |
| --- | --- | --- |
| `version` | Exactly `1` | A missing/unsupported version makes the document unavailable |
| `safetyCommandsEnabled` | Boolean | `false`; Safety commands refused |
| `rules` | Unique event/source rules from `shared/settings.ts` | Mandatory needs-you alerts, completion/error/settings/mismatch toasts from `DEFAULT_NOTIFICATION_RULES` |
| `quietHours` | `{start,end}` in `HH:MM`, or `null` to explicitly disable | `21:00`–`07:00` |
| `push` | Optional booleans `approvals` and `cards` | In a valid document: approvals `true`, cards `false`. When unavailable: both `false` |
| `timeZone` | A time zone accepted by `Intl.DateTimeFormat` | Runtime local zone, reported as unconfigured; no site-file fallback in pipeline mode |
| `feed` | Optional `level` (`off`, `low`, `normal`, `high`) and `lessLike` list | `off`, empty list |
| `feed.lessLike` | Up to 30 `{topic,example,at}` entries; topic 1–40 chars, example up to 100, nonnegative integer UTC milliseconds | Empty list |
| `workerUpdates` | Optional `enabled` boolean and `defaultMinutes` from `WORKER_TIME_BOXES` | Delivery held, 60 minutes; only verified explicit `enabled: false` permanently suppresses news |
| `voice` | Optional `voice` (local voice name, or empty string) and `appReadAloud` | Speech-service default local voice, local read-aloud |
| `voice.appReadAloud` | `{provider:"local"}` or `{provider:"elevenlabs",voiceId,modelId}` with valid IDs | Local output; never opt in to cloud output |

An agent-needs-you rule must retain an app toast; quiet hours hold only card
alerts. Safe defaults never enable Safety commands, worker delivery, feed
automation, card pushes or cloud read-aloud. Unavailable settings disable all
automatic outbound pushes, including approval pushes and toast escalation to
an absent desktop's phone, while preserving mandatory app requests for an
answer. Missing settings cannot change other consumers' approval or
tool policies. Paseo provider flags and worker **approval policies** remain in
the separate owner-held Paseo config target, and Hermes settings remain in
the Hermes target.

This document contains every persisted server-owned Wayroost preference: Safety commands;
notification rules, hours, push switches and time zone; feed level and topic
feedback; worker update enablement/time box; local voice and app read-aloud.
Operational state is separate: feed cards and push deduplication, task records,
device pairings, push credentials/subscriptions, credentials, conversations,
identity mappings, caches and audit records are not preference fields.
Bridge pause is a runtime control. Backend-owned connector, phone, skill and
provider settings remain with their respective owners.
Per-device microphone and playback preferences remain per-device.

After a validated read, the server shares one in-memory snapshot with Safety,
notifications, feed, worker updates and voice. Apply/undo checks the resulting
snapshot against the executor's written hash and durably records completion
before publishing it to consumers. The prior verified snapshot remains in use
while the write is pending; an audit failure invalidates every consumer snapshot.
An unavailable or uncertain read discards the usable snapshot and selects the
safe defaults. Pages report unavailable with the fixed reason (`target_missing`,
`parse_failed`, `unavailable`, `config_writes_off`, etc.). A subsequent successful
read can restore availability without writing settings. While unavailable,
serialized reads retry in the background with exponential backoff capped at
30 seconds, beginning one second after startup. Worker settings have three
states: verified-on, verified-off and unknown. Unknown holds saved news and due
nudges without marking them skipped or withdrawing bridge posts. Worker
suppression observers run only on verified updates, never on invalidation.
A changed feed level is applied to
pulse jobs after the durable apply/undo record; a consumer failure is recorded,
is visible and leaves the owner-file change undoable. The separate operational
journal `settings-consumers.jsonl` records change IDs and pending flags before
owner completion is recorded, and clears work only after the pulse application
succeeds. It contains no preference values. The write audit records whether a
pulse-level
change was required before dispatch, so feedback-only changes do not adjust jobs
after a lost reply. Request-status recovery and confirmed manual acceptance
preserve that intent before resolving the owner write. Missing schedules refuse
consumer application and retain pending work. Checks reports unfinished pulse
work; the consumer tracks the last successfully applied level. Automatic
resolution verifies the owner snapshot against the terminal write's hash before
retrying pending pulse work. Confirmed manual acceptance also retries it. Both
paths report consumer refusal and retain unfinished work.
Pending pulse changes
survive interruption and restart, and are retried by saving the level again or
using the Checks Fix, even when the level is unchanged. Unrelated verified
saves report their own applied result with `warnings: ["pulse_pending"]` while
that work remains; they do not attempt pulse application or report pulse refusal.
Feedback saves still dismiss their cards. Recovery records and publishes the
original change's outcome, then runs an unrelated request and returns its own
result. Recovery refusals are returned only to reads of that target or requests
concerning that change. A work-journal failure makes settings
unavailable and selects safe defaults.
Startup and ordinary reads never create pulse work. Recovery of an explicitly
recorded write retries its pending work, including after restart. Recovered and
manually accepted voice changes propagate the verified local voice to the phone;
phone-update failures leave the verified app voice applied and report
`calls: "failed"` with a message to retry saving the voice.

Pipeline startup never seeds, imports, merges or reconciles any preference
store. Legacy private preferences are not consulted in pipeline mode; all their
setting setters are blocked or bypassed. Operational feed saves retain the old
`feed.json` settings as opaque JSON, including unknown fields, for explicit
reverse migration. Cards and local speech remain available during a preferences
outage; their settings controls show the reason and cannot save. Legacy mode
retains its existing files,
startup feed seeding and writers. Switching back requires explicit reverse
migration first. Untagged historical Wayroost settings changes belong to the
legacy private store: their Undo remains available in legacy mode and is refused
in pipeline mode. Tagged changes also require a matching backend and server role.
The one-time migration must create the owner document with writers stopped,
preserve absent versus explicit choices, validate it and verify semantic
equality using effective values. When absence has a different default, migration
writes the effective legacy choice explicitly: `workerUpdates.enabled` is on
unless the legacy file says off, and `feed.level` defaults to `normal` in legacy
mode. A site-file `notifications.timeZone` is carried as explicit `timeZone`.
Other absent choices stay absent when their effective meaning is unchanged.
This document supplies the migration format, not a startup migrator.

The following example is entirely invented:

```json
{
  "version": 1,
  "safetyCommandsEnabled": false,
  "rules": [
    { "event": "agent-needs-you", "source": "*", "delivery": "both" },
    { "event": "agent-finished", "source": "paseo", "delivery": "toast" }
  ],
  "quietHours": { "start": "21:00", "end": "07:00" },
  "push": { "approvals": true, "cards": false },
  "timeZone": "Etc/UTC",
  "feed": {
    "level": "low",
    "lessLike": [{ "topic": "Example topic", "example": "Invented card", "at": 1790000000000 }]
  },
  "workerUpdates": { "enabled": false, "defaultMinutes": 60 },
  "voice": { "voice": "af_heart", "appReadAloud": { "provider": "local" } }
}
```
