# How Signalbox works

Signalbox is a small web server that runs next to your agents, plus a web app
you open on your phone. The server talks to Hermes and Paseo on your machine and
turns both into one stream of conversations, timelines and approvals. Cloudflare
carries the connection from your phone to the server, and checks who you are
before anything reaches your machine.

```
 phone / laptop browser
        │  HTTPS + WebSocket
        ▼
 Cloudflare edge ── Access: only your email gets past here
        │
        ▼  Cloudflare Tunnel (outbound connection from your machine; no open ports)
 cloudflared ─────── checks the Access token again (access.required)
        │  http://127.0.0.1:8790
        ▼
 Signalbox server ── checks the token a third time, then CSRF/Origin/Host rules
   ├── Hermes adapter ── HTTP + JSON-RPC WebSocket ──▶ Hermes dashboard  :9119
   └── Paseo adapter ─── Paseo client (WebSocket) ───▶ Paseo daemon      :6777
```

## The pieces

| Piece | Where | Job |
| --- | --- | --- |
| Web app | `web/src` | React single-page app: inbox, projects view, conversation, approvals, composer with its "/" menu and attachments, model and mode chips, image viewer. Installable to the home screen. |
| Server | `server/src/app.ts` | Serves the app, a JSON API and one WebSocket (`/ws`) for live events. Every request goes through the checks below. `server/src/attachments.ts` checks uploaded files, and `server/src/media.ts` signs links to images agents show. |
| Event hub | `server/src/hub.ts` | Sends list-level events (statuses, conversations, approvals) to every open browser, and timeline events only to browsers viewing that conversation. |
| Hermes adapter | `server/src/hermes` | Signs in to the Hermes dashboard, speaks its JSON-RPC protocol, uploads files and runs "/" commands. See [hermes.md](hermes.md). |
| Paseo adapter | `server/src/paseo` | Uses Paseo's own client library to talk to the daemon. See [paseo.md](paseo.md). |
| Project bridge | `server/src/bridge`, `bridge/`, `hermes-plugin/` | Optional: a loopback listener, the stdio MCP server agents start, and a Hermes plugin that says which Hermes chat is calling, so agents in one project can reach each other's chats. See [bridge.md](bridge.md). |
| Shared protocol | `shared/protocol.ts` | The types both sides agree on. Adapters translate everything into these, so the UI never needs to know which backend a message came from. |

## A request, step by step

1. Your phone opens `https://signalbox.example.com`. **Cloudflare Access** sees
   no session and sends you to its login page; after you sign in with your email
   code, it sets a cookie for this hostname.
2. Every later request carries that cookie. Access validates it and forwards the
   request through the **tunnel** with a signed token
   (`Cf-Access-Jwt-Assertion`). cloudflared rejects the request if the token is
   missing or invalid.
3. The **Signalbox server** checks, in order:
   - the **Host** header is your hostname (blocks DNS rebinding);
   - the **token**: signature against your team's keys, issuer, audience,
     expiry, and your email on the allowlist;
   - for API calls: a custom request header, `Sec-Fetch-Site`, an exact
     `Origin` and a JSON content type for anything that changes state (blocks
     CSRF); for the WebSocket: an exact `Origin` (blocks cross-site WebSocket
     hijacking).
4. The handler validates the body with strict schemas and calls the right
   adapter.
5. Every response carries a strict Content-Security-Policy and related headers.

Nothing is served, not even the page itself, without passing these checks, with
one exception. Six files that a browser fetches when you add the app to your
home screen skip Signalbox's own token check: `/manifest.webmanifest`,
`/favicon.svg`, `/apple-touch-icon.png`, `/icons/icon-192.png`,
`/icons/icon-512.png` and `/icons/maskable-512.png`. They hold nothing
sensitive, only `GET` is exempt, and they still get the Host check. Cloudflare
Access at the edge and cloudflared's token check still guard them.

## Live updates

The browser keeps one WebSocket to `/ws`. The server pushes:

| Event | Sent to | Meaning |
| --- | --- | --- |
| `source_status` | everyone | Hermes or Paseo connected, reconnecting, needs sign-in, turned off. |
| `conversation_upsert` / `conversation_removed` | everyone | Inbox rows: title, status, preview, project, links. |
| `conversation_moved` | everyone | Hermes continued a chat under a new id after compressing it; an open view follows. |
| `approval_upsert` / `approval_removed` | everyone | Something waiting on you, or no longer waiting. |
| `items_upsert` / `items_replace` | viewers of that conversation | Timeline items added or changed, or the whole timeline rebuilt. |
| `text_delta` | viewers of that conversation | Streaming text appended to a reply or reasoning block. |

The browser batches streaming deltas into one update per frame, reconnects with
backoff, re-syncs the inbox and the open conversation after every reconnect,
and reconnects immediately when your phone brings the page back to the front.
Sockets close when the Access token expires, and re-authenticate through
Cloudflare every 30 minutes.

## One model for two backends

Everything the UI shows is one of three shapes:

- **Conversation:** a Hermes session or a Paseo agent. It has a title, a
  status, a preview, which agent runs it, its **project folder**, and, for
  Paseo, the thread that started it.
- **Timeline item:** your message (with any attached files), a reply
  (markdown, with any images from your machine it points at), reasoning, a tool
  call with its input and output, the output of a "/" command, or a notice
  (errors, "Stopped").
- **Approval:** a permission request (run this command? edit this file?) or a
  question (which branch?), with the exact options the backend offered.

### Projects view

The inbox can group conversations by project folder:

- **Paseo** knows each agent's working directory and git root. Worktrees group
  with their main repository.
- **Hermes** knows each session's working folder. A Hermes chat whose folder is
  inside a Paseo project joins that project.

Inside a project, Hermes chats and Paseo threads sit in separate lanes. Paseo
agents started by another agent are nested under the thread that started them.
Hermes agents running inside Paseo carry a "Hermes · in Paseo" badge, and their
Hermes-side session is not listed twice.

## Approvals

Approvals are the most security-sensitive part of the app:

1. The adapter turns the backend's request into an `Approval` with exactly the
   options offered. For example, Hermes offers `once` / `session` / `always` /
   `deny`, and Paseo offers the agent's own actions.
2. The inbox pins anything waiting on you, and the conversation shows it above
   the message box.
3. The card shows the full command, with invisible characters and padding made
   visible. Long commands must be expanded before Allow unlocks, and a brand-new
   card ignores taps for ¾ s.
4. Your answer goes back to the server, which checks that the option was really
   offered, for that request, in that conversation, before passing it to the
   backend.
5. The backend confirms, and the card disappears on every device.

Signalbox never answers anything on its own. Password and secret prompts from
Hermes are never answered from the web.

## "/" commands and skills

Typing `/` in the message box opens a menu of the commands and skills the
conversation offers. You can pick with a tap, the arrow keys, Enter or Tab, and
after a command's name the menu offers its known argument values. Text such as
`/home/you/notes.txt` is a path, not a command.

- **Hermes:** Signalbox runs the command itself, the way the Hermes desktop app
  does. The menu is the gateway's own catalog (`commands.catalog`), without the
  commands the desktop app hides or that only make sense in a terminal. Sending
  `/name args` calls `slash.exec`, falling back to `command.dispatch`. A skill
  expands into a prompt, and the chat shows `/name args` instead of the whole
  skill. Other output appears as a command block in the timeline; Hermes
  doesn't store it, so Signalbox keeps the last 20 per chat in memory. A
  command still running after 15 s shows as running and finishes live. `/new`
  opens the New sheet instead. Details are in [hermes.md](hermes.md#-commands).
- **Paseo:** the agent's own commands and skills (for example Claude Code's),
  from Paseo's `listCommands`, for agents that are running. A stored agent
  isn't woken to ask, so its commands appear once you open the conversation.
  Signalbox sends the text to the agent as an ordinary message, and the agent
  runs it itself. Details are in [paseo.md](paseo.md#-commands).

A few Hermes commands are refused because they switch safeguards off, answer
approvals away from their card, or upload your logs; see
[SECURITY.md](../SECURITY.md).

## Attachments

The paperclip sends up to four photos, PDFs, text files or documents with a message, 10 MB
each. The browser shrinks large photos first: anything over 1.5 MB or 2,048 px,
and formats such as HEIC, becomes a JPEG at most 2,048 px on its long side
(GIFs are sent as they are). The server checks each file's real type from its
bytes and refuses anything that isn't a PNG, JPEG, GIF or WebP image, a PDF,
UTF-8 text, or one of these documents: Office documents (xlsx, xlsm, docx, pptx, xls, doc, ppt, ods, odt, odp), Outlook .msg, EPUB, archives (zip, tar, gz/tgz, 7z), SQLite databases and Parquet files. A document counts only when its
bytes and its extension agree (`shared/documents.ts`). Then:

- **Hermes:** uploads each file to the session before the prompt, as the desktop
  app does. Images go through `image.attach_bytes`; other files go through
  `file.attach` and are referenced from the prompt text. Files are refused
  while a reply is running. Details are in
  [hermes.md](hermes.md#files-and-photos).
- **Paseo:** sends images to the agent inline, as base64, and text files up to
  100 KB as text. PDFs, documents and larger text files go through Paseo's upload, and the
  agent gets their path; Paseo keeps them in `~/.paseo/uploads`. Details are in
  [paseo.md](paseo.md#files-and-photos).

The timeline shows sent files as chips. Photos you sent from this browser also
show a thumbnail.

## Model and mode

Chips above the message box show the conversation's model, its reasoning level
and, for Paseo, its mode, next to a ring that shows how full the context window
is. Tapping a chip opens a picker. A change applies to this conversation only,
and the chips show what the backend reports back.

- **Hermes:** models from `model.options`, switched for this chat only, so
  Hermes' saved defaults never change. Expensive models ask first, and a switch
  during a turn takes effect on the next one. Details are in
  [hermes.md](hermes.md#model-and-reasoning).
- **Paseo:** models, thinking levels and modes from Paseo's own snapshots.
  Modes follow the same tiers as at launch: modes that turn every safeguard off
  are hidden and refused, and modes that act on their own need an explicit "I
  understand", checked by the server. Reading the chips never wakes a stored
  agent. Details are in [paseo.md](paseo.md#model-reasoning-and-mode).

| The chips and the context ring | A mode that acts on its own |
| --- | --- |
| <img src="images/22-phone-controls-strip.png" width="220" alt="Model and reasoning chips above the message box of a Hermes chat, with the context ring"> | <img src="images/24-phone-mode-consent.png" width="220" alt="Switching a Paseo agent to Accept File Edits, waiting for the I understand checkbox"> |

## Images from your machine

Agents often make or look at images on your machine: a chart they drew, a
screenshot a tool took. Signalbox shows them without the browser ever asking
for a file by its path (`server/src/media.ts`).

**Finding them.** The server checks every reply and tool card before it goes to
the browser. Only PNG, JPEG, GIF and WebP file names count.

- A markdown image with a local path, such as
  `![chart](/home/you/project/chart.png)`, a `~/` path or a `file://` URL, is
  signed in place and shows inline.
- Other mentions become thumbnails under the reply, at most four per item:
  `MEDIA:` tags (the way Hermes agents deliver files), links to local images,
  and bare absolute or `~/` paths outside fenced code blocks. Paths inside code
  blocks are usually logs, not something to show.
- On tool cards, the same goes for well-known fields of the tool's input and
  output (`image_url`, `image_path`, `path`, `file_path`, `host_image`,
  `image`, `screenshot_path`) and for `MEDIA:` tags.

Hermes tool results that carry an image as inline base64 show their text
summary, or `[image]`, instead of the data.

**Signed links.** Each image becomes a link to
`/api/media/<source>/<conversation>?p=…&s=…`, signed with HMAC-SHA256 over the
conversation and the path. The key is made fresh every time the server starts,
so a link only works in its own conversation and stops working after a
restart; reopening the conversation makes new ones. There's no way to ask for
any other file.

**Refused locations.** Some places are never read, whatever an agent says:

- system folders: `/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`,
  `/var/log`, `/var/lib`, `/var/run` and `/run`;
- credential folders anywhere in the path: `.ssh`, `.aws`, `.gnupg`, `.kube`,
  `.docker`, `.config`, `.azure`, `.gcloud` and `Keychains`;
- Hermes' store, `~/.hermes`, except its `images`, `screenshots`, `cache` and
  `attachments` folders (also inside a profile);
- Paseo's store, `~/.paseo`, except its `uploads` folder.

These checks run when a link is made and again when it's used.

**Reading.** The Signalbox service can't read your files: it has no access to
`/home`. It asks the backend that runs the agent instead: the Hermes dashboard
(`/api/fs/download`, with the chat's session id, as the Hermes desktop app
does), or Paseo (`readFile`, against the folder the Paseo app would use).

**What's served.** The bytes must really be a PNG, JPEG, GIF or WebP image,
checked by their first bytes, and at most 20 MB. The response carries its own
`Content-Security-Policy: default-src 'none'; sandbox`.

**On the phone.** The browser never sends a path. It fetches only links shaped
like the ones the server signs, with the same headers as any API call, and
shows the bytes as `blob:` URLs. A plain link to such an image shows as text.
Images load only when they're near the screen, and at most 30 of them, up to
120 MB, stay in memory. A tap opens a full-screen viewer.

| Inline, and a thumbnail | The viewer | On a tool card |
| --- | --- | --- |
| <img src="images/26-phone-inline-image.png" width="220" alt="A chart from the agent's project folder shown inline in a reply, with a thumbnail below"> | <img src="images/27-phone-image-viewer.png" width="220" alt="An image from the machine opened full screen"> | <img src="images/28-phone-tool-image.png" width="220" alt="A thumbnail of the screenshot a tool looked at, on its tool card"> |

## The project bridge

The optional [project bridge](bridge.md) lets the agents in one project work
together, across Hermes and Paseo. It's off unless you turn it on.

```
 agent (Claude Code, OpenCode, pi, Hermes, a Paseo agent…)
   └─ node /opt/signalbox/bin/signalbox-bridge.mjs     stdio MCP server, token from ~/.config/signalbox
        └─ HTTP, Bearer token ──▶ bridge listener 127.0.0.1:8792 (inside the Signalbox server)
                                    └─ the same Hermes and Paseo adapters the app uses
```

- **Five tools:** `list_chats`, `read_chat`, `send_message`, `wait_for_reply`
  and `start_chat`, scoped to the caller's project as the Projects view groups
  it.
- **Who is calling:** a Paseo agent by the id Paseo gives it, and a Hermes chat
  by its session id, which the `signalbox-identity` Hermes plugin adds to each
  call. Signalbox checks both against the chats it lists; anyone else is
  unverified.
- **Messages** arrive labelled as coming from another agent, not from you,
  with the sender's reply address when Signalbox knows the sender. The phone
  shows them as "From <sender> · via Signalbox" bubbles. They're delivered once
  the chat is idle with no approvals waiting, so a working chat is never
  interrupted; an answer to a chat that's waiting for it with `wait_for_reply`
  goes to the wait instead.
- **Guards:** rate limits, a loop breaker, no "/" commands, and new Paseo agents
  only in modes that ask you, with caps per project. Nothing reaches approvals,
  modes or models.
- **Pause** in Settings refuses every call and ends open waits at once.
- **Separate from the app:** the listener only binds to `127.0.0.1`, isn't
  routed through the tunnel, and takes only its bearer token. It refuses
  browsers.

| A message from another agent | Pausing the bridge |
| --- | --- |
| <img src="images/29-phone-bridged-message.png" width="220" alt="A Hermes chat started by a Paseo agent, with its messages shown as From Fix flaky login test (Claude Code) via Signalbox"> | <img src="images/30-phone-bridge-settings.png" width="220" alt="The Project bridge section of Settings, paused, with the last hour's activity"> |

## Starting agents safely

New Paseo agents always start in an explicit, vetted mode. Each provider's modes
fall into one of three tiers:

- modes that **ask you** are offered normally;
- modes that **act on their own** need an explicit "I understand";
- modes that **turn off every safeguard** are never offered.

The same tiers apply when you switch an agent's mode later. Details are in
[paseo.md](paseo.md#launching-agents).

## The host

- The server runs as a throwaway systemd user (`DynamicUser`) with no home and
  no access to `/home`, in a sandbox. It keeps its only state (your Hermes
  sign-in, a client id) in `/var/lib/signalbox`.
- cloudflared runs as its own throwaway user and gets the tunnel credential from
  systemd.
- The installed code is root-owned and read-only. The installer and the tunnel
  setup script refuse a checkout that anyone but root could modify, including
  through a parent directory, and refuse `node`, `npm` or `cloudflared`
  binaries that anyone but root could modify.
