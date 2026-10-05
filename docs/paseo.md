# How Wayroost talks to Paseo

Wayroost connects to the Paseo daemon on your machine
(`ws://127.0.0.1:19007/ws` by default) with Paseo's own client library,
`@getpaseo/client`, pinned to **0.9.2**. Code: `server/src/paseo/`.

## Compatibility

Since 0.9.2, the daemon sends a client only what it has subscribed to: the
agent list, each agent's timeline, and permission and sub-agent events. The
client library owns those subscriptions and releases them when Wayroost stops.
Wayroost holds one subscription for the agent list, one for permission and
sub-agent events, and one for each timeline it keeps open, and takes fresh ones
on every connection.

This is verified end to end, not assumed: `scripts/paseo-compat/run.ts` starts a
real Paseo daemon of any version and drives Wayroost through launching an agent
(with consent), a permission request, an approval answered outside Wayroost,
streaming, a follow-up, stopping, the agent's "/" commands, files, a message
sent while the agent works, the model, reasoning and mode pickers, reading
images the agent shows, a Hermes-in-Paseo agent's parent label and ACP session
id, and a daemon restart after which stored agents must not be woken and that
label and id must still be there. CI runs it against 0.9.2 and against the
latest release. A failure against the latest release is reported but doesn't
fail the build.

## Connecting

- The client identifies itself with a **stable client id**, kept in
  `/var/lib/signalbox/paseo-client-id`. Paseo groups sockets into sessions by
  client id.
- It sends its client library's version as its **`appVersion`** (`0.9.2`).
  Without an app version of at least 0.1.45, the daemon hides custom providers
  such as Hermes and Pi.
- On **every (re)connect**, Wayroost re-lists agents and subscribes to agent
  updates, rebuilds the list of pending permissions from the agents' snapshots,
  asks running agents for their [sub-agents](#sub-agents), and catches up
  every open timeline. The daemon forgets subscriptions when a socket drops.
- It never sends Paseo's "I'm looking at this" heartbeat, so it doesn't suppress
  the push notifications of Paseo's own phone app.
- **A daemon password** (`paseo daemon set-password`) reaches Wayroost as the
  systemd credential `paseo-password`: `LoadCredential=paseo-password:/etc/signalbox/paseo-password`
  in a `signalbox.service.d` drop-in, with the file root-only.
  - The client sends the password as a bearer header and as the WebSocket
    subprotocol `paseo.bearer.<password>`, so it must use HTTP token characters
    only: no spaces, commas, quotes or slashes. Wayroost refuses one that
    doesn't and logs why.
  - If the daemon refuses Wayroost ("Password required" / "Incorrect
    password"), the log says so once, and Settings shows Paseo disconnected
    with that reason.
  - No credential means no password, which an open daemon accepts.

## The inbox

Each agent becomes a conversation:

| Wayroost | From Paseo |
| --- | --- |
| title | the agent's title |
| status | `running`/`initializing` → working; `error` → error; pending permissions → needs you |
| agent | the provider label (Claude Code, Codex, OpenCode, Pi, Hermes…) |
| project | the git root (worktrees group with the main repo) or the working directory |
| nested under | the agent in Paseo's `paseo.parent-agent-id` label, else the Hermes chat in Wayroost's `signalbox.parent-hermes-chat` label, else (while Wayroost remembers it) the chat that started it through the [bridge](bridge.md#starting-chats) |
| Hermes · in Paseo | agents whose provider is `hermes`. Such an agent is also known by its ACP session id, the id Hermes gives it, so the `delegate_task` runs it starts nest under it. Nothing else of how Paseo resumes it leaves the server. |

Only active agents are listed: archived ones are left out, like in the Paseo
app.

## Sub-agents

Claude Code's Task tool (and its counterparts in Codex, OpenCode and OMP) runs
sub-agents inside an agent. Paseo tells every client as they start, change and
end, and Wayroost lists each as a read-only row under the agent that runs it,
in that agent's project:

- It's titled with its name, else its task, else "Sub-agent", and marked
  "Sub-agent · Claude Code" (or its agent). It shows as working while it runs,
  as an error if it failed, and as idle otherwise.
- Opening it says which agent it's a sub-agent of, and that its work shows in
  that agent's tool cards. Nothing is fetched from Paseo.
- It can't be messaged, stopped or changed, and it has no commands or
  approvals of its own. Wayroost refuses such requests.
- Wayroost keeps the newest 20 per agent and 200 in all, in memory, while
  Paseo has the agent running. It forgets them when the agent closes or goes.
- When it connects, and when an agent starts running, Wayroost asks Paseo for
  that agent's sub-agents. It asks only about agents of providers that have
  them, never about Hermes, and never about an agent Paseo only has stored:
  asking would make Paseo resume it.
- The project bridge never offers them to other agents.

## Timelines

Opening a conversation loads the last 120 timeline entries. Opening a **stored**
agent makes Paseo resume it, which can take a few seconds the first time.
Wayroost only does this when you open a conversation, never in the background.

Live updates are reconciled the way the Paseo app does it
(`server/src/paseo/mirror.ts`):

- Every live event carries an **epoch** and a **sequence number**. Events
  already covered by the loaded history are ignored. The next expected number
  is applied.
- A **gap**, or a timeline subscription restored after a reconnect, triggers a
  catch-up. Paseo answers with snapshots of the rows after the last one seen,
  and each snapshot replaces the row it overlaps, so text is never repeated.
- A **new epoch** or a replacement notice means the agent was reloaded: the
  timeline is fetched again and replaced. A fetch that was already under way
  is thrown away.
- Contiguous streamed text chunks are merged into one reply, and a tool call's
  updates are merged into one card.
- If Paseo ends a timeline subscription with an error, Wayroost drops that
  timeline; opening the conversation again subscribes afresh. A timeline being
  opened is never evicted from the cache mid-load.

Item mapping:

| Paseo item | Wayroost |
| --- | --- |
| `user_message`, `assistant_message`, `reasoning` | your message (with the files you sent, see below), reply (markdown), thinking |
| `tool_call` (shell, read, edit, write, search, fetch, sub-agent, plan…) | a tool card with a one-line summary, the input and output, and its status |
| `todo` | a "Todo list" card (`3 of 5 done`) |
| `error`, `[System Error]` replies | an error notice |
| `compaction` | "Compacting the conversation…", then "Conversation compacted" |
| turn cancelled | "Stopped" |

## Permissions and questions

Wayroost subscribes to Paseo's `agent_permission_request` and
`agent_permission_resolved` events, so an approval answered in the Paseo app
clears here too. It turns each request into an approval card:

- **Tool permissions** carry the agent's own actions, for example Allow once /
  Allow for session / Always allow / Deny for ACP agents such as Hermes. The
  card shows the command, file path, diff or URL.
- **Plans** (Claude's "Implement") are shown with a note that implementing
  switches the agent to auto-accepting edits.
- **Questions** (`AskUserQuestion`-style, several questions with options) become
  one card per question. The answers are collected and sent together, in the
  same shape the Paseo app sends them. A final answer that fails to send keeps
  its card for a retry.

Your answer is checked against the offered actions before it's sent with
`respondToPermissionAndWait`, and the card clears when Paseo confirms.

## Launching agents

The **New → Paseo** sheet lists every provider Paseo reports as ready, your
recent project folders, and each provider's permission modes. The first
message can carry files, as described below. Wayroost classifies every mode:

| Tier | Meaning | Examples | In Wayroost |
| --- | --- | --- | --- |
| asks you | the agent waits for your approval before risky actions | Claude *Always Ask*, *Plan*; Codex *Default permissions*; Copilot *Agent*, *Plan*; OpenCode *Plan*; Hermes *default* | offered normally, the default |
| acts on its own | some or all actions run without asking | Claude *Accept File Edits*, *Auto*; Codex *Auto-review*; OpenCode *Build*; Hermes *accept_edits*; providers with no modes, like Pi | offered with ⚡; launching needs an explicit "I understand", checked by the server |
| turns everything off | no safeguards | Claude *Bypass*; Codex *Full access*; Copilot *Allow all*; Hermes *Don't ask*; anything named yolo/bypass/full-access | never offered, rejected by the server |

Unknown providers are classified by name: conservative ids like `default`,
`ask`, `plan` count as asking, names matching the blocked patterns are blocked,
and everything else needs consent.

Wayroost always sends an explicit mode and never relies on the daemon's
default. For Hermes agents it also turns Paseo's `auto_accept` feature off. If
your chosen folder matches an existing Paseo workspace, the agent joins it
instead of creating a new one.

## Cloud agents

**Settings → Cloud agents** has an on/off switch for each Paseo agent that
runs on a cloud model: Claude Code, Codex and OpenCode, when Paseo knows them.
The switch is Paseo's own (`agents.providers.<id>.enabled` in
`~/.paseo/config.json`, set through the daemon's config API), so it holds
everywhere, not only in Wayroost:

- A switched-off agent can't be started by anyone: not from the **New → Paseo**
  sheet, not by another agent through the bridge or Paseo's own agent tools,
  and not from the Paseo app.
- Agents already running aren't stopped. They keep going until they're closed.
- Paseo saves the change and applies it at once, without a restart. Switching
  an agent back on makes Paseo check it again, and its row then says whether it
  can run (for example "not installed or signed out").

Hermes and Pi run on models you host yourself, so they aren't listed.

An agent can still run a CLI such as `codex exec` straight from its own
terminal, which doesn't go through Paseo. To cover that too, put a small
wrapper ahead of the real CLI on the agents' `PATH` that refuses to run while
Paseo has that provider switched off. Agents run as your user, so this guards
against accidents, not against a determined agent.

## What a folder says about itself

Folders often configure the agents that work in them, and those files were not
written by Wayroost. When you choose a folder for a Paseo agent, the sheet looks
at the folder's configuration and says, in plain words, what it would let an
agent do:

- `Files here can give Claude Code permission to act without asking.`
- `This folder has hooks Claude Code runs without asking.`
- `This folder has code Paseo runs on its own.` — a plugin or a command Paseo
  loads whatever agent you chose to work there.
- `This folder has VS Code configuration Wayroost could not read.`

Every warning group is shown, with at most four file names in each and a count
of any others. Wayroost reads configuration contents as the folder's owner to
classify them, but returns and displays only file names and findings. Nested
folders include configuration inherited within their workspace. Nothing runs
while you read the card, and the card is advice rather than a gate — Launch stays
available, and a folder Wayroost could not fully read says so on the same card.
Launch waits for the current folder and agent's check, even if you start before
the card loads; findings and failed checks still allow the agent to start.
Instruction files (`AGENTS.md` and friends) go unmentioned: they are text an
agent reads, not something that runs. A Hermes chat isn't asked, since a Hermes
chat reads its folder's files the way it always has.

## Archiving and deleting

A thread's ⋯ menu archives or deletes it, and so do **Archive folder** in the
Projects view and **Settings → Tidy up**. Wayroost uses Paseo's own archive,
so the Paseo app hides an archived agent too.

- **Archive** calls Paseo's `archiveAgent`. Paseo archives an agent's delegated
  children with it; Wayroost archives the deepest first, so none is left
  behind. The chats a thread started through the bridge go too.
- **Restore** has Paseo reload the agent (`refreshAgent`), which un-archives
  it. Paseo also un-archives an agent that gets a new message.
- **Delete** calls `deleteAgent`. It can't be undone.
- **Archive idle threads** takes every agent Paseo lists whose last activity
  (its last message from you, or when Wayroost saw it run) is older than the
  days you pick, except sub-agents and agents that are working or waiting on
  you.

## Sending and stopping

- Messages use `sendAgentMessage` with a fresh message id.
- While the agent is working, a message is sent with
  `activeTurnBehavior: "steer"`, as the Paseo app sends it. Claude Code, Codex
  and OpenCode take it into the running turn. ACP agents (such as Hermes in
  Paseo) and Pi can't be steered, so the running turn stops and a new one
  starts with your message.
- **Stop** calls `cancelAgent`. Paseo also denies any pending permission of that
  turn.

## Files and photos

The paperclip adds up to four photos, PDFs, text files or documents (Office, archives, SQLite, Parquet) to a message, 10 MB
each. The server checks every file's real type from its bytes before Paseo
sees it (see [SECURITY.md](../SECURITY.md)). Then:

| File | How it reaches the agent |
| --- | --- |
| image | in `images`, as raw base64 |
| text file up to 100 KB | inline, as a `text/plain` attachment titled with the file name. Its text starts with "Attached file: <name>", because agents see only the text. |
| PDF, document (xlsx, docx, zip…), or a larger text file | uploaded with Paseo's `uploadFile`, and attached as the `uploaded_file` it returns, so the agent gets its path. Paseo saves these under `~/.paseo/uploads` and never deletes them. |

- Wayroost doesn't check first whether the agent can see images. Paseo gives a
  provider without vision the image's path instead.
- An upload Paseo refuses shows as "Paseo couldn't take <name>: …", and nothing
  is sent.
- Paseo's timeline keeps only the text of your message. Wayroost remembers
  which files each message carried, by message id, for the last 500 messages
  in memory, and shows them as chips on the message.

## "/" commands

Typing `/` offers the agent's own commands and skills, from Paseo's
`listCommands`:

- Wayroost asks only agents Paseo reports as running. Asking a stored agent
  would make Paseo resume it, so a stored agent's commands appear once you open
  the conversation.
- A list is kept for five minutes. An empty one isn't kept, because an agent
  that just started may not have announced its commands yet. If Paseo reports
  an error, the menu stays empty, as in the Paseo app.
- Commands run by sending the text as an ordinary message. The agent handles
  them.

## Model, reasoning and mode

Chips above the message box show the agent's model, reasoning level and mode,
and how full its context window is. They come from Paseo's providers snapshot
for the agent's folder (kept for five minutes) and from the agent's own
snapshot, as Paseo's own composer reads them:

| Chip | Options |
| --- | --- |
| Model | the provider's selectable models |
| Reasoning | the model's thinking levels, shown only when it has two or more |
| Mode | the agent's modes, or the provider's for an agent Paseo only has stored, in the same tiers as at launch: blocked modes are hidden and refused, and modes that act on their own are marked ⚡ and need an explicit "I understand", checked by the server |

- Hermes in Paseo can't switch models during a turn. While it works, the model
  chip says "Hermes can switch models between turns."
- Reading the chips never wakes a stored agent. Changing one does, because
  Paseo loads the agent to apply the change.
- Only offered options are accepted. After a change, Wayroost reads the agent
  again, so the chips show what Paseo applied.
- Wayroost never touches the agent's `features`, so Hermes' `auto_accept`
  stays off.

## Images the agent shows

When an agent's reply or tool call points at an image on your machine,
Wayroost reads it through Paseo's `readFile`, the way the Paseo app does
(see [how-it-works.md](how-it-works.md#images-from-your-machine)):

- The folder the path is read against is chosen as the Paseo app chooses it:
  `~` for paths in your home folder, the agent's folder for paths inside it (so
  Paseo refuses a symlink that leads out of it), and `/` for other absolute
  paths.
- At most 20 MB, and Paseo must report the file as an image.
- It's a file read, not a call to the agent, so it never wakes a stored agent.

## Turning Paseo off

Set `"paseo": { "enabled": false }` in the config. Paseo then disappears from
the interface.


## Scheduled jobs

Paseo's schedules start a coding agent on a cadence: a cron line (with a time zone) or
"every N minutes". Each run starts a fresh agent in a folder, or prompts an existing agent.
Paseo agents create them with the `create_schedule` tool (see the `paseo` skill), and so does
`paseo schedule create`.

Settings → Scheduled jobs lists them next to Hermes' jobs, with a Paseo badge:
- the schedule, next and last run, and which agent runs it ("New claude agent in ~/app",
  "Paseo agent: Watch CI");
- the state comes from Paseo (active, paused, completed), plus "running now" or "last run
  failed" from the latest run;
- **Run now**, the pause switch, **Edit** (name, instructions, schedule) and **Delete**, all
  through the daemon client (`schedule/run-once`, `pause`/`resume`, `update`, `delete`);
- recent runs (`schedule/logs`), newest first. A failed run shows its error. Tapping a run
  opens the agent that ran it.

Paseo's update takes only a cron line, so "every 15m" or "every 2h" typed in Edit becomes the
matching cron line. Other wording is refused with a hint. New jobs from Wayroost are Hermes
jobs: a Paseo schedule needs a provider and a folder, so set those up in Paseo.

Per-agent heartbeats (`create_heartbeat`) aren't in Paseo's schedule list, and don't show here.
