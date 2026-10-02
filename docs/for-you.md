# For you

For you is where Hermes brings you things on its own, instead of waiting to be
asked. A morning brief and short checks during the day look at your calendar,
mail and the things you said you'd do. They message you on WhatsApp when
something is worth it, and add **cards** here that you can act on with a tap:
a reply to send, a meeting to prepare for, a promise coming due. You set how
often Hermes speaks up, when it stays quiet, and which topics it should leave
alone. Signalbox can also put a notification on your phone when an agent is
waiting on you.

It's off unless you turn it on (see [Setting it up](#setting-it-up)).

## Using it

The sparkles button in the top bar opens For you. Its badge counts cards you
haven't seen yet, and a "N new things for you" strip under the inbox's
approvals banner names the first one.

Each card shows its kind (a reply, something to prepare, a reminder, a heads-up
or a warning about a likely scam), where it came from (the morning brief, a
daytime check or an agent) and when. Then:

- **Do it** shows what Hermes will be asked to do ("Hermes will get: …").
  **Send to Hermes** starts a Hermes chat and takes you there. The message is
  the card's title and details, that request, the email's Gmail id for mail,
  and a line asking Hermes to check with you before it sends or changes
  anything: nothing you can't see on the card. Hermes' approvals work as in
  any other chat. The card then closes, except a reminder, which stays up with
  **Open chat** until you tap **Done**.
- **Done** (reminders) closes the card, and the pulse ticks the matching line
  off Hermes' open-loops list so it stops coming up.
- **Not now** hides the card for 3 hours, or until quiet hours end if that's
  later.
- **Less like this** hides the card and tells Hermes to stop raising that topic
  (for example "GitHub notifications"). The topics are listed in Settings → For
  you, and × brings one back.
- **×** dismisses the card. Done and dismissed cards don't come back, even if
  the brief sees the same email again.

Opening For you counts as seeing what's new. Cards stay up to 30 days, closed
ones are forgotten after 14, and at most 300 are kept.

## Settings → For you

- **How often Hermes speaks up**:
  - *Off*: no brief and no daytime checks.
  - *Brief only*: the 7am brief.
  - *Normal*: the brief, plus a check every two hours from 10:00 to 20:00.
  - *Often*: the brief, plus a check every hour from 9:00 to 21:00.

  This pauses, resumes or reschedules Hermes' pulse jobs (below) in place, as
  Settings → Scheduled jobs would. It's greyed out if those jobs aren't there.
- **Quiet hours** (21:00 to 07:00 unless you change them): no notifications
  about cards, and **Not now** won't bring a card back during them.
  Notifications that an agent needs you still come through, since that's
  work you started; your phone's own Do Not Disturb can hold those.
- **Notifications on this device**, turned on per phone or computer. Then
  choose what they're for:
  - *When an agent needs you*: an approval or question in Hermes or Paseo,
    quiet hours or not. The notification says which agent and gives the
    request's short title, never the command. Tapping it opens the chat.
  - *New For-you cards*: off to start with, since the brief already comes on
    WhatsApp.

  **Send a test** checks the path end to end. On an iPhone or iPad, add
  Signalbox to the Home Screen first (Share, then Add to Home Screen; iOS 16.4
  or later) and turn notifications on from there; Safari tabs can't get them.
- **Less like this**: the topics you turned down.

## How it works

### Where cards come from

Cards come in through two routes on the [project bridge](bridge.md)'s local
listener. They take the same bearer token and the same checks as the bridge
tools, but aren't offered to agents as tools:

| Route | What it does |
| --- | --- |
| `GET /pulse/v1/preferences` | Your proactivity level, quiet hours, the topics you turned down, the cards from the last week with their status (`new`, `seen`, `later`, `done`, `dismissed`), and `done`: the keys you closed with **Done** (not those handed to Hermes with **Do it**). |
| `POST /pulse/v1/cards` | `{ "source": "brief" \| "scout" \| "agent", "cards": [...] }`, at most 20 cards per call. Returns `{ created, updated, rejected }`. |

A card is `{ key, kind, title, detail?, action?, topic? }`:

- `key` is `<type>:<id>`, for example `mail:18f2ab34cd56ef78`, `event:<calendar
  id>` or `loop:<hash>`. Posting the same key again updates that card (its text,
  not your choices), and a key you closed stays closed.
- `kind` is one of `reply`, `prepare`, `reminder`, `heads-up` or `warning`.
- The title (up to 100 characters), detail and action (400 each) and topic (40)
  become one line of plain text each: control characters, characters that hide
  or reorder text (zero-width, direction controls, Unicode tags) are removed
  and links become `[link]`. A card that breaks a rule is rejected on its own;
  the rest of the call still goes through.

### The pulse

In the setup Signalbox was built for, Hermes cron jobs feed it:

- **pulse-morning-brief** (7:00) and **pulse-scout** (the daytime checks).
  Their scripts read today's calendar, unread mail that Gmail marks important
  or primary (sign-in codes and password resets left out), the open-loops
  list, and `/pulse/v1/preferences`. Every item in that data ends with its key.
  The jobs run with no tools that act (`todo` and `no_mcp` only). The scout's
  monitor wakes the model only when something actually changed. Each run
  replies with a WhatsApp message (or `[SILENT]`), a line `---CARDS---`, and
  the cards as JSON, and delivers it locally.
- **pulse-relay**, a script-only job every 2 minutes, picks up those replies,
  posts the cards to `/pulse/v1/cards`, and hands the message to Hermes to send
  on WhatsApp. Nothing new means nothing is sent. It also ticks off the
  open loops you marked **Done**. Its own state (`~/.hermes/pulse-relay-state.json`,
  mode 600) holds which runs it has handled, and cards Signalbox couldn't take
  yet, for up to 12 hours; its log has counts only.

The proactivity level finds the first two jobs by these names.

### Phone notifications

Signalbox sends Web Push itself, using Node's own crypto and no third-party
library. The payload is encrypted for the browser (RFC 8291, `aes128gcm`), so
the push service carries only ciphertext, and Signalbox signs each request
with its own VAPID key (RFC 8292). It sends only to the push services of
Chrome and Android (`fcm.googleapis.com`), Firefox (`*.push.services.mozilla.com`),
Safari (`*.push.apple.com`) and Edge (`*.notify.windows.com`), over HTTPS. A
device the push service reports gone (404 or 410) is dropped. At most 10
devices are kept.

The service worker, `/sw.js`, does two things: it shows a notification and
opens the Signalbox page it points to when you tap it. It has no fetch handler,
so it never caches pages or sees requests.

### Files

| File | In | Contents |
| --- | --- | --- |
| `feed.json` | the state folder (`/var/lib/signalbox`), mode 600 | The cards, your settings and turned-down topics, and which approvals have been notified. |
| `push.json` | the state folder, mode 600 | The VAPID key pair and each device's push subscription. An unusable one is set aside as `push.json.bad` and a new key made (phones then turn notifications on again). |
| `pulse-relay-state.json` | `~/.hermes`, mode 600 | The relay's side: which runs it has handled, and cards Signalbox couldn't take yet (for up to 12 hours). |

## Setting it up

1. Turn on the [project bridge](bridge.md) if it isn't already: the pulse posts
   cards through it.
2. Add `"feed": { "enabled": true }` to `/etc/signalbox/config.json` and restart
   Signalbox (`sudo systemctl restart signalbox`).
3. Phone notifications need `publicOrigin` to be `https://`, as it is behind
   Cloudflare.

The For-you button appears once the server has the feature on. Without anything
posting cards it stays empty, but phone notifications for approvals still work.

## Privacy and security

- **Cards are untrusted text.** A model wrote them from your mail and calendar,
  so an email can try to steer what a card says. Cards are plain text with
  length limits, and nothing on a card runs by itself. **Do it** shows the exact
  request first and sends nothing until you tap **Send to Hermes**. Hermes is
  asked to check with you before sending or changing anything, and its
  approvals still apply.
- **Who can post cards.** Anything holding the bridge token can post: the
  pulse, and any agent running as your user (the agents' copy of the token is
  in `~/.config/signalbox/bridge-token`). Browsers can't use the bridge. A card
  from an agent is labelled "From an agent" only if it says `source: "agent"`.
  Because the label can't be trusted, the confirmation step matters.
- **Notifications carry little.** Approval notifications say which agent needs
  you and the request's short title, never the command or its output.
  For-you notifications carry a card's title. They go through your browser
  maker's push service encrypted, and can show on a locked screen if your phone
  allows it.
- **Nothing leaves your PC otherwise.** Cards, settings and subscriptions stay
  in Signalbox's state folder. The VAPID contact is your `publicOrigin`, not
  your email.

## Limits

- Notifications need a browser that supports Web Push. On iPhone and iPad that
  means the Home Screen app.
- When your PC is asleep or Signalbox is down, no checks run and no
  notifications go out. The next check picks up whatever changed.
- The level setting knows the pulse jobs only by name. Renaming them in Hermes
  greys it out.
