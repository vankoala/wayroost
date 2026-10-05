# Alerts: who hears about what

An agent finishes, fails, or needs a yes. Something on this PC starts or stops
answering. A card lands in [For you](for-you.md). Wayroost decides, once and on
the server, where each of those alerts goes: the app on this PC, the phone, both,
or nowhere — from the rules you wrote, whether anyone is sitting at this PC, and
whether these are your quiet hours.

Settings → Notifications is the page for it. Any paired device can read the
rules and change them: deciding where an alert goes doesn't need the PC in front
of you, and the PC's own desktop app is what reports whether anyone is at it.

## Using it

- **Notification rules**: one row per alert, saying which event it is, whether it
  applies to every source or to one of them (Hermes, Paseo, the brief, a daytime
  check, an agent, this PC), and where it goes — *the app and the phone*, *the app
  only*, *the phone only*, or *nowhere*. A rule for one source answers for that
  source alone; a rule for *every source* covers the rest.
- **An agent waiting on you can't be switched off.** A permission to allow or a
  question to answer always reaches the app, and the page won't offer a rule that
  would put it on the phone alone or nowhere. Your phone's own Do Not Disturb is
  still yours.
- The page starts by naming where the next alert would go (*"You are at this PC,
  so an alert the app can show stops there"*), how many devices can be pushed to,
  and whether quiet hours are read in a time zone the site file names.
- A change takes effect on the next alert. Nothing restarts.

Every install starts like this:

| Alert | Where it goes at first |
| --- | --- |
| An agent needs you | The app and the phone |
| An agent finished, or failed | The app |
| A change applied, or failed; a mismatch found; this PC's status | The app |
| A For-you card, or a security card | Nowhere, unless the For-you page's switch says the phone should hear about cards |

## How one alert is routed

The three inputs are applied in this order.

1. **The rule.** Exact source first, then *every source*, then the defaults
   above. Quiet hours and the switches can take the phone out of an alert; they
   never put the app's half back in.
2. **Who's at this PC.** The desktop app reports presence — active, idle or
   locked — and only a desktop's report counts: a phone's says nothing about
   anyone sitting here. The latest report wins, and one older than two minutes
   counts as no report at all.
   - *active*: an alert the app can show stops there.
   - *idle* or *locked*: the same alert goes to the phone too.
   - *gone* (no report for two minutes, or no desktop at all): the phone takes it,
     and only an agent waiting on an answer still shows in the app — wherever that
     app happens to be open.
3. **Quiet hours** (21:00 to 07:00 unless you change them, or set them to none on
   the For-you page). They hold the phone's push of a **card** alert — a For-you
   card or a security card — and nothing else. An agent waiting on you, an alert
   about a run you started, and a change you asked Settings to make all go
   through; your phone's own Do Not Disturb can hold those.

Reading the route changes nothing: the settings page can ask where an alert would
go without sending it.

Quiet hours are read in **your** time zone, not the server's. `notifications.timeZone`
in [the site file](configuration.md#fields) names it (an IANA name this PC knows,
like `Europe/Berlin`); unset means the zone this PC is set to. A span that runs
past midnight holds the evening and the early morning; one whose ends are the same
time holds nothing.

## Where the settings live

Wayroost's own settings file, `wayroost-settings.json` in the state folder (mode
600), holds the rules, the quiet hours, and the phone's switches over approvals
and cards. Every change goes through the write-through core, which keeps a backup
of the bytes it replaced, replaces the file atomically, and appends one line per
change to `settings-audit/settings.jsonl` naming the target, the keys, the device
that asked, and whether it worked. A file that can't be read or understood routes
alerts as the defaults would and is never replaced by one of these writes; a write
that changes nothing writes nothing.

The same hours and the same card switch appear on Settings → For you, and it's the
same setting whichever page wrote it. Alerts are routed by this file, so the
For-you page's copy follows it.

`GET /api/settings/notifications` answers with the rules, the hours, the switches,
how many devices can be pushed to, whether this server can push at all (it needs
an `https://` address), and where the next alert would go.
`PUT /api/settings/notifications` takes all three keys —
`{ "rules": [...], "quietHours": { "start": "22:00", "end": "06:30" } | null, "push": { "approvals": true, "cards": false } }`
— and answers with the same view. Rules for an event or source that isn't named,
the same rule written twice, a time that isn't one, or a rule that would switch
off an agent waiting on an answer are refused with 400 and nothing is saved. A
file that won't take the write answers 409 with the reason in words.

## The app's half

An alert the server decides the app should show leaves as a `notification` event
on the stream the page already reads: the event's kind, its source, a title, at
most one line of plain text, a path to open, and the time. The page shows what it
receives and decides nothing itself; a phone shows what the push service brings
it. What the rules kept off the PC's screen never arrives.

Approval alerts carry which agent needs you and the request's short title, never
the command or the answer's text — see [For you](for-you.md) for what a push
carries and how Web Push reaches a phone.
