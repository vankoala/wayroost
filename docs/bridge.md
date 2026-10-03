# The project bridge

The project bridge lets the agents working in one project work together, across
Hermes and Paseo. An agent can see the other chats in its project, read them,
send them messages (which also wakes an idle chat), wait for their answers, and
start new chats. The project is the one the Projects view shows. Approvals
always stay with you: the bridge has no way to see, answer or change approvals,
modes or models.

It's off unless you turn it on. It isn't a sandbox: every agent runs as the
same user on your machine, so the bridge's guards keep accidents and loops
unlikely rather than stopping a determined agent (see
[SECURITY.md](../SECURITY.md#the-project-bridge)).

Code: `server/src/bridge/` (the server side), `bridge/signalbox-bridge.mjs`
(the agents' side), `hermes-plugin/signalbox-identity/` (the Hermes plugin that
says which Hermes chat is calling) and `deploy/setup-bridge.sh`.

```
 agent (Claude Code, OpenCode, pi, Hermes, a Paseo agent…)
   └─ starts: node /opt/signalbox/bin/signalbox-bridge.mjs    stdio MCP server
        reads its token from ~/.config/signalbox/bridge-token
        └─ POST http://127.0.0.1:19012/bridge/v1/<tool>          Bearer token
             Wayroost's bridge listener (loopback only, no Cloudflare)
               └─ Hermes and Paseo, through the same adapters the app uses
```

## The five tools

Agents see five MCP tools. Each can take an optional `project` (an absolute
folder); without it, the agent's own folder is used.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `list_chats` | none | The project (`path`, `name`) and up to 50 chats in it, most recently active first, with a count of any not listed. When Wayroost knows the caller's own chat, that chat is left out and named under `you`; otherwise a `note` says other chats can't reply to the caller and `wait_for_reply` won't work. Each chat has `chat` (an id like `paseo:<id>` or `hermes:<id>`), `title`, `backend`, `agent`, `status` (`working`, `idle`, `needs_approval` or `error`), `updated`, a short `preview`, and `started_by` when another chat started it. |
| `read_chat` | `chat`, `limit` (1 to 50, default 20) | The chat's title, agent and status, and its newest items, oldest first: user messages, messages from other agents (`role: "agent"`, with `from`, and `reply_to` when the message has a reply address), replies, one-line tool summaries (`[tool] name: summary (status)`) and notices. Reasoning and "/" command output are left out. Each item is cut at 2,000 characters and the whole at 16,000, dropping the oldest. |
| `send_message` | `chat`, `text` (up to 8,000 characters) | `{"delivered": "now"}`, or `{"delivered": "queued", "position": n}`, with a `note` on what to do next |
| `wait_for_reply` | `chat`, `timeout_seconds` (1 to 120, default 45) | How the chat answered: a `reply`, `finished` or `timed_out`. See [Waiting for a reply](#waiting-for-a-reply). |
| `start_chat` | `backend` (`paseo` or `hermes`), `text`, and for Paseo `agent` and optionally `mode`; `title` | `{"chat": "<id>", "title": "…"}`, with a `note` |

**Most recently active** goes by each chat's last activity, which is also its
`updated` time and the time the inbox sorts by. For a Hermes chat, that's
Hermes' own last-active time. For a Paseo agent, it's the later of its last user
message (a bridge delivery counts; before the first one, when the agent was
created) and the last time Wayroost saw it start or stop running. Paseo's own
`updatedAt` isn't used, because it also moves when Paseo merely reloads or
resumes an agent. Wayroost keeps the run times in memory, so after a restart
the last user message stands in until the agent runs again.

Reading a stored Paseo agent can make Paseo resume it, as opening it in the
app does; that doesn't count as activity. A refusal comes back as a tool error
with a plain message, such as "That chat isn't in this project."

## Who is calling

The agents' side of the bridge sends two headers with every call:
`X-Bridge-Paseo-Agent`, from the `PASEO_AGENT_ID` that Paseo sets for the agents
it runs, and `X-Bridge-Cwd`, from `PASEO_AGENT_CWD` or else the folder the tool
runs in. Under Hermes, with the Hermes plugin, it also sends
`X-Bridge-Hermes-Session`, the calling chat's session id (see
[Hermes chats](#hermes-chats)).

- **An identified chat** is a Paseo agent whose id Paseo lists, or a Hermes
  chat whose session id is one Wayroost lists. The Paseo id is checked first.
  Its messages are signed with its title and agent, such as "Fix flaky login
  test (Claude Code)" or "Release notes (Hermes)", and carry its reply address.
  Its own project wins over any `project` it names, its own chat is left out of
  `list_chats`, and it can't message or wait for itself. Only identified chats
  can use `wait_for_reply`, show as "started by" on the chats they start, and
  be paired by the loop breaker.
- **A sub-agent speaks for the chat that runs it.** A caller whose id is a
  sub-agent's, such as a Claude Code Task run or a Hermes `delegate_task` run
  (which the Hermes plugin names by its own session id), counts as the
  top-most chat above it that isn't a sub-agent. Wayroost follows what
  started each one, including through the other ids a chat is known by (a
  Hermes-in-Paseo agent by its Hermes session). If it can't reach a listed
  chat that way, the caller is unverified.
- **Anyone else is unverified.** Its messages are signed "An agent in <folder>",
  or "A Hermes chat in <folder>" when the tool runs under Hermes, with no reply
  address, and its project comes from the `project` it names or its folder.
  Chat ids in arguments are never trusted as an identity.

The ids are claims, not proof: any process running as your user can read the
token and send any header.

### Hermes chats

Hermes starts one copy of the agents' side per process and shares it between
its chats, so on its own the bridge can't tell which Hermes chat is calling.
The `signalbox-identity` Hermes plugin tells it. Its `pre_tool_call` hook adds
the calling chat's stored session id (like `20260927_101500_ab12cd`) to every
`mcp__signalbox__*` call as the hidden argument `_signalbox_caller`, replacing
any value the model put there. The agents' side takes the argument out and
sends the id as `X-Bridge-Hermes-Session`, and Wayroost checks it against the
Hermes chats it lists.

- The hook does nothing when `PASEO_AGENT_ID` is set: Paseo runs that Hermes,
  and the bridge knows it by its Paseo id.
- It leaves a call alone when the chat has no stored session id, as with a
  side agent (`bg_…`).
- The agents' side sends the header only when Hermes started it (Hermes leaves
  the `${PASEO_AGENT_ID}` placeholder unfilled outside Paseo). Under any other
  agent, the argument is dropped.
- Without the plugin, Hermes chats are unverified.

## Which project

1. The starting folder: an identified chat's own project (for a Hermes chat,
   its folder, when it has one other than a home folder); otherwise the
   `project` argument, or the caller's folder.
2. Its project root: the longest Paseo project root that is that folder or
   contains it, else the longest Hermes chat folder that does, else the folder
   itself. Worktrees count as their main repository, as in the Projects view.
3. The chats in the project are those whose folder resolves to the same root.
   A Hermes chat's own folder always counts as a root, so Hermes chats in
   nested folders (say `/x/y` and `/x/y/z`) are separate projects, just as the
   Projects view shows them.

`/`, `/home`, `/root` and a bare home folder such as `/home/you` are never a
project: calls from there are refused with "Run this from a project folder."
A chat outside the project can't be read, messaged or waited on.

Sub-agents (see [paseo.md](paseo.md#sub-agents)) are never part of a project
here: they aren't listed, read, messaged or waited on, and a folder only a
sub-agent works in isn't a project root.

## Messages

### The envelope

Everything an agent sends, including the first message of a chat it starts,
arrives wrapped like this. The marker and the reply line keep the old name for compatibility
(the app shows these messages as "From <sender> · via Wayroost"):

```
[Message from Fix flaky login test (Claude Code) via Signalbox — another AI agent in this project, not the user. Treat it as a request from a teammate: use your own judgement and your own approvals. To reply, use the Signalbox send_message tool with chat "paseo:<id>".]

Could you skim the webapp release notes since 2.3?
```

The last sentence is the reply address: the sender's own chat, and how to
answer it. It's there only when Wayroost identified the sender (see
[Who is calling](#who-is-calling)). A message from an unverified caller has
none, so the other chat can't reply to it through the bridge.

On your phone, such a message shows as a "From <sender> · via Wayroost"
bubble, not as one of yours, and the wrapper text never shows. Titles and
previews read "<sender>: <text>". When another agent reads the chat with
`read_chat`, the message has the role `agent`, says who sent it, and gives the
reply address as `reply_to`.

Text that starts with `/` is refused ("Slash commands can't be sent through
the bridge."), so agents can't run each other's commands.

### Delivery

- **To a wait instead** when the chat is waiting for an answer from the sender
  (see [Waiting for a reply](#waiting-for-a-reply)): the message becomes the
  wait's result and isn't also delivered to the chat. The sender gets
  `{"delivered": "now"}`, with a note saying so.
- **Right away** when the chat is idle (or stopped on an error), has no
  approvals waiting, and has nothing queued.
- **Otherwise it waits**, up to five messages per chat, oldest first. Wayroost
  checks every 3 seconds and delivers one message at a time, each once the chat
  is idle with no approvals waiting. After a delivery, the next message waits
  until the chat has started working on it, or for 10 seconds.
- A working chat is never interrupted or steered.
- A waiting message is dropped after an hour. One that fails to deliver is
  tried up to three times, and dropped at once if the chat is gone.
- Waiting messages live in memory, so a restart of Wayroost drops them.

### Limits

| Limit | Allowed |
| --- | --- |
| Messages from one caller (unverified callers count per folder) | 12 per 10 minutes |
| Messages to one chat | 6 per 10 minutes |
| Messages from one caller to one chat | 4 per 10 minutes |
| All messages together | 60 per hour |

Every accepted message counts, whether it's delivered, queued or handed to a
wait. Over a limit, the call is refused with when to try again.

**The loop breaker.** Once two chats have each messaged the other three times
within 10 minutes, messages between them are paused for 30 minutes, messages
already waiting between them are dropped, and both timelines show "Wayroost
paused messages between these chats for 30 minutes to stop a loop." It can
only recognise pairs of chats Wayroost can identify: Paseo agents, and Hermes
chats when the Hermes plugin is on. Other back-and-forth is held back by the
limits above.

## Waiting for a reply

`wait_for_reply` holds the call open until the chat it names answers the
caller, finishes working, or the time runs out.

- **Who can wait:** only a chat Wayroost identifies (see
  [Who is calling](#who-is-calling)), for another chat in its project. Others
  are refused with "wait_for_reply needs a chat Wayroost can identify".
- **How long:** `timeout_seconds`, from 1 to 120, 45 by default. The agents'
  side gives Wayroost that long plus 15 seconds to answer; for the other tools
  it gives 60 seconds.
- **One at a time:** each chat has one wait open. A new one ends the old one
  with "A newer wait_for_reply replaced this one."

The result names the chat waited on as `from`, and says how the wait ended as
`kind`:

| `kind` | When | Also has |
| --- | --- | --- |
| `reply` | The chat answered the caller with `send_message`, or an answer from it was already waiting to reach the caller. | `text`, the answer without the envelope. It isn't also delivered to the caller's chat. |
| `finished` | The chat finished working without answering through the bridge. | `last_message`, the latest reply it wrote after the caller's own latest message to it, cut at 2,000 characters (with no such message, its latest reply), and a `note`. If it wrote nothing after that message, `last_message` is empty and the note says it wrote nothing new. |
| `timed_out` | Neither happened in time. | `status` (`working`, `idle`, `needs_approval` or `error`), and a `note` saying to call `wait_for_reply` again. |

Only a message from the chat waited on counts as a reply, and only when
Wayroost identifies that chat as the sender. Messages from other chats reach
the caller's chat as usual.

A chat has **finished** once it's idle (or stopped on an error) with no
approvals waiting, after working since the caller's last message reached it.
For a chat the caller started, that's since the start; if the caller sent it
nothing in the last hour, since the wait began. Wayroost counts it as having
worked if it saw the chat busy, if the chat's activity time moved (a turn too
quick to see), or if the chat is still idle 10 seconds after the message
reached it. While the caller's own message is still queued for the chat, the
wait goes on.

Wayroost checks open waits every 3 seconds. A wait ends early with a tool
error when you pause the bridge ("The user paused the Wayroost bridge.") or
Wayroost shuts down. If the caller hangs up (its tool call is cancelled or
times out, or the agent exits), Wayroost drops the wait, and a later answer
reaches the caller's chat as an ordinary message. Waits live in memory.

## Starting chats

- The new chat works in the project's root folder, and nowhere else.
- Its first message arrives in the envelope, with the starter's reply address
  when Wayroost knows the starter. Its title is the `title` given, or the
  first line of the message.
- **Paseo:** `agent` names a provider Paseo reports as ready, such as `claude`.
  The mode must be one that asks you before acting (the "asks you" tier in
  [paseo.md](paseo.md#launching-agents)); without `mode`, the provider's
  default is used only if it asks. Agents that never ask, like Pi, are refused
  with "<agent> doesn't ask before acting, so agents can't start it; ask the
  user.", and a mode that acts on its own with the list of modes that ask. The
  bridge never gives the consent that those need.
- **Hermes:** no `agent` or `mode`.
- **Caps:** agents may start three chats per project per hour, and at most two
  of those may be working (or waiting on you) at once. A chat that was just
  started counts as working for its first two minutes, until it's listed.
- **Started by:** when an identified chat (a Paseo agent, or a Hermes chat with
  the Hermes plugin on) starts a chat, the new chat shows "started by" its
  title in the inbox, the two link to each other, and the Projects view nests
  the new chat under its starter. Wayroost remembers this in memory, for up to
  500 chats per backend. A new Paseo agent also carries it as a label, which
  lasts as long as the agent: Paseo's `paseo.parent-agent-id` when a Paseo
  agent started it, and Wayroost's own `signalbox.parent-hermes-chat` when a
  Hermes chat did. (Paseo treats an agent with its own label as delegated: it
  sends no "needs attention" notifications for it and archives it with its
  parent. So that label only ever names a Paseo agent.) Chats that unverified
  callers start have no "started by".
- New chats ask you for their own approvals, like any other.

## What agents can't do

No tool lists, answers or changes approvals, permission modes or models, or
interrupts a chat. Agents don't see reasoning or "/" command output, and can't
send commands. The bridge gives agents a way to talk to each other, nothing
more.

## Pausing

**Settings → Project bridge** shows whether the bridge is on, paused or off in
the server config, and what agents did in the last hour: messages sent, queued
and chats started. **Pause** is a kill switch:

- every tool call is refused with "The user paused the Wayroost bridge.";
- a call already under way stops before it sends or starts anything;
- open waits end at once, with the same message;
- waiting messages stay waiting, go out after you resume, or are dropped after
  an hour.

[For you](for-you.md)'s card routes (`/pulse/v1`) share the listener but aren't
paused: they're not tools, and a card never reaches a chat by itself.

The pause lasts until you resume it or Wayroost restarts. Behind it are
`GET /api/bridge` and `PUT /api/bridge` on the main app, behind Cloudflare
Access like every other API call.

## Worker updates

A Hermes chat that starts a Paseo worker usually waits for it in the
background (`paseo run -d`, then a timed `paseo wait <id>` with
notify_on_complete), and wakes when it ends. That wait lives inside Hermes: a
Hermes restart kills it, and the news is lost. Worker updates are Wayroost's
safety net for it. When a worker that a Hermes chat started stops running
(finished, failed, or closed), waits on your approval, or runs past its time
box, Wayroost tells that chat:

- **Through the bridge's own queue,** signed "Signalbox task log": the chat
  gets it once it's idle with nothing waiting on you, never while the bridge
  is paused. Agents' rate limits don't count it; the task log keeps its own
  (one terminal update per worker run, six per chat in ten minutes).
- **Only for workers the chat really launched.** A worker carries the chat's
  id in its `signalbox.parent-hermes-chat` label (the bridge sets it for chats
  it starts; a command wrapper on the host, if you use one, can add it to
  `paseo run` from a Hermes terminal). A
  label is only a claim, so it counts once the chat's own records show the
  launch: a successful terminal (or process) result from a **single command**
  whose entire trimmed text is `paseo run ...`, with the full worker id in
  that command's own run table or JSON, within ten minutes of creation.
  Help and version invocations never count. Shell operators, newlines,
  comments, substitutions, redirections, here-documents, variable prefixes,
  and `cd ... &&` setup make the output untrusted. Run setup separately,
  then launch each worker in its own command. A launch recorded by the
  bridge's structured `start_chat` call is also trusted and saved before
  acknowledgement. Other text cannot reconstruct a launch.
  Until proven, the ledger marks the worker **not linked**, with `linkReason`,
  and sends no update. Terminal proof saved under the older permissive rules
  is checked again before delivery. At most 40 unproven
  workers (10 per chat) are followed at once, each chat's records are read once
  per round, and a chat whose records can't be read is left alone for five
  minutes after two failures.
- **The current chat owns delivery.** Each explicit Hermes move report
  (`old id → new id`) is saved immediately in `hermes-chat-moves.json` with
  mode 600. The relay and Hermes adapter share this map. They resolve the
  full chain before both readiness checks; the recent list and its aliases
  never establish equivalence. A continuation missing from that list still
  uses its own live readiness and approvals. The original root keeps the
  six-updates-in-ten-minutes budget, including pending reservations and
  delivery timestamps, across compression and restarts.
  Uncertain identity holds the update; the ledger records `held` and counts
  permanent resolution failures. At the existing five-failure limit it is
  marked `not delivered`. An unreadable identity file also holds delivery.
  Missing stored chats and “session not found” errors are permanent (404);
  other permanent RPC failures consume retry attempts. Only connection
  failures and explicit 503 unavailability leave that count untouched.
  An unlinked worker or held update is visible and safe; a wrong-chat
  delivery or a forged launch is the failure to prevent.
- **Completion updates are always sent for eligible runs.** Two minutes after
  a worker stops (one for an approval wait), Wayroost queues the update. A
  chat that already waited on its worker may also get this completion update;
  that duplicate is intended. Wait commands, process results and background
  exit notices never suppress it. Missing a completion is the failure this
  feature prevents. The message says to reply "already handled" if needed.
  The ledger deduplicates terminal updates by worker id and run number,
  including when a finished worker is later archived or changes terminal state.
  Delivered updates stay delivered across restarts; pending updates are restored.
  Older ledger entries suppressed by wait evidence are reopened once, subject
  to the existing off switch, stale-run rules and delivery limits.
- **What it says:** Wayroost's own lines first (the state, the worker's id,
  title, agent and folder, what to do next), then the worker's last message,
  quoted with every line starting `> ` and hidden characters removed, so worker
  text can't pose as Wayroost's lines. An approval wait is information only:
  approvals stay with you. A chat that came from WhatsApp is reminded to
  report there with `send_message`.
- **Late workers.** A worker's time box is its `signalbox.due-minutes` label,
  else the one set in Settings (60 minutes unless changed). Two minutes past
  it, the chat gets one "[Worker overdue]" regardless of earlier wait results.
  Fifteen minutes past it, you get a For-you card, which closes itself when the
  worker stops.
- **Status history.** Next to `tasks.json`, `task-events.jsonl` (mode 600) keeps
  one line per status change: times, ids and counts only, never titles, folders
  or message text. `tasks.json` stays the only authority for a task's current
  state; the history is telemetry for flow measures and never changes it. After
  180 days lines are rolled up into weekly totals. Known limits: after a crash
  in the middle of saving, or when a pruned worker is rediscovered, a run's
  durations in the history can be split, start a little late or overlap; the
  task's own state is unaffected.
- **Restarts.** The task log (`tasks.json` in the state directory, mode 600)
  remembers each worker's state and what the chat was told. A worker that
  stopped while Wayroost was down is reported once after it starts. For one
  that has left Paseo's list, Wayroost asks Paseo what became of it (archived
  agents included) and reports that; one Paseo no longer has counts as
  stopped. Outstanding trusted bridge launches retain eligibility across
  repeated recovery failures and restarts, independently of the ledger's
  heartbeat. An update queued but not delivered is queued again. Workers that
  had already stopped before Wayroost first looked aren't reported unless
  they run again, and nothing is sent about a worker Wayroost couldn't watch
  for over a day: by then it's history.
- **Details that keep it honest.**
  - Nothing is decided until Paseo's agent list is in.
  - A worker Paseo only has stored as "running" counts as stopped after two minutes.
  - A worker that stopped while Wayroost wasn't watching is reported as "stopped between A and B".
  - JSON that a worker wrote into a launch table (its title or appended activity) never proves a launch.
  - No command result suppresses completion updates.
  - Chat compression retargets queued news and its budget reservation to the current chat. A missed move is held until Hermes confirms the continuation's lineage and the move is saved. Live activity and approvals are checked after attachment and again immediately before sending. Each chat has an activity revision: submissions mark it working before the RPC, and events and new polls invalidate older poll readings. Only the newest poll issued after that chat's latest submission or event may apply; stale readings cannot clear its turn or approvals. Delivery requires the newest applied reading to say idle.
  - System news stays queued through transient outages and hourly expiry. Only handovers dropped for permanent send failures count toward the five-handover limit; the count is persisted separately from total handovers.
  - The six-in-ten-minutes budget belongs to the chat that gets the messages, so delegate runs share their manager's, re-sends included. Equal-time updates use the same key order in the queue and the budget reservations, including after compression merges queues. At most ten of Wayroost's messages wait for one chat; more are kept and handed over once there's room.
  - While Wayroost's connection to Paseo is down, its cached list is history: nothing is decided from it.
  - Turning the switch off also drops updates still waiting, and what ends while it's off (even briefly) isn't sent later.
  - Each run of a worker gets its own overdue card.
- **Side effects.** A delivered update starts a turn in the chat, like any
  bridge message: another agent waiting on that chat with `wait_for_reply` may
  get the chat's answer to the update as its "finished". Wayroost's own
  messages don't count in Settings' "Last hour" numbers or against agents'
  queue limit.

**Settings → Project bridge → Worker updates** turns it off, and sets the
time box for workers without their own (`GET`/`PUT /api/worker-updates`).
What happens while it's off isn't sent later.
It needs the bridge, Hermes and Paseo all on. Each step logs as `task log: …`
with ids and states, never what a worker or a chat wrote. A shadow server
(`role: "shadow"`) runs no bridge, so no completion relay either: nothing
follows workers, posts into a chat, raises a card or writes `tasks.json`, and
Hermes chat moves stay in memory. There, `/api/tasks` and `/api/worker-updates`
answer 404.

**Tasks** (`/tasks`, in the navigation) lists each worker's
role, state, launching chat and overdue status. It shows why a launch wasn't
linked, why an update is held, and when repeated delivery failures leave an
update not delivered. Open the launching chat to follow up, or use Refresh
tasks to fetch the latest ledger state. `GET /api/tasks` uses the same sign-in
and browser protections as the other app APIs and returns only these status
fields. It is unavailable when the task relay is off in the server config.

## Turning it on

1. **Enable the listener** in `/etc/signalbox/config.json` and restart
   Wayroost. On its first start with the bridge on, Wayroost creates the
   bridge token in its state directory:

   ```json
   "bridge": { "enabled": true }
   ```

   ```bash
   sudo systemctl restart signalbox
   ```

   The port defaults to 19012; see [configuration.md](configuration.md#fields).

2. **Register it with your agents.** `install.sh` puts the agents' side in
   `/opt/signalbox/bin/signalbox-bridge.mjs`. Then, for the user your agents run
   as, preview the changes and apply them:

   ```bash
   sudo /opt/src/signalbox/deploy/setup-bridge.sh you --dry-run
   sudo /opt/src/signalbox/deploy/setup-bridge.sh you
   ```

   The script works as that user, never as root, in their home. It copies the
   token to `~/.config/signalbox/bridge-token` (folder 0700, file 0600) and
   adds a `signalbox` MCP server to each agent it finds:

   | Agent | Where |
   | --- | --- |
   | Hermes | `mcp_servers.signalbox` in `~/.hermes/config.yaml`, passing `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` through |
   | pi | `mcpServers.signalbox` in `~/.pi/agent/mcp.json` |
   | OpenCode | `mcp.signalbox` in `~/.config/opencode/opencode.json` |
   | Claude Code | `claude mcp add --scope user signalbox -- node /opt/signalbox/bin/signalbox-bridge.mjs` |
   | Copilot CLI | not edited; the script prints the command to add yourself |

   Only the `signalbox` entry changes, though a JSON file is rewritten with
   2-space indents (its other settings keep their values). Each file is backed
   up first to
   `<file>.bak-signalbox-<timestamp>` and restored if the edit fails. A file
   that can't be edited safely is left alone, and the script prints the entry
   to add by hand. Paseo agents get the tools through the same files, because
   Paseo runs these agents. For any other agent that supports MCP, add a stdio
   server named `signalbox` that runs `node
   /opt/signalbox/bin/signalbox-bridge.mjs`.

   When the user has Hermes, the script also installs the Hermes plugin that
   says which Hermes chat is calling (see [Hermes chats](#hermes-chats)). It
   copies `hermes-plugin/signalbox-identity/` and the required
   `helper/wayroost_runtime.py` into `~/.hermes/plugins/signalbox-identity/`,
   failing before installation if the runtime is missing, and runs `hermes plugins enable
   signalbox-identity` as that user, since Hermes only loads plugins you
   enable. An older copy of the plugin is moved to `~/.hermes/plugins-backup/`,
   and `config.yaml` is backed up before Hermes edits it. If `hermes` isn't on
   the user's `PATH`, the script prints the command to run instead.
   `--no-hermes-plugin` skips the plugin, and Hermes chats stay unverified.

3. **Reload the agents.** In Hermes, restart the dashboard and the gateway
   (`hermes gateway restart`), so both load the plugin and start the bridge.
   Without the plugin, `/reload-mcp` in a chat or a gateway restart is enough.
   New Paseo agents pick the tools up; restart running ones. Claude Code, pi
   and OpenCode need a new session.

Re-running the script is safe. If the token changes, run it again: agents'
calls re-read the token after a refusal.

## Upgrading

`install.sh` puts the new agents' side in place, and `setup-bridge.sh` updates
the Hermes plugin. When you update Wayroost with the bridge on:

1. Pull and run `install.sh`, as in [setup.md](setup.md#updating). It installs
   the new `/opt/signalbox/bin/signalbox-bridge.mjs`.
2. Run `sudo /opt/src/signalbox/deploy/setup-bridge.sh you` again. It copies
   the new plugin and enables it.
3. Restart the Hermes dashboard and the gateway (`hermes gateway restart`).
   Other agents get the new tools in new sessions; restart running Paseo
   agents.

Keep this order. An agents' side from before `wait_for_reply` passes the
plugin's hidden argument on to Wayroost, which refuses the call with HTTP 400
(`Invalid arguments. arguments: Unrecognized key: "_signalbox_caller"`). So the
new agents' side has to be installed before any Hermes process loads the
plugin. Enabling the plugin can load it into a dashboard or gateway that's
already running, and a running Hermes keeps the copy of the agents' side it
started with, so restart both right after step 2.

## Turning it off

- **For a while:** Pause in Settings.
- **For your agents:** `sudo /opt/src/signalbox/deploy/setup-bridge.sh you
  --remove` removes the `signalbox` entries that run the bridge, deletes the
  token copy, and runs `hermes plugins remove signalbox-identity`.
- **Completely:** set `"bridge": { "enabled": false }` (or remove the section)
  and restart Wayroost. The listener is gone, and the agents' tools answer
  that Wayroost isn't answering. To make every copied token useless, also
  delete `/var/lib/private/signalbox/bridge-token`; a new one is made the next
  time the bridge is turned on.

## Logs

Every call is logged as `bridge call`, with the tool, the caller (a chat id or
"unverified"), the target and the outcome, never the message, a title or a
folder. A `wait_for_reply` logs how it ended (`reply`, `finished` or
`timed_out`), and a message handed to a wait logs `handed over`. Refused
requests are logged as `bridge request denied` with the reason, never the
token.

```bash
journalctl -u signalbox | grep bridge
```

If the listener can't start, for example because its port is taken, Wayroost
logs "the project bridge could not start; running without it" and carries on
without it.
