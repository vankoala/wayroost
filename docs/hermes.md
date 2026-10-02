# How Signalbox talks to Hermes

Signalbox connects to the Hermes dashboard on your machine
(`http://127.0.0.1:9119` by default; `hermes.url` must be an http(s) loopback
address). It signs in the way the dashboard's own clients do, reads chat lists
and history over HTTP, and does everything live (streaming, approvals, sending,
file uploads, "/" commands, stopping) over the dashboard's JSON-RPC WebSocket,
`/api/ws`. The WebSocket client is Signalbox's own, modelled on the reference
client in Hermes Agent (`apps/shared/src/json-rpc-channel.ts`). Code:
`server/src/hermes/`.

Tested Hermes versions are listed in [setup.md](setup.md#what-you-need).

## Signing in

Signalbox needs your Hermes dashboard username and password (`auth.ts`):

- You enter them under **Settings → Hermes sign-in**. Signalbox tries them with
  Hermes before saving, so a typo never replaces credentials that work. Then it
  keeps them in `hermes-credentials.json` in its state directory (mode 600). It
  accepts five attempts a minute.
- Signing in is `POST /auth/password-login` with `provider: "basic"`. Hermes
  answers with two session cookies: `hermes_session_at` (access) and
  `hermes_session_rt` (refresh). Signalbox sends the access value as a `Bearer`
  token. Both tokens stay in the server's memory. They're never written to disk
  or sent to your browser.
- The access token's expiry comes from `GET /api/auth/me` after signing in, or
  from the refresh response. If Hermes doesn't say, Signalbox assumes one hour.
  Once less than two minutes are left, Signalbox gets a new pair from
  `POST /auth/native/refresh` before its next request.
- A request that gets a 401 is retried once with a renewed token.

When your password is sent:

| Situation | What Signalbox does |
| --- | --- |
| Signalbox starts, or you sign in under Settings | signs in with the password, because tokens only live in memory |
| The refresh gets a 401, for example because Hermes restarted with a new signing secret | signs in with the password again |
| Hermes can't be reached, or the refresh fails in any other way | shows the error and retries the refresh later, without the password |
| Hermes rejects the saved password (401 or 422) | stops retrying, so it doesn't trip Hermes' rate limiter, and asks you to sign in again |
| Hermes answers 429 | shows "Too many Hermes sign-in attempts. Try again in a minute." and retries later |

**Sign out** under Settings deletes the saved file, forgets the tokens, closes
the connection and clears Hermes' waiting cards. Hermes chats leave the inbox
until you sign in again.

## Connecting

Every connection (`gateway.ts`):

1. gets a fresh, single-use ticket from `POST /api/auth/ws-ticket` and opens
   `/api/ws?ticket=…`;
2. waits for Hermes' `gateway.ready` event;
3. calls `client.capabilities` with `server_requests: true`. This tells Hermes
   that Signalbox answers its requests, such as approvals. Without it, Hermes
   withdraws them. If the call fails, Signalbox drops the socket and starts
   over;
4. only then sends other calls.

Messages on the socket are JSON-RPC 2.0:

| Frame | Meaning |
| --- | --- |
| a response | the answer to one of Signalbox's calls, matched by id. Calls time out after 30 s by default. |
| an `event` notification | `{ type, session_id, payload }`: streamed text, tool calls, status, titles |
| a request from Hermes | something Hermes needs a client to answer: `approval`, `clarify`, password prompts |

To stay connected:

- Signalbox calls `gateway.ping` every 15 s. If nothing arrives from Hermes for
  45 s, it drops the socket.
- It reconnects after a random delay of up to 300 ms × 2ⁿ, at least 300 ms and
  at most 15 s. The delay starts small again once a connection has stayed up
  for 5 s.

## The inbox

Signalbox lists chats (Hermes calls them sessions) over HTTP:

```
GET /api/sessions?limit=60&order=recent&archived=exclude&min_messages=1&exclude_sources=cron,acp
```

- the 60 most recent chats;
- no archived chats, and no empty ones;
- no `cron` chats (scheduled jobs);
- no `acp` chats. ACP is how Paseo runs Hermes agents, so those appear once, as
  Paseo agents with the **Hermes · in Paseo** badge. See
  [paseo.md](paseo.md#the-inbox).

A chat Signalbox is attached to (see [Opening a chat](#opening-a-chat)) stays
listed even when this query leaves it out, for example one you just started.
The list is cached for 3 s. It's refreshed when Hermes announces
`sessions.changed`, and shortly after each reply finishes.

Each chat becomes a conversation:

| Signalbox | From Hermes |
| --- | --- |
| title | the chat's title, else its preview, else "New chat" |
| subtitle | where the chat started (such as Desktop, Terminal, Telegram or Scheduled) and the model |
| preview | the chat's preview text |
| agent | the model, without its provider prefix (`provider/model` → `model`) |
| project | the chat's working folder (`cwd`). Your home folder, `/root` and `/` don't count as projects. |
| status | see below |
| aliases | a compressed chat's earlier ids (`_lineage_ids`), so what was started under an old id still finds it |
| parent | for a chat an agent started through the [bridge](bridge.md), the chat that started it |

Statuses come from `session.active_list`, which Signalbox polls every 5 s while
a browser is connected, and from live events in between:

| Hermes | Signalbox |
| --- | --- |
| `waiting` | needs you |
| `starting`, `working`, `streaming`, `resuming` | working |
| anything else | idle |

A waiting approval or question always makes the chat "needs you".

**Chats started elsewhere.** When `session.active_list` shows a chat as
`waiting` and Signalbox isn't attached to it, for example a chat in the Hermes
desktop app or terminal, Signalbox attaches to it. The request then reaches
your phone too. The same list tells Signalbox which cards are leftovers; see
[When cards go away](#when-cards-go-away). It also ends the "working" state of
a chat Hermes shows idle or no longer lists, such as one whose turn was killed
with Hermes: no `message.complete` would ever come.

### Sub-agents

A chat's `delegate_task` runs (sub-agents, including work handed to another
model) are listed under the chat that ran them, and open read-only. Hermes
lists them only with `sessions.show_subagents` on in its config, and only
versions whose `GET /api/config/defaults` include that setting know it; Signalbox
checks once per connection. A second list asks for them without touching the
chats' 60 places:

```
GET /api/sessions?limit=100&order=recent&archived=exclude&min_messages=1&exclude_sources=cron,acp,subagent
```

Excluding `subagent` is how a list asks for the runs. It's cached for 10 s,
and fetched again when Hermes announces `sessions.changed` or a chat Signalbox
is attached to sends `subagent.start` or `subagent.complete`.

A run is a row with a `parent_session_id` that isn't a `/branch` or `/new`
copy (`_branched_from`, `_reset_from`) and isn't one of the listed chats. Rows
with the same id count once; Hermes can list a compressed run twice. Its parent
is the first of:

1. a listed chat;
2. a listed chat under an earlier id (its `_lineage_ids`), or a chat Signalbox
   saw move to a new id;
3. another run, or an earlier id of one. A run that ended in compression is
   the child's own earlier segment: it's hidden, and its parent used instead;
4. an id that's a uuid: a Hermes session run by Paseo (ACP), which its Paseo
   agent lists as an alias;
5. an earlier id of such a session, looked up in
   `GET /api/sessions?source=acp&limit=100&order=recent&archived=include`,
   fetched only when a run needs it and cached for 60 s;
6. nothing: the run is dropped, unless it's still active, when it's listed on
   its own.

At most 20 runs are kept per parent, the newest. Each shows as:

| Signalbox | From Hermes |
| --- | --- |
| title | the title without its `Subagent: ` prefix, else the preview, else "Sub-agent" |
| subtitle | "Sub-agent · " and the model |
| status | working while it hasn't ended and wrote in the last 5 minutes (`is_active`), else idle |
| approvals | none: a run's requests go to its parent chat |

Opening one loads its history from the REST API and never attaches to it.
Sending, a "/" command, Stop, changing its model or reasoning, its "/" menu
and answering are refused. A run Signalbox hasn't listed is recognized by its
detail row, whose `model_config` carries `_delegate_from`.

## Opening a chat

Hermes has two ids for a chat:

- the **stored id**, the id Hermes saves the chat under, such as
  `20260101_120000_abc123`. Signalbox uses it for everything you see: links,
  the inbox, approvals.
- the **runtime id** of the live session on the gateway. Events, requests and
  calls such as `prompt.submit` use it. It belongs to one WebSocket connection.

Opening a chat does two things at once:

1. It loads the last 200 messages with
   `GET /api/sessions/<stored id>/messages?limit=200&order=latest`. This only
   reads Hermes' database.
2. If the chat is **live** in Hermes (`session.active_list` lists it), it
   **attaches** to it with `session.resume`, passing the stored id and
   `omit_messages: true`, because the history came from step 1. Hermes returns
   the runtime id and a snapshot: whether a turn is running, the reply so far,
   and any open requests. The reply so far appears as streaming, and open
   requests become cards, as long as a turn is running or Hermes says the chat
   is `waiting` (see [When cards go away](#when-cards-go-away)).

**Why only live chats.** When Hermes is killed mid-turn, the turn leaves a
crash marker. The first `session.resume` of that chat while it isn't live (a
"cold" resume), within 15 minutes, makes Hermes re-run the lost turn by itself.
So Signalbox never cold-resumes a chat on its own: not to show it, not after a
reconnect, not for its model and reasoning chips or its "/" menu (those use
Hermes' general options instead), and not for Stop (nothing runs in a chat that
isn't live). Resuming a live chat changes nothing.

Signalbox maps the two ids both ways. Apart from title changes, it ignores
events and requests for chats it isn't attached to. It attaches:

- to a live chat you open, and to chats you have open once they become live,
  for example when the desktop app opens one (checked on every reconnect and
  every 5 s while a browser is connected);
- to live chats that are waiting for you or still have cards;
- when you send a message, run a "/" command or change the model or
  reasoning. A chat that isn't live is cold-resumed then, and if Hermes lost a
  turn there, the reply says `auto_continue`: it will re-run that turn once
  its agent is built. A message you send claims the chat first (`prompt.submit`
  marks it running at once), so Hermes drops the re-run. For anything else,
  and for a message with files (the uploads come first, and the re-run could
  take them), Signalbox cancels the re-run with `session.interrupt` right
  after the resume, which also clears Hermes' crash marker, and says so in the
  chat;
- again after Hermes reclaims one (`session.reclaimed`), if it's live.

When Hermes does re-run a lost turn, for example because another app resumed
the chat, the chat says "Hermes is resuming the interrupted turn." Signalbox
knows it from `status.update` (`kind: "process"`, which background processes
use too, so its text decides), or, if it attaches mid-way, from the
snapshot's `inflight.display_kind: "auto_continue"`. In the history, Hermes'
note that starts the re-run (`display_kind: "auto_continue"`) shows as a
notice, not as your message, and the bridge's `read_chat` shows it the same
way.

**When a chat moves.** After compressing a chat's context, Hermes continues it
under a new stored id and says so in `session.info` (`stored_session_id`).
Signalbox follows the chat: its live session, status, command output and
waiting cards move to the new id, and every browser gets
`conversation_moved`. If you have the chat open, the view switches to the new
id without adding a step to your browser history, and your unsent text and
photo thumbnails come along.

## Timelines

History, from the messages API:

| Hermes message | Signalbox |
| --- | --- |
| `user` | your message. `@image:` and `@file:` lines at its start or end become file chips (see [Files and photos](#files-and-photos)). A skill invocation shows as what you typed, such as `/plan fix login`, instead of the whole expanded skill. |
| `assistant` with `reasoning` | thinking |
| `assistant` content | reply (markdown) |
| `assistant` `tool_calls` | one tool card per call, with a one-line summary of the arguments and the input |
| `tool` | the output and status, added to its tool card (matched by `tool_call_id`), or a card of its own |
| `display_kind: "hidden"` | not shown |
| `user` with `display_kind: "auto_continue"` | the notice "Hermes resumed the interrupted turn." (Hermes' note, not your message) |

Live events, while attached:

| Hermes event | Signalbox |
| --- | --- |
| `message.start` | a new turn; the chat shows as working |
| `reasoning.delta` | thinking, streamed |
| `reasoning.available` | thinking, unless a thinking block is already open |
| `message.delta` | reply, streamed. The thinking block closes when the reply starts. |
| `message.interim` | closes the current reply, using its text if it wasn't streamed |
| `tool.start` | closes the current reply, then a running tool card with a one-line summary (Hermes' `context`, or the arguments) and the input |
| `tool.complete` | the same card, with the output and status |
| `message.complete` | the final reply text. `status: "error"` adds an error notice, and `"interrupted"` adds "Stopped". |
| `session.info` | working or idle, the title, the model, reasoning and context use, and a new stored id after compression |
| `session.usage` | how full the context window is |
| `session.title` | the title |
| `request.cancel` | removes that request's cards |
| `status.update` | "Hermes is resuming the interrupted turn", when it's the re-run of a lost turn; others are ignored |
| `subagent.start`, `subagent.complete` | lists the chat's runs again (see [Sub-agents](#sub-agents)) |
| `error` | an error notice |

Streamed text goes to your browser as it arrives. A reply closes the thinking
before it, and a tool call closes both, so a turn reads in order: thinking,
reply, tool, reply.

A tool call is marked as failed when its result has an `error`,
`success: false` or a non-zero `exit_code`. A non-zero exit code is shown after
the output. Tool input and output are cut at 16,000 characters. Tools that hand
the model a picture, such as vision tools, show their text summary instead,
and any other inline base64 image in a tool's input or output becomes
`[image]`.

When a reply or a tool call points at an image on your machine, the timeline
can show it; see [Images Hermes agents show](#images-hermes-agents-show).

The output of "/" commands isn't part of Hermes' history. Signalbox adds it
itself; see ["/" commands](#-commands).

## Approvals and questions

Hermes asks with requests on the socket: `approval` for permissions and
`clarify` for questions.

### Permissions

Each `approval` becomes a card:

- **Title:** Hermes' `description`, else "Use <tool>", else "Run a command".
- **Detail:** the `command`, in full up to 60,000 characters. A longer command
  is marked as truncated, and you can only deny it from the phone.
- **Buttons:** only the choices Hermes offers.

| Hermes choice | Button |
| --- | --- |
| `once` | Allow once |
| `session` | Allow for this chat |
| `always` | Always allow |
| `deny` | Deny |

If the request carries a `choices` list, Signalbox keeps the choices above and
drops anything else. It uses the list if `deny` and at least one other choice
remain. Otherwise it offers Allow once and Deny, plus Allow for this chat unless
`allow_session` is `false` or `smart_denied` is set, plus Always allow unless
`allow_permanent` is `false`.

Hermes gets your pick as `{ "choice": "once" }` (or whichever you tapped).

### Questions

- **One question** (`question`, with optional `choices` and `multi_select`):
  one card with the question, a button per choice, a box for a typed answer,
  and **Skip**.
- **A batch** (`questions`, each with a `qid`): one card per question, labelled
  like "Question 2 of 3". Questions Hermes already has an answer for
  (`answers`) are left out. Signalbox collects your answers and sends them
  together when you answer the last one, as
  `{ "answers": { "<qid>": "…" } }`.

| You | Hermes gets |
| --- | --- |
| tap a choice | the choice's text |
| type an answer | your text, trimmed |
| pick several (multi-select), with or without typed text | a JSON array in a string, such as `["red","blue"]` |
| tap Skip | an empty string, which Hermes treats as skipped |

A single question's answer goes back as `{ "answer": "…" }`.

### Answering

- The server checks every answer before sending it: the option must have been
  offered, for that request, in that chat. Anything else is refused.
- The answer goes back as the JSON-RPC response, and **only on the connection
  the request arrived on**. If that connection has closed, or the request came
  from a resume snapshot, Signalbox sends it with `request.answer` instead. If
  Hermes says the request `expired`, the card goes away and you see "That
  request already expired."
- The card disappears on every device once the answer is sent, or when Hermes
  cancels the request (`request.cancel`).
- Nothing is answered automatically.

### When cards go away

Hermes keeps its open requests in memory only. When it's killed, or a
`request.cancel` is lost while the socket is down, nothing tells Signalbox, so
Signalbox checks its cards against Hermes:

- **Snapshots.** A snapshot's open requests become cards only while a turn is
  running or Hermes says the chat is `waiting`: a background task can ask after
  a turn ends. Cards Signalbox had before the snapshot, and that the snapshot
  doesn't list, go away.
- **`session.active_list`.** Cards of a chat that Hermes shows as `idle`, or
  doesn't list at all, go away: nothing is open there. Signalbox asks after
  every reconnect, every 5 s while a browser is connected, and shortly after a
  turn ends (`message.complete`), a chat stops running (`session.info` with
  `running: false`) or you tap Stop.
- **After a reconnect**, a live chat that still has cards is attached again,
  so its snapshot and its events keep them in step. A chat that isn't live is
  never resumed just to check: after a crash, the first resume can make Hermes
  re-run the turn it lost.

Hermes has no call that withdraws a single request: `request.cancel` is only
an event it sends. Answering a card whose request already ended changes
nothing in Hermes and removes the card; through `request.answer` you also see
"That request already expired."

## Password and secret prompts

Some requests ask for a password or secret. Each takes one string back,
`{ "value": "…" }`, and an empty string declines:

| Hermes request | Asks for | Hermes waits |
| --- | --- | --- |
| `sudo` | your sudo password, to run `command`. Hermes keeps it for the rest of the chat. | 2 minutes |
| `secret` | a value for `env_var` that a skill needs, explained by `prompt`. Hermes saves it to its `.env` file. | 5 minutes |
| `vault.unlock_prompt` | the master password of a password manager (`display_name`, such as 1Password), to unlock it for this chat | 2 minutes |
| `vault.code` | a one-time code for `site`, from a text, an email or an authenticator app | 3 minutes |
| `vault.save_login` | a username and a password for the sign-in page at `origin` (`site` is its host), together as JSON, to save and fill in. Hermes keeps the password encrypted in its vault; the agent sees the username. | 3 minutes |

When time runs out, Hermes carries on without it (sudo fails for lack of a
password, the vault stays locked, and so on) and cancels the request.

**By default**, Signalbox answers none of them. If you have the chat open, it
shows a notice instead: "Hermes is asking for a password or secret. For
safety, answer it in the Hermes desktop app or terminal."

**With `hermes.secretPrompts` on** (see
[configuration.md](configuration.md#fields)), all five become secret cards:

| Hermes request | Card | Detail | You type |
| --- | --- | --- | --- |
| `sudo` | "Hermes asks for your sudo password" | the command | a password, then a second tap to confirm |
| `secret` | named after `env_var`: "Hermes asks for OPENAI_API_KEY" | the prompt | a password |
| `vault.unlock_prompt` | named after `display_name`: "Vault master password for 1Password" | none | a password |
| `vault.code` | named after `site`: "2FA code for github.com" | the hint, if there is one | a code, on a number keypad |
| `vault.save_login` | named after `site`: "Save a login for github.com" | the exact `origin`, such as `https://github.com` | a username and a password |

- The detail is shown in full up to 60,000 characters, like a permission's
  command. A longer one can only be declined from the phone. A `sudo` request
  that comes without a command says so in its title.
- The card's one button declines (Decline, Skip or Keep locked) and sends
  `{ "value": "" }`.
- What you type goes back unchanged as `{ "value": "…" }`, the same way as
  other answers (see [Answering](#answering)). It can't be blank, and it can be
  up to 4,096 characters.
- A login goes back as one JSON string in `value`:
  `{"identifier":"…","password":"…"}`, both exactly as typed. The phone sends
  them as `login: { identifier, password }` with nothing else in the answer,
  neither can be blank, and each can be up to 4,096 characters. A login is
  refused on any other card, and a password on a login card.
- The server sends it only if the card is still waiting, in that chat. It keeps
  no copy: nothing you typed is logged, saved, added to the timeline or the
  card, or sent to your other devices, and no error repeats it, not even an
  error from Hermes.
- The card goes away when you answer, and when Hermes cancels the request or
  it expires, as for other requests.

What you type passes through Cloudflare; see
[SECURITY.md](../SECURITY.md#known-limits).

Requests for the desktop app's own screens, such as `preview.*` and
`window.read`, are left for the desktop app.

## Starting a chat

**New → Hermes** takes a message, optional files, and an optional folder: an
absolute path where Hermes works for this chat. The **+** on a project in the
Projects view fills in that project's folder, and `/new` in an open chat fills
in that chat's folder and the text you typed after it.

1. `session.create` starts the chat, with the folder as `cwd` if you gave one.
   Without a folder, Hermes uses its usual one. Hermes returns the runtime id
   and the stored id.
2. If the message is a "/" command and you attached no files, Signalbox runs it
   in the new chat instead of sending a prompt, and the chat opens on its
   output. Otherwise it uploads any files and sends your message with
   `prompt.submit`.
3. The chat appears in the inbox right away, with your message (or the file
   names) as the preview and the folder as its project.

The "/" menu works in this sheet too, without the commands that only make sense
in an open chat (`/new`, `/reset`, `/clear` and `/stop`).

## Sending and stopping

- Messages use `prompt.submit` with the chat's runtime id. Your message takes
  the id Hermes stored it under (`user_row_id`), so it matches the history.
- Text that starts with a "/" command, sent without files, runs as a command
  instead; see ["/" commands](#-commands). Files are uploaded first; see
  [Files and photos](#files-and-photos).
- If Hermes answers 4001 (chat closed) or 4007 (chat not found), Signalbox
  attaches again and retries once.
- Signalbox doesn't stop a running turn before sending a follow-up. Hermes
  decides what to do with it. If Hermes answers that the chat is busy, you see
  "Hermes is busy with this chat. Try again shortly." Files are refused while a
  turn is running.
- **Stop** calls `session.interrupt`. When Hermes ends the turn as
  `interrupted`, the timeline shows "Stopped". Typing `/stop` also stops
  Hermes' background processes (`process.stop`).
- While Hermes is reconnecting, sending, stopping, running commands and
  starting chats fail right away with "Hermes is reconnecting. Try again in a
  moment."

Errors from Hermes are shown in plain words:

| Hermes error | You see |
| --- | --- |
| 4001 | This Hermes chat was closed. Reopen it and try again. |
| 4007 | Hermes couldn't find this chat. |
| 4009 | Hermes is busy with this chat. Try again shortly. |
| 4090 | Hermes has too many active chats right now. |
| 4130 | This chat is too large to open here. |
| 5035 | Hermes is restarting. Try again in a moment. |
| anything else | "Hermes: " followed by Hermes' own message |

## Model and reasoning

Chips above the message box show the chat's model and reasoning effort, and
how full its context window is. Changes apply to this chat only.

- **Model.** The options come from `model.options` with `explicit_only: true`
  (kept for a minute): the models of every provider Hermes doesn't report as
  signed out, minus the ones it marks unavailable, grouped by provider and
  priced where Hermes knows the price. Switching sends `config.set` with
  `model "<model> --provider <slug> --session"`. The `--session` flag keeps the
  switch to this chat, so Hermes' saved defaults never change.
- **Expensive models.** When Hermes asks to confirm a model first, you see its
  message, and only a yes resends the switch with `confirm_expensive_model`.
- **Mid-turn.** When Hermes defers a switch because a turn is running, you see
  "Takes effect on the next turn."
- **Reasoning.** The levels are the ones Hermes Agent's own apps offer
  (`apps/shared/src/reasoning-effort.ts`): Off, Minimal, Low, Medium, High,
  Extra high, Max and Ultra. Off is hidden when the model can't turn reasoning
  off, and the chip is hidden when the model has no reasoning setting.
  Switching sends `config.set` with `reasoning`.
- **Context.** How full the context window is comes from `session.info`,
  updated by `session.usage` and `message.complete`.

The server accepts only options it offered. Warnings from Hermes appear as a
notice, and Hermes' own errors as "Hermes: …".

## Files and photos

The paperclip adds up to four photos, PDFs, text files or documents to a
message, 10 MB each. The server checks every file before Hermes sees it: the
type comes from the bytes, and anything that isn't a PNG, JPEG, GIF or WebP
image, a PDF, UTF-8 text or one of the documents listed in
[how-it-works.md](how-it-works.md#attachments) is refused (see [SECURITY.md](../SECURITY.md)). Then Signalbox
uploads the files one at a time, before the prompt, the way the desktop app
does:

| File | How it reaches Hermes |
| --- | --- |
| image | `image.attach_bytes`, as base64 with a file name whose extension matches the real type, because Hermes picks the image type from the extension. Hermes keeps it for the next prompt. |
| PDF, text or document | `file.attach`, as an inline `data:` URL. Hermes saves it and returns an `@file:` reference, which Signalbox puts before your text. Hermes inlines text; for a binary file such as a spreadsheet it gives the agent the saved path ("binary file, not inlined as text"). |

- File contents always travel inline. Signalbox never gives Hermes a path to
  read on your machine.
- A message with only images, no text and no other files, asks "What do you see
  in this image?", as the desktop app does.
- Files are refused while a turn is running ("Hermes is still working on this
  chat. Wait for it to finish, or stop it, before sending files."), because
  Hermes would hand them to whatever prompt comes next.
- If an upload or the prompt fails, the images already sent are taken back
  (`image.detach`), so they can't ride along with a later prompt. An upload
  Hermes refuses shows as "Hermes couldn't take the attachment: …".
- "/" text sent with files is an ordinary message, not a command.

Your message shows its files as chips with their names and types. Only the names
and types come back from the server, never the contents; photos you sent from
this browser also show a thumbnail. In history, the `@image:` and `@file:`
lines at the start or end of a stored message become chips too, and images
sent inline show as "Image 1", "Image 2"… A reference typed in the middle of a
message stays part of the text.

## Images Hermes agents show

When a reply or a tool call points at an image on your machine, Signalbox can
show it (see [how-it-works.md](how-it-works.md#images-from-your-machine)).
Hermes agents often deliver files with a `MEDIA:` tag; Signalbox replaces the
tag with the file name and shows the image under the reply, as the Hermes apps
do.

Signalbox can't read your files itself. It asks the Hermes dashboard, with
`GET /api/fs/download?path=…&session_id=<stored id>`, the same call the
desktop app uses. The dashboard runs as you and applies its own rules for
sensitive files; when it refuses, you see "Hermes won't share that file."
Anything over 20 MB is refused.

## "/" commands

Text that starts with `/` and a command name runs as a command, as in every
Hermes client, unless you attached files. A path such as
`/home/you/notes.txt` isn't a command.

### The menu

Typing `/` in the message box opens a menu built from Hermes' `commands.catalog`,
the same list the desktop app's composer uses (`commands.ts`):

- commands grouped in the catalog's sections, then skills, most used first;
- commands the desktop app hides are hidden here too, and so are
  terminal-only ones such as `/skin`, `/voice`, `/quit` and `/resume`;
- after a command's name, the menu offers its known argument values (the
  catalog's `sub`), and aliases find their command.

Signalbox caches the catalog for five minutes, and drops it after every
reconnect and whenever a `skill_manage` tool call finishes, because a skill was
created or changed. Your browser also keeps its copy for up to five minutes.

### Running a command

Signalbox runs a command the way the desktop app does: `slash.exec` first, and
`command.dispatch` if Hermes answers that with an error (anything but a lost
connection or a timeout). The result is one of:

| Result | What you see |
| --- | --- |
| output | a command block in the timeline, as plain text |
| a prompt (skills, and some commands) | Signalbox sends the expanded prompt with `prompt.submit`. The chat shows what you typed (Hermes' `display`, such as `/plan fix login`), not the expanded skill. |
| text to edit | it goes back into your message box. For example, `/undo` hands back your last message. |
| an alias | Signalbox follows it (up to four hops) and checks the target against the blocked list again |

A few commands are handled by Signalbox itself:

| Command | What happens |
| --- | --- |
| `/new` (also `/reset`, `/clear`) | the app opens **New** on Hermes, with this chat's folder and any text you typed after the command. If one reaches the server anyway, for example as the first message of a new chat, the answer is "Start a new chat with the New button." |
| `/stop` | stops the reply (`session.interrupt`) and Hermes' background processes (`process.stop`) |
| `/title`, `/title <name>` | shows or sets the chat's title (`session.title`) |
| `/resume`, `/sessions`, `/switch` | "Open your other chats from the inbox." |

Output:

- Terminal colour codes and control characters are stripped. Output is never
  rendered as markdown. Long output shows its first 12 lines, with **Show all**
  for the rest.
- Hermes doesn't store command output, so Signalbox keeps the last 20 per chat
  in memory, until it restarts, and merges them into the timeline by time.
  Each is cut at 16,000 characters.
- A command still running after 15 s shows as running; its output arrives live
  when it finishes. Signalbox waits up to 11 minutes for long commands such as
  `/compress` and `/update`, and up to 3 minutes for the others.
- `/undo`, `/retry` and `/compress` rewrite the stored history, so the open
  timeline is reloaded after them.
- Errors from Hermes are shown as Hermes wrote them.

### Blocked commands

These never run from Signalbox:

| Command | Why |
| --- | --- |
| `/yolo` | it turns off approval prompts |
| `/approvals <mode>` | it changes when Hermes asks before acting |
| `/approve` | approvals are answered on their card, which shows exactly what will run |
| `/memory approval…` | it changes the memory approval gate |
| `/skills approval`, `/skills approve` | it changes the skill approval gate |
| `/debug` | it uploads your logs to a shareable link |

You get an error line instead, such as "For safety, /yolo can't be run from
Signalbox: it turns off approval prompts. Use the Hermes desktop app or
terminal." `/yolo`, `/approve`, `/debug`, `/approvals`, `/memory` and `/skills`
are also left out of the menu; typed by hand, only the forms above are
refused. The same rule is behind Paseo's blocked modes; see
[SECURITY.md](../SECURITY.md).

## Connectors

Settings → Connectors lists the services Hermes can use on your behalf. The page
drives Hermes' own dashboard; Signalbox never holds a service's tokens.

- **Sign-in apps** (Notion, Todoist, Dropbox and the rest) are entries in
  Hermes' approved MCP catalog (`optional-mcps/`).
  - **Connect** installs the entry (`POST /api/mcp/catalog/install`) and sets
    its `oauth.redirect_uri` to `https://<your Signalbox>/connect/callback/<name>`.
    Then it starts Hermes' OAuth flow (`POST /api/mcp/servers/<name>/auth`).
  - You sign in on the service's page. It sends your browser back to Signalbox,
    through Cloudflare Access. Signalbox hands the code to the dashboard's own
    callback on loopback, which checks it belongs to the open sign-in.
  - A new connector starts on **Ask before changes** (`trust: untrusted`):
    read-only tools run by themselves, and anything else asks you first.
    **Automatic** is `trust: full`.
  - **Disconnect** removes the server from Hermes. To revoke fully, also remove
    the app in the service's own settings.
  - After a change, Signalbox asks Hermes to reload its MCP tools
    (`reload.mcp`). WhatsApp and scheduled jobs run in Hermes' gateway and
    pick a new connector up when the gateway restarts.
- **Google** goes through the Hermes Google Workspace skill's own setup script,
  run by the Signalbox helper. Google only allows a `localhost` redirect for
  this kind of sign-in. So after you approve, the page fails to load: copy its
  address and paste it into Signalbox.
- **Mail triggers** are Hermes scheduled jobs named "Signalbox: …".
  - Each job runs `signalbox_mail_trigger.py` from Hermes' `scripts` folder in
    its own folder under `~/.hermes/signalbox-triggers/`.
  - The script searches Gmail. With no new match it prints
    `{"wakeAgent": false}`, so no model runs.
  - A trigger's first check only records what's already there.
  - Mail that looks like a sign-in code, password reset or magic link is never
    passed to the agent.
  - A trigger has a **What it can use** choice like any scheduled job (below),
    and starts at **Nothing**: Hermes then works only from the details the
    script passes in. Mail is other people's words, so only **Everything** lets
    it run the google-workspace skill to open the message itself.
- **The Signalbox helper** (`deploy/setup-helper.sh <user>`) is a small service.
  It runs as the Hermes user, listens on 127.0.0.1:8793, and shares a secret
  with Signalbox through systemd `LoadCredential`. Without it, Google and
  triggers say so, and the sign-in apps still work.

## WhatsApp

Settings → WhatsApp controls the `whatsapp-routing` Hermes plugin
(`~/.hermes/plugins/whatsapp-routing`), which decides which Hermes chat each of
your WhatsApp messages goes to. The section shows only when the plugin is
installed and the Signalbox helper is running.

| Setting | What it does |
| --- | --- |
| Replies go back to the chat that messaged you | When another Hermes chat sends you a WhatsApp message (`send_message`), quote-replying to it sends your reply to that chat, and its answer comes back on WhatsApp. Off: everything goes to your own WhatsApp chat, and a borrowed chat is left on your next message. |
| Back to your WhatsApp chat after | 15 min to 4 h without activity in a chat you quote-replied to, then WhatsApp returns to your own chat. |
| Start a fresh WhatsApp chat | Never, or 2 to 24 h without activity, then your next message starts a new chat (Hermes' `/new`). The old one stays under `/resume`. |

- The helper writes the settings to `~/.hermes/whatsapp-routing.json` as the
  Hermes user. The plugin reads the file on every message, so a change applies
  at once with no restart. A missing or damaged file means the defaults: on,
  30 min, 4 h.
- If Hermes isn't loading the plugin (it's missing from `plugins.enabled` in
  `~/.hermes/config.yaml`), the section says so; the choices are kept but do
  nothing until it is.
- The plugin never acts on "/" commands, groups, senders Hermes doesn't
  authorize, or while a reply is running. A quote-reply only switches chats when
  the quoted message really was sent to that WhatsApp chat by that Hermes chat.

## Scheduled jobs

Settings → Scheduled jobs lists every Hermes cron job, and Paseo's schedules beside them
(see [paseo.md](paseo.md#scheduled-jobs)), soonest first, each with a Hermes or Paseo badge:
- its schedule, when it runs next and last ran, and a status dot (active, paused, running
  now, last run failed, finished);
- a failing job shows its last error and how many runs in a row have failed;
- a warning appears if Hermes' scheduler hasn't ticked for three minutes (jobs only fire
  while the Hermes gateway runs).

Tap a job for:
- where its results go, its run count, its skills and its instructions;
- **Run now**, **Edit** and **Delete**;
- its recent runs. An agent run is a Hermes session, so tapping it opens the full run like
  any chat. A script-only run shows a preview.

The switch pauses or resumes the job.

**Names and details.** Jobs show a readable title ("news-digest" → "News
digest"; the pulse jobs use For you's labels, "Morning brief" and "Daytime check") with the
original name in the details. Each job also gets a one-sentence **idea**: what it does and
why. The local model writes it from the instructions (127.0.0.1, nothing leaves the PC), once
per set of instructions, cached in Signalbox's state folder as `schedule-ideas.json`. The
details show the idea, the status, when it runs (schedule and next run), when it was created,
where results go, the run count, its skills, and the full instructions under a fold.

**New scheduled job** opens the builder:
1. Describe what Hermes should do and when, in plain words.
2. **Draft it**: the local model proposes a name, instructions (quiet unless something
   matters), a schedule, where results go, and up to four Hermes skills that would help, each
   with a reason. It only suggests skills Hermes actually has (from `/api/skills`, enabled
   ones only).
3. Review and change anything, untick skills you don't want, then **Schedule it**. Nothing is
   created until then.

**Fill it in yourself** skips the AI. Destinations include Hermes' own delivery targets plus
the explicit chats existing jobs already send to ("WhatsApp · …4567").

**What it can use.** A scheduled job runs while you're away, and Hermes approves its tool calls
by itself. So every Hermes job made or edited here carries an explicit tool list (the job's
`enabled_toolsets`), and new jobs start at the least:

| Choice | `enabled_toolsets` | What the job can do |
| --- | --- | --- |
| Nothing — it only writes (default) | `todo, no_mcp` | Write from its instructions and its skills' text. |
| Web search | `web, todo, no_mcp` | Search the web and read pages. |
| Web + flights & maps | `web, todo, kiwi, mapbox, no_mcp` | The web, Kiwi flight search, Mapbox maps, directions and traffic. No other app. |
| Everything (full access) | Hermes' standard cron set | Commands, files, the browser, the Windows desktop, delegation, and every connected app. |

- **How Hermes reads the list.** Without `no_mcp`, Hermes adds every enabled MCP app to a job's
  list, unless the list names one; then the named ones are the only apps. "Everything" is
  Hermes' own cron default (`hermes-cron` minus its default-off toolsets) written out, so it
  doesn't widen to Home Assistant, Spotify or kanban. Like any per-job list, it overrides
  `platform_toolsets.cron`.
- **The job builder suggests a choice** with its reason, the least the job needs, and
  "Nothing" when unsure.
- **Edit changes only what you change.** A job whose list isn't one of the four shows "Keep as
  it is: Custom: …".
- **Unpinned jobs.** A job with no list (made in a Hermes chat, say) shows "Hermes decides":
  `platform_toolsets.cron` in Hermes' `config.yaml` sets it, and Signalbox can't see that.
- **Warnings.** Jobs with full access, or Hermes' setting, carry a warning, and full-access
  jobs show a **Full access** badge.
- **Never touched.** Script-only jobs (no agent) and Paseo jobs have no choice. For you's
  level only ever changes the pulse jobs' schedules, never their tools.

**On the home page** the tabs read **Recent | Projects | Scheduled**, with search below them.
The Scheduled tab only appears when there are jobs. It shows a red count when a job failed,
or a dot while one runs, so you see trouble from any tab. It has five sections:
- **Running now**
- **Failed recently**
- **Next up**: the next three due.
- **Recent results**: the last five finished runs from the past three days. Tap one to open
  it as a chat.
- **All jobs**

Each section folds, and what's open is remembered per device. Search filters jobs by name,
idea or schedule, and the conversation filters are hidden on this tab. A job opens its
details and actions in the Scheduled jobs sheet, and the phone's **New** button starts the job
builder. Background plumbing (script-only jobs such as `pulse-relay`, or anything running more
often than every 15 minutes) stays out of Running and Next up, but still shows if it fails. A
pulse job paused by For you's level is not treated as a problem.

- Everything goes through the Hermes dashboard's own `/api/cron` routes. Hermes keeps the jobs
  and runs them.
- Run now starts the job in the background (Hermes' trigger route waits for the run to end);
  the job shows "Running now" until it finishes.
- The page updates live: Hermes sends `cron.changed` when a job is claimed, finishes or
  changes, and Signalbox passes that to open pages. A 30-second poll backs it up.
- Mail triggers (Connectors) appear here too and can be paused or run. They're edited and
  deleted under Connectors, because their search lives in the helper.
- Logs record the action, never a job's instructions.

## Phone

Settings → Phone shows whether Hermes Phone (a Twilio line answered on this
PC) is running, and holds the PIN that lets calls from the owner's cell reach the real Hermes.

- The PIN lives only in the encrypted vault (`phone-pin`). The helper asks the phone server's
  local `/settings/pin` for it, with a token it reads from the vault (`phone-admin`).
- `GET /api/phone` never carries the PIN. **Show** fetches it from `GET /api/phone/pin`
  (`cache-control: no-store`). **Change** sends `PUT /api/phone/pin` with 4-12 digits.
- Logs record that the PIN was revealed or changed, never the digits.
- The section is hidden when the helper isn't set up. It says "Not running on the PC" when the
  phone server is down (start the phone server).

## Archiving and deleting

A chat's ⋯ menu archives or deletes it, and so do **Archive folder** in the
Projects view and **Settings → Tidy up**. Signalbox asks Hermes to do it
(`PATCH` and `DELETE /api/sessions/<id>` on the dashboard), so the Hermes
desktop app and dashboard hide an archived chat too.

- **Archive** hides the chat with its whole compression lineage (the earlier
  ids a long chat continued from); nothing is lost. Its delegate_task runs
  leave the inbox with it, since Signalbox only folds runs under listed chats.
  The chats it started through the bridge are archived along with it.
- **Restore** (Settings → Tidy up → Archived threads) un-archives it. Hermes
  also un-archives a chat it closed by accident when you resume it.
- **Delete** archives the chat first, so no part of it shows meanwhile, then
  deletes every id of its lineage. Hermes takes each id's delegate_task runs
  along. It can't be undone.
- The inbox lists only the 60 most recent chats, so **Archive folder** and
  **Archive idle threads** page through every chat Hermes has (100 at a time,
  up to 5,000), not just the listed ones. A folder takes the chats the
  Projects view would file under it: those in the folder itself, and those in
  its subfolders when it's a Paseo project. Chats that are working or waiting
  on you are never archived as idle.

## Reconnecting

While the connection is down, **Settings → Connections** shows the reason, such
as Hermes being unreachable. Signalbox keeps retrying with the delays above,
unless Hermes rejected the saved password (see [Signing in](#signing-in)).
Each new connection:

1. gets a fresh ticket and calls `client.capabilities` again;
2. forgets every runtime id, cached command catalog and model list, because
   they belonged to the old connection;
3. attaches again to every chat that's open in a browser. The resume snapshot
   brings back a reply in progress and any open requests;
4. reloads statuses (`session.active_list`) and the chat list.

Cards that were waiting stay. Answers to requests from an older connection go
through `request.answer`, never to the new connection as a response.

Your browser reconnects to Signalbox on its own and catches up; see
[how-it-works.md](how-it-works.md#live-updates).

## Turning Hermes off

Set `"hermes": { "enabled": false }` in the config. Signalbox then never
contacts the dashboard, and Hermes disappears from the interface. At least one
of Hermes and Paseo must stay enabled.
