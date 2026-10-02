# Skills

One view of every coding agent's skills on your PC, kept the same everywhere,
plus a marketplace. A skill is a folder with a `SKILL.md` that tells an agent
how to do something; Hermes, pi, Claude Code, Codex and OpenCode each read
skills from their own folders. Settings → **Skills** shows them all and keeps
them in step. It needs the Signalbox helper (below).

## Using it

- **Skills.** Every skill, with where it is: "In all 8 apps", "In 6 of 8 apps ·
  Linux only, so not on Windows", "Only in Hermes". Open one to see each app's
  copy, view its `SKILL.md`, and switch it off for an app that gets a copy.
  Filters: **Shared**, **In one app**, **Needs a look**, and one app at a time.
- **Shared skills reach every app.** The shared folder (`~/.agents/skills`) is
  the source. pi, OpenCode, Codex and Hermes read it directly; Signalbox copies
  it, within seconds, to the apps that don't (Claude Code, and on Windows the
  `.agents` and `.claude` folders), and refreshes any copy an app keeps under
  the same name (Hermes' own copy wins over the shared one, so a stale one
  matters).
- **Share with every app.** A skill only one app has (for example one Hermes
  wrote itself) can be shared after a security scan.
- **Changed inside one app.** If someone edits an app's copy of a shared skill,
  nothing spreads by itself: the skill shows under **Needs a look**, with
  **Use everywhere** (after a scan) or **Put shared back**.
- **What's new.** Skills added, changed, removed or copied, and where.
- **Marketplace.** Searches Hermes' skills hub (skills.sh, GitHub, ClawHub,
  LobeHub and the official catalog). Preview a skill, see its security scan,
  and install it: Hermes installs it, then it's shared with every app.
- **Remove from every app** takes a skill out of the shared folder and the
  copies made from it.

Hermes' always-on parts (messaging, scheduled jobs) keep their list of skill
names in memory: a new or removed skill reaches them after their next restart.
Edits to a skill reach them at once, because skills are read from disk when used.

## Safety rules

Skills are instructions your agents follow, so:

- **Scans.** Sharing or installing runs Hermes' skills-guard scanner. "Dangerous"
  (or the hub's block policy) is refused; anything else that isn't "safe" asks
  you a second time and shows the findings.
- **Only the shared folder spreads by itself.** An app's edited copy waits for
  your decision.
- **Nothing is lost.** A copy is overwritten or removed only if it still matches
  what Signalbox last wrote there; anything else is backed up first, under
  `~/.hermes/signalbox-skills/backups/`.
- **Links are left alone.** A skill folder that is a symlink is read, never written.
- **Platforms.** Windows folders skip skills marked `platforms: [linux]`.
- **Account skills.** Skills your claude.ai account syncs into
  `~/.claude/skills/synced` are listed but never written.

## How it works

The Signalbox service can't see your home folder, so the helper
(`signalbox-helper`, running as the Hermes user on 127.0.0.1) does the work:
`helper/signalbox_skills.py` watches the skill folders (every 5 seconds, the
Windows ones every 30), copies, and keeps its state in
`~/.hermes/signalbox-skills/state.json`. Signalbox polls the helper's change
counter and tells open pages (`skills_changed`). The marketplace goes through
the Hermes dashboard's `/api/skills/hub/*` routes.

On the Windows drive (WSL `drvfs`) the helper can create files but not set
their mode or times, so it copies contents only; a copy that fails is reported
once and tried again after 10 minutes or when the skill changes.

## Setup

Skills come with the helper:

```sh
sudo deploy/setup-helper.sh <user>
```

On WSL, to keep the Windows skill folders too:

```sh
sudo SIGNALBOX_WINDOWS_HOME=/mnt/c/Users/<name> deploy/setup-helper.sh <user>
```

That adds `signalbox-helper.service.d/30-skills-windows.conf`, which lets the
helper write to the Windows `.agents`, `.claude`, `.codex` and Hermes skill
folders. `--remove` undoes it.
