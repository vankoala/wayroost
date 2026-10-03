#!/usr/bin/env bash
# Register the Signalbox project bridge with the agents <user> runs, so an
# agent can list, read, message and start the other chats in its project:
# Hermes, pi, Claude Code and OpenCode each get the stdio MCP server
#   node /opt/signalbox/bin/signalbox-bridge.mjs
# and <user> gets a copy of the bridge token in ~/.config/signalbox/. Hermes
# also gets the signalbox-identity plugin, so its chats are identified. Run as
# root after enabling the bridge in /etc/signalbox/config.json
# ("bridge": {"enabled": true}), restarting Signalbox and running install.sh:
#
#   sudo deploy/setup-bridge.sh <user>            # set up (safe to re-run)
#   sudo deploy/setup-bridge.sh <user> --dry-run  # only show what would change
#   sudo deploy/setup-bridge.sh <user> --no-hermes-plugin  # skip the plugin
#   sudo deploy/setup-bridge.sh <user> --remove   # undo it
#
# Everything in the user's home is done as that user (runuser), never as root,
# so a symlink there can't redirect a root write. Each file is backed up to
# <file>.bak-signalbox-<timestamp> first and restored if the edit fails. Only
# the "signalbox" entry changes; a file that can't be edited safely is left
# alone and the snippet to add by hand is printed instead.
set -euo pipefail

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$REPO/deploy/lib.sh"
ETC=/etc/signalbox
TOKEN_SRC=/var/lib/private/signalbox/bridge-token
WRAPPER=/opt/signalbox/bin/signalbox-bridge.mjs
DEFAULT_PORT=19012

usage() {
  echo "Usage: $0 <user> [--dry-run] [--remove] [--no-hermes-plugin]" >&2
  exit 1
}

TARGET="" DRY_RUN=0 REMOVE=0 PLUGIN=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --remove) REMOVE=1 ;;
    --no-hermes-plugin) PLUGIN=0 ;;
    -*) usage ;;
    *) [[ -z "$TARGET" ]] || usage; TARGET="$arg" ;;
  esac
done
[[ -n "$TARGET" ]] || usage

# The helper below runs as the user. It gets values only through argv and
# stdin, never by pasting them into its source. Commands:
#   edit <hermes|pi|opencode> <add|remove> <file> <wrapper> <bridge url or ""> <stamp> <dry 0|1>
#   token <install|remove> <file> <stamp> <dry 0|1>     (install reads the token on stdin)
#   plugin <source dir> <plugin dir> <stamp> <dry 0|1>  (copy the Hermes plugin in)
#   plugin-state <config.yaml> <name>                   (prints on, off or unknown)
#   backup <file> <stamp>                               (before running a Hermes command that edits it)
#   claude-hook <add|remove> <settings.json> <command> <stamp> <dry 0|1>  (Signalbox's Claude Code launch hook)
# Exit status: 0 changed (or would), 3 nothing to do, 4 left for the user (snippet printed), 1 failed.
IFS= read -r -d '' HELPER <<'PY' || true
import copy, difflib, json, os, re, shutil, sys, tempfile

os.umask(0o077)
CHANGED, NOTHING, MANUAL = 0, 3, 4
OPENCODE_SCHEMA = "https://opencode.ai/config.json"
TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{32,512}")


def say(line=""):
    print(f"    {line}" if line else "")


def manual(reason, snippet):
    say(f"Not changed: {reason}.")
    say("Add this yourself:" if snippet else "Remove the signalbox entry yourself.")
    for line in snippet.rstrip("\n").split("\n") if snippet else []:
        say(f"  {line}")
    sys.exit(MANUAL)


def read_text(path):
    with open(path, encoding="utf-8", newline="") as f:
        return f.read()


def write_text(path, text, stamp, new_mode=0o600):
    """Back up, replace atomically keeping owner and mode, read back; restore the backup on any failure."""
    real = os.path.realpath(path)
    st = os.stat(real) if os.path.exists(real) else None
    if st is not None and st.st_uid != os.getuid():
        raise SystemExit(f"{path} belongs to another user; fix its owner or edit it yourself.")
    backup = None
    if st is not None:
        backup = f"{real}.bak-signalbox-{stamp}"
        shutil.copy2(real, backup)
    try:
        if text is None:
            os.unlink(real)
        else:
            os.makedirs(os.path.dirname(real), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(real), prefix=f".{os.path.basename(real)}.")
            try:
                with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
                    f.write(text)
                    f.flush()
                    os.fsync(f.fileno())
                os.chmod(tmp, (st.st_mode & 0o7777) if st else new_mode)
                if st:
                    try:
                        os.chown(tmp, st.st_uid, st.st_gid)
                    except PermissionError:
                        pass
                os.replace(tmp, real)
            except BaseException:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise
            if read_text(real) != text:
                raise RuntimeError(f"{path} didn't read back as written")
    except BaseException as err:
        if backup:
            shutil.copy2(backup, real)
            say(f"Failed ({err}); restored {path} from {backup}.")
        raise
    return backup


def show_diff(old, new, path):
    for line in difflib.unified_diff(old.split("\n"), new.split("\n"), path, path, n=0, lineterm=""):
        say(line)


# ---- existing entries ---------------------------------------------------------------

def is_node(cmd):
    return isinstance(cmd, str) and (cmd == "node" or (cmd.startswith("/") and cmd.rsplit("/", 1)[1] == "node"))


ENV_KEY = {"hermes": "env", "pi": "env", "opencode": "environment"}


def runs_wrapper(kind, e):
    """Does this entry start our wrapper with node (any node path)?"""
    if not isinstance(e, dict):
        return False
    if kind == "opencode":
        cmd = e.get("command")
        return isinstance(cmd, list) and len(cmd) == 2 and is_node(cmd[0]) and cmd[1] == WRAPPER_PATH
    return is_node(e.get("command")) and e.get("args") == [WRAPPER_PATH]


def current(kind, have, want):
    """Set up already: runs our wrapper with the environment we need. Other keys are the user's business."""
    if not runs_wrapper(kind, have):
        return False
    env_have, env_want = have.get(ENV_KEY[kind]) or {}, want.get(ENV_KEY[kind]) or {}
    if not isinstance(env_have, dict) or any(env_have.get(k) != v for k, v in env_want.items()):
        return False
    return "SIGNALBOX_BRIDGE_URL" in env_want or "SIGNALBOX_BRIDGE_URL" not in env_have


def merged(kind, have, want):
    """Our settings over an existing entry, keeping the user's other keys, their node path and their choices."""
    if not isinstance(have, dict):
        return want
    key = ENV_KEY[kind]
    out = dict(have)
    for k, v in want.items():
        if k not in (key, "directTools", "toolPrefix", "enabled"):
            out[k] = v
    if kind == "opencode":
        cmd = have.get("command")
        if isinstance(cmd, list) and cmd and is_node(cmd[0]):
            out["command"] = [cmd[0], WRAPPER_PATH]
    elif is_node(have.get("command")):
        out["command"] = have["command"]
    env = have.get(key) if isinstance(have.get(key), dict) else {}
    env = {k: v for k, v in env.items() if k != "SIGNALBOX_BRIDGE_URL"}
    env.update(want.get(key) or {})
    if env:
        out[key] = env
    else:
        out.pop(key, None)
    return out


# ---- Hermes: ~/.hermes/config.yaml -----------------------------------------------------

def yaml_tools():
    """(load, compose) from ruamel.yaml or PyYAML, or None."""
    try:
        from ruamel.yaml import YAML
        return (lambda t: YAML(typ="safe", pure=True).load(t)), (lambda t: YAML(typ="safe", pure=True).compose(t))
    except ImportError:
        pass
    try:
        import yaml
        return (lambda t: yaml.load(t, Loader=yaml.SafeLoader)), (lambda t: yaml.compose(t, Loader=yaml.SafeLoader))
    except ImportError:
        return None


def yaml_scalar(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    s = str(v)
    special = re.fullmatch(r"(?i)(y|n|yes|no|on|off|true|false|null|~|[-+.0-9_:eE]+)", s)
    return s if re.fullmatch(r"[A-Za-z0-9_./-]+", s) and not special else json.dumps(s)


def yaml_entry(entry, col, step):
    lines = [" " * col + "signalbox:"]
    def emit(d, depth):
        pad = " " * (col + step * depth)
        for k, v in d.items():
            if isinstance(v, dict):
                lines.append(f"{pad}{k}:")
                emit(v, depth + 1)
            elif isinstance(v, list):
                lines.append(f"{pad}{k}: [{', '.join(yaml_scalar(x) for x in v)}]")
            else:
                lines.append(f"{pad}{k}: {yaml_scalar(v)}")
    emit(entry, 1)
    return lines


def indent(line):
    return len(line) - len(line.lstrip(" "))


def last_line_within(lines, start, end, col):
    """Index of the last non-blank line in lines[start:end] indented deeper than col, or None."""
    found = None
    for i in range(start, end):
        if lines[i].strip() and indent(lines[i]) > col:
            found = i
    return found


def hermes(mode, path, entry, stamp, dry):
    snippet = "\n".join(["mcp_servers:"] + yaml_entry(entry, 2, 2)) + "\n"
    if not os.path.exists(path):
        say(f"{path} doesn't exist; skipped.")
        return NOTHING
    text = read_text(path)
    tools = yaml_tools()
    if tools is None:
        manual("python3 has no YAML library to check the edit with (install python3-yaml)", snippet)
    if "\r" in text or text.startswith("\ufeff") or re.search("[\x0b\x0c\x85\u2028\u2029]", text):
        manual("the file has line endings or characters this script doesn't edit", snippet)
    load, compose = tools
    try:
        old, root = load(text), compose(text)
    except Exception as err:
        manual(f"it doesn't parse as YAML ({type(err).__name__})", snippet)
    old = {} if old is None else old
    if not isinstance(old, dict) or (root is not None and (root.id != "mapping" or root.flow_style)):
        manual("its top level isn't a plain YAML mapping", snippet)
    servers = old.get("mcp_servers")
    lines = text.split("\n")
    pairs = root.value if root is not None else []
    names = [k.value if k.id == "scalar" else None for k, _ in pairs]
    if names.count("mcp_servers") > 1:
        manual("mcp_servers appears twice", snippet)
    expected = copy.deepcopy(old)

    def block_of(key):  # (key node, value node, first line after the block)
        i = names.index(key)
        k, v = pairs[i]
        end = pairs[i + 1][0].start_mark.line if i + 1 < len(pairs) else len(lines)
        return k, v, end

    def our_lines(v, end):  # (first, last) line of mcp_servers.signalbox, and its key node
        children = [ck.value if ck.id == "scalar" else None for ck, _ in v.value]
        i = children.index("signalbox")
        sk, sv = v.value[i]
        stop = v.value[i + 1][0].start_mark.line if i + 1 < len(v.value) else end
        last = last_line_within(lines, sk.start_mark.line + 1, stop, sk.start_mark.column)
        return sk.start_mark.line, sk.start_mark.line if last is None else last, sk, sv

    def plain_block(k, v):
        if k.start_mark.column != 0 or v.id != "mapping" or v.flow_style:
            manual("mcp_servers isn't a plain block mapping", snippet if mode == "add" else None)

    have = servers.get("signalbox") if isinstance(servers, dict) else None
    # The edit: lines[a:b] become block.
    if mode == "add":
        if current("hermes", have, entry):
            say(f"{path}: mcp_servers.signalbox is already set up.")
            return NOTHING
        if "mcp_servers" not in old:
            block = snippet.rstrip("\n").split("\n")
            a = b = len(lines) - 1 if text.endswith("\n") else len(lines)
            if text == "":
                a = b = 0
            expected["mcp_servers"] = {"signalbox": entry}
        elif isinstance(servers, dict) and servers:
            k, v, end = block_of("mcp_servers")
            plain_block(k, v)
            cols = {ck.start_mark.column for ck, _ in v.value}
            if len(cols) != 1:
                manual("mcp_servers isn't laid out one server per line", snippet)
            col = cols.pop()
            steps = [cv.value[0][0].start_mark.column - col for _, cv in v.value if cv.id == "mapping" and not cv.flow_style and cv.value]
            step = steps[0] if steps and steps[0] > 0 else 2
            if have is None:
                at = last_line_within(lines, k.start_mark.line + 1, end, 0)
                if at is None:
                    manual("mcp_servers isn't laid out one server per line", snippet)
                a = b = at + 1
                new_entry = entry
            else:
                # Ours but out of date (another port, say): rewrite just that entry, keeping the user's extra keys.
                first, last, _, _ = our_lines(v, end)
                a, b = first, last + 1
                new_entry = merged("hermes", have, entry)
            block = yaml_entry(new_entry, col, step)
            expected["mcp_servers"]["signalbox"] = new_entry
        else:
            manual("mcp_servers is empty or isn't a plain list of servers", snippet)
    else:
        if not (isinstance(servers, dict) and "signalbox" in servers):
            say(f"{path}: no signalbox entry.")
            return NOTHING
        if not runs_wrapper("hermes", have):
            say(f"{path}: mcp_servers.signalbox doesn't run {WRAPPER_PATH}; left alone.")
            return NOTHING
        k, v, end = block_of("mcp_servers")
        plain_block(k, v)
        first, last, _, _ = our_lines(v, end)
        del expected["mcp_servers"]["signalbox"]
        if not expected["mcp_servers"]:
            rest = last_line_within(lines, k.start_mark.line + 1, end, 0)
            if lines[k.start_mark.line].rstrip() == "mcp_servers:" and rest == last and k.start_mark.line == first - 1:
                first = k.start_mark.line  # the block was only ours: take the key too
                del expected["mcp_servers"]
            else:
                expected["mcp_servers"] = None
        a, b, block = first, last + 1, []

    new = "\n".join(lines[:a] + block + lines[b:])
    # Check the result: the same data apart from our entry (only lines[a:b] changed, by construction).
    try:
        ok = load(new) == expected
    except Exception:
        ok = False
    if not ok:
        manual("a safe edit couldn't be verified", snippet if mode == "add" else None)
    return commit(path, text, new, stamp, dry)


# ---- pi and OpenCode: JSON --------------------------------------------------------------

def json_config(kind, mode, path, entry, stamp, dry):
    key = "mcp" if kind == "opencode" else "mcpServers"
    exists = os.path.exists(path)
    if not exists and mode == "remove":
        say(f"{path} doesn't exist; nothing to remove.")
        return NOTHING
    text = read_text(path) if exists else ""
    try:
        data = json.loads(text) if text.strip() else ({"$schema": OPENCODE_SCHEMA} if kind == "opencode" else {})
    except ValueError:
        data = None
    snippet = json.dumps({key: {"signalbox": entry}}, indent=2)
    if not isinstance(data, dict):
        manual("it isn't a plain JSON object (comments?)", snippet if mode == "add" else None)
    if kind == "pi" and key not in data and isinstance(data.get("mcp-servers"), dict):
        key = "mcp-servers"  # the older spelling pi also reads
    servers = data.get(key)
    if servers is not None and not isinstance(servers, dict):
        manual(f"{key} isn't an object", snippet if mode == "add" else None)
    new_data = copy.deepcopy(data)
    if mode == "add":
        have = (servers or {}).get("signalbox")
        if current(kind, have, entry):
            say(f"{path}: {key}.signalbox is already set up.")
            return NOTHING
        entry = entry if have is None else merged(kind, have, entry)
        new_data.setdefault(key, {})["signalbox"] = entry
    else:
        if not servers or "signalbox" not in servers:
            say(f"{path}: no signalbox entry.")
            return NOTHING
        if not runs_wrapper(kind, servers["signalbox"]):
            say(f"{path}: {key}.signalbox doesn't run {WRAPPER_PATH}; left alone.")
            return NOTHING
        del new_data[key]["signalbox"]
        if not new_data[key]:
            del new_data[key]
    canonical = lambda d: json.dumps(d, indent=2, ensure_ascii=False) + "\n"
    if mode == "remove" and new_data in ({}, {"$schema": OPENCODE_SCHEMA}):
        new = None  # only our entry was left: remove the file
    else:
        new = canonical(new_data)
    # Show only our entry: other values in these files can be secrets.
    say(f"{path}: {'add' if mode == 'add' else 'remove'} {key}.signalbox" + (f" = {json.dumps(entry)}" if mode == "add" else ""))
    if exists and text and canonical(data) != text and new is not None:
        say("(the file is rewritten as 2-space JSON; its other settings keep their values)")
    if new is None:
        say("(nothing else is left in it, so the file is removed)")
    return commit(path, text if exists else None, new, stamp, dry, diff=False)


def commit(path, old, new, stamp, dry, diff=True):
    if diff and old is not None and new is not None:
        show_diff(old, new, path)
    if dry:
        say("(dry run: nothing written)")
        return CHANGED
    backup = write_text(path, new, stamp)
    say(f"{'Updated' if new is not None else 'Removed'} {path}" + (f" (backup: {backup})" if backup else " (new file)"))
    return CHANGED


def entry_for(kind, wrapper, url):
    if kind == "hermes":
        # Hermes gives stdio servers a clean environment and fills in ${VAR} when it connects.
        env = {"PASEO_AGENT_ID": "${PASEO_AGENT_ID}", "PASEO_AGENT_CWD": "${PASEO_AGENT_CWD}"}
        if url:
            env["SIGNALBOX_BRIDGE_URL"] = url
        return {"command": "node", "args": [wrapper], "env": env}
    if kind == "pi":
        # directTools puts the bridge's tools in pi's own tool list (as signalbox_list_chats and so on).
        return {"command": "node", "args": [wrapper], **({"env": {"SIGNALBOX_BRIDGE_URL": url}} if url else {}),
                "directTools": True, "toolPrefix": "server"}
    return {"type": "local", "command": ["node", wrapper], "enabled": True,
            **({"environment": {"SIGNALBOX_BRIDGE_URL": url}} if url else {})}


def token(mode, path, stamp, dry):
    exists = os.path.exists(path)
    if mode == "remove":
        if not exists:
            say(f"{path} isn't there.")
            return NOTHING
        if not dry:
            os.unlink(path)
            try:
                os.rmdir(os.path.dirname(path))
            except OSError:
                pass
        say(f"{'Would remove' if dry else 'Removed'} {path}.")
        return CHANGED
    value = sys.stdin.read().strip()
    if not TOKEN_RE.fullmatch(value):
        raise SystemExit("The bridge token Wayroost wrote doesn't look right; restart Wayroost and try again.")
    folder = os.path.dirname(path)
    private = lambda p: (os.stat(p).st_mode & 0o077) == 0
    if exists and read_text(path).strip() == value and private(path) and private(folder):
        say(f"{path} is up to date.")
        return NOTHING
    if dry:
        say(f"Would write the bridge token to {path} (mode 0600).")
        return CHANGED
    os.makedirs(folder, mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".bridge-token.")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(value)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    say(f"Wrote the bridge token to {path} (mode 0600).")
    return CHANGED


# ---- the Hermes plugin -----------------------------------------------------------------

def files_in(root):
    found = {}
    for folder, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for name in files:
            if not name.endswith(".pyc"):
                with open(os.path.join(folder, name), "rb") as f:
                    found[os.path.relpath(os.path.join(folder, name), root)] = f.read()
    return found


def plugin(src, dest, stamp, dry):
    """Put the plugin in ~/.hermes/plugins/<name>; an older copy moves to ~/.hermes/plugins-backup."""
    runtime = os.path.join(os.path.dirname(os.path.dirname(src)), "helper", "wayroost_runtime.py")
    if not os.path.isfile(runtime):
        raise RuntimeError("wayroost_runtime.py is missing; the bridge plugin was not installed")
    wanted = files_in(src)
    if os.path.isfile(runtime):
        with open(runtime, "rb") as f:
            wanted["wayroost_runtime.py"] = f.read()
    role_config = os.path.join(os.path.dirname(os.path.dirname(src)), "deploy", "primary-role.json")
    with open(role_config, "rb") as f:
        wanted["wayroost-role.json"] = f.read()
    if os.path.isdir(dest) and not os.path.islink(dest) and files_in(dest) == wanted:
        say(f"{dest} is up to date.")
        return NOTHING
    if dry:
        say(f"Would copy the plugin to {dest}.")
        return CHANGED
    # Backups and staging live outside plugins/, so Hermes never loads them as plugins.
    backups = os.path.join(os.path.dirname(os.path.dirname(dest)), "plugins-backup")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    os.makedirs(backups, mode=0o700, exist_ok=True)
    staging = tempfile.mkdtemp(dir=backups, prefix=".signalbox-")
    backup = None
    try:
        staged = os.path.join(staging, os.path.basename(dest))
        shutil.copytree(src, staged, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        if os.path.isfile(runtime):
            shutil.copy2(runtime, os.path.join(staged, "wayroost_runtime.py"))
        shutil.copy2(role_config, os.path.join(staged, "wayroost-role.json"))
        if os.path.lexists(dest):
            backup = os.path.join(backups, f"{os.path.basename(dest)}.bak-signalbox-{stamp}")
            os.rename(dest, backup)
        try:
            os.rename(staged, dest)
        except BaseException:
            if backup:
                os.rename(backup, dest)
            raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    say(f"Copied the plugin to {dest}" + (f" (old copy: {backup})." if backup else "."))
    return CHANGED


def plugin_state(config, name):
    tools = yaml_tools()
    try:
        data = tools[0](read_text(config)) if tools else None
    except Exception:
        data = None
    if not isinstance(data, dict):
        return "unknown" if tools is None or data is not None else "off"
    plugins = data.get("plugins") if isinstance(data.get("plugins"), dict) else {}
    enabled, disabled = plugins.get("enabled"), plugins.get("disabled")
    on = isinstance(enabled, list) and name in enabled and not (isinstance(disabled, list) and name in disabled)
    return "on" if on else "off"


CLAUDE_HOOK_EVENTS = ("SessionStart", "UserPromptSubmit", "Stop", "SessionEnd")


def claude_hook(mode, path, command, stamp, dry):
    """Register (or remove) Wayroost's launch hook for the four session events in ~/.claude/settings.json."""
    exists = os.path.exists(path)
    if not exists and mode == "remove":
        say(f"{path} doesn't exist; nothing to remove.")
        return NOTHING
    text = read_text(path) if exists else ""
    try:
        data = json.loads(text) if text.strip() else {}
    except ValueError:
        data = None
    ours = {"type": "command", "command": command, "timeout": 5}
    snippet = json.dumps({"hooks": {event: [{"hooks": [ours]}] for event in CLAUDE_HOOK_EVENTS}}, indent=2)
    if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
        manual("it isn't a plain JSON object with a hooks object", snippet if mode == "add" else None)
    new_data = copy.deepcopy(data)
    hooks = new_data.setdefault("hooks", {})
    changed = []
    for event in CLAUDE_HOOK_EVENTS:
        groups = hooks.get(event, [])
        if not isinstance(groups, list):
            manual(f"hooks.{event} isn't a list", snippet if mode == "add" else None)
        has = any(isinstance(g, dict) and any(isinstance(h, dict) and h.get("command") == command for h in g.get("hooks", [])) for g in groups)
        if mode == "add" and not has:
            hooks[event] = groups + [{"hooks": [ours]}]
            changed.append(event)
        elif mode == "remove" and has:
            kept = []
            for g in groups:
                if isinstance(g, dict) and isinstance(g.get("hooks"), list):
                    g = {**g, "hooks": [h for h in g["hooks"] if not (isinstance(h, dict) and h.get("command") == command)]}
                    if not g["hooks"]:
                        continue
                kept.append(g)
            if kept:
                hooks[event] = kept
            else:
                del hooks[event]
            changed.append(event)
    if not changed:
        say(f"{path}: the Wayroost hook is {'already registered' if mode == 'add' else 'not registered'}.")
        return NOTHING
    if not hooks:
        del new_data["hooks"]
    # Show only our hook: other values in this file can be secrets.
    say(f"{path}: {'add' if mode == 'add' else 'remove'} hook {command!r} for {', '.join(changed)}")
    return commit(path, text if exists else None, json.dumps(new_data, indent=2, ensure_ascii=False) + "\n", stamp, dry, diff=False)


def backup_file(path, stamp):
    real = os.path.realpath(path)
    target = f"{real}.bak-signalbox-{stamp}"
    if os.path.exists(target):
        target += "-plugin"
    shutil.copy2(real, target)
    print(target)
    return 0


cmd = sys.argv[1]
try:
    if cmd == "token":
        sys.exit(token(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == "1"))
    if cmd == "plugin":
        sys.exit(plugin(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == "1"))
    if cmd == "plugin-state":
        print(plugin_state(sys.argv[2], sys.argv[3]))
        sys.exit(0)
    if cmd == "backup":
        sys.exit(backup_file(sys.argv[2], sys.argv[3]))
    if cmd == "claude-hook":
        sys.exit(claude_hook(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6] == "1"))
    kind, mode, path, WRAPPER_PATH, url, stamp, dry = sys.argv[2:9]
    entry = entry_for(kind, WRAPPER_PATH, url)
    if kind == "hermes":
        sys.exit(hermes(mode, path, entry, stamp, dry == "1"))
    sys.exit(json_config(kind, mode, path, entry, stamp, dry == "1"))
except (OSError, RuntimeError) as err:
    say(f"Failed: {err}")
    sys.exit(1)
PY

require_root
# This script runs code from $REPO as root.
require_root_owned_tree "$REPO"
cd /  # so nothing below picks up files from wherever this was started

if ! [[ "$TARGET" =~ ^[a-z_][a-z0-9_.-]{0,31}$ ]]; then
  echo "Invalid user name: $TARGET" >&2
  exit 1
fi
if ! ENTRY="$(getent passwd -- "$TARGET")"; then
  echo "No such user: $TARGET" >&2
  exit 1
fi
IFS=: read -r _ _ _ _ _ UHOME _ <<<"$ENTRY"
if [[ "$UHOME" != /?* || ! -d "$UHOME" ]]; then
  echo "$TARGET has no home directory." >&2
  exit 1
fi
PY3="$(command -v python3 || true)"
if [[ -z "$PY3" ]]; then echo "python3 is required." >&2; exit 1; fi

UPATH=/usr/local/bin:/usr/bin:/bin
# as_user <command> [args...]: run as the user, in a clean environment, from their home.
as_user() {
  runuser -u "$TARGET" -- env -i HOME="$UHOME" USER="$TARGET" LOGNAME="$TARGET" PATH="$UPATH" LANG=C.UTF-8 \
    sh -c 'cd "$HOME" && exec "$@"' sh "$@"
}
helper() { as_user "$PY3" -I -c "$HELPER" "$@"; }

PORT="$DEFAULT_PORT"
if (( ! REMOVE )); then
  if [[ ! -f "$ETC/config.json" ]]; then
    echo "$ETC/config.json doesn't exist. Set up Wayroost first (docs/setup.md)." >&2
    exit 1
  fi
  PORT="$(python3 -I - "$ETC/config.json" <<'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as f:
        cfg = json.load(f)
except (OSError, ValueError) as e:
    sys.exit(f"Can't read {path}: {e}")
bridge = cfg.get("bridge") if isinstance(cfg, dict) else None
if not isinstance(bridge, dict) or bridge.get("enabled") is not True:
    sys.exit(
        f"The bridge is turned off. To turn it on:\n"
        f"  1. add  \"bridge\": {{ \"enabled\": true }}  to {path}\n"
        f"     (\"port\" is optional, default 19012; it must differ from listen.port and 19011),\n"
        f"  2. sudo systemctl restart signalbox   (Wayroost then creates the bridge token),\n"
        f"  3. run this script again."
    )
port = bridge.get("port", 19012)
if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
    sys.exit(f"bridge.port in {path} must be a whole number from 1 to 65535.")
print(port)
PY
)"
  if [[ ! -f "$TOKEN_SRC" || -L "$TOKEN_SRC" ]]; then
    echo "Wayroost hasn't created the bridge token yet ($TOKEN_SRC)." >&2
    echo "Restart it with the bridge enabled (sudo systemctl restart signalbox), then run this script again." >&2
    exit 1
  fi
  if [[ ! -f "$WRAPPER" ]]; then
    echo "$WRAPPER is missing. Run sudo deploy/install.sh first." >&2
    exit 1
  fi
fi
URL=""
[[ "$PORT" == "$DEFAULT_PORT" ]] || URL="http://127.0.0.1:$PORT"
MODE=add
(( REMOVE )) && MODE=remove
STAMP="$(date +%Y%m%d-%H%M%S)"

# The user's own PATH (from their login shell) to find claude, opencode and co.
login_path="$(as_user timeout 20 bash -lc 'printf "\nSIGNALBOX_PATH=%s\n" "$PATH"' </dev/null 2>/dev/null | sed -n 's/^SIGNALBOX_PATH=//p' | tail -n 1 || true)"
UPATH="${login_path:-$UPATH}:$UHOME/.local/bin:$UHOME/.opencode/bin:$UHOME/.claude/local"
find_tool() { as_user sh -c 'command -v "$1"' sh "$1" 2>/dev/null | grep '^/' | head -n 1 || true; }
user_has() { as_user test -e "$1"; }

CHANGED=() UNCHANGED=() MANUAL=() FAILED=()
# record <label> <status>
record() {
  case "$2" in
    0) CHANGED+=("$1") ;;
    3) UNCHANGED+=("$1") ;;
    4) MANUAL+=("$1") ;;
    *) FAILED+=("$1") ;;
  esac
}
run_step() {  # run_step <label> <command...>
  local label="$1" rc=0
  shift
  "$@" || rc=$?
  record "$label" "$rc"
}

(( DRY_RUN )) && echo "Dry run: showing what would change for $TARGET; nothing is written."
echo "==> Bridge token"
if (( REMOVE )); then
  run_step "token" helper token remove "$UHOME/.config/signalbox/bridge-token" "$STAMP" "$DRY_RUN"
else
  run_step "token" helper token install "$UHOME/.config/signalbox/bridge-token" "$STAMP" "$DRY_RUN" <"$TOKEN_SRC"
fi

echo "==> Hermes"
if user_has "$UHOME/.hermes/config.yaml"; then
  run_step "Hermes (~/.hermes/config.yaml)" helper edit hermes "$MODE" "$UHOME/.hermes/config.yaml" "$WRAPPER" "$URL" "$STAMP" "$DRY_RUN"
else
  echo "    Not set up for $TARGET (no ~/.hermes/config.yaml); skipped."
fi

# The optional Hermes plugin (hermes-plugin/<name>/ in this checkout): it tells Signalbox which Hermes
# chat is calling. Installed the way Hermes installs directory plugins: files in ~/.hermes/plugins/<name>,
# then `hermes plugins enable <name>` (plugins are opt-in); --remove runs `hermes plugins remove <name>`.
PLUGIN_SRC="" PLUGIN_NAME=""
manifests=("$REPO"/hermes-plugin/*/plugin.yaml)
if [[ -f "${manifests[0]}" && ${#manifests[@]} -eq 1 ]]; then
  PLUGIN_SRC="$(dirname "${manifests[0]}")"
  PLUGIN_NAME="$(basename "$PLUGIN_SRC")"
  [[ "$PLUGIN_NAME" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || { echo "Odd Hermes plugin folder name: $PLUGIN_NAME" >&2; exit 1; }
fi
echo "==> Hermes plugin"
if (( ! PLUGIN )); then
  echo "    Skipped (--no-hermes-plugin)."
elif [[ -z "$PLUGIN_NAME" ]]; then
  echo "    This checkout has no Hermes plugin (hermes-plugin/<name>/plugin.yaml); skipped."
elif ! user_has "$UHOME/.hermes/config.yaml"; then
  echo "    Hermes isn't set up for $TARGET; skipped."
else
  HERMES="$(find_tool hermes)"
  label="Hermes plugin ($PLUGIN_NAME)"
  pdest="$UHOME/.hermes/plugins/$PLUGIN_NAME"
  # hermes_cmd <enable|remove>: run it as the user after backing up config.yaml (Hermes edits it).
  hermes_cmd() {
    echo "    hermes plugins $1 $PLUGIN_NAME"
    (( DRY_RUN )) && return 0
    local saved
    saved="$(helper backup "$UHOME/.hermes/config.yaml" "$STAMP")" || return 1
    if as_user timeout 120 "$HERMES" plugins "$1" "$PLUGIN_NAME" </dev/null >/dev/null 2>&1; then return 0; fi
    echo "    Failed; run it yourself as $TARGET (config.yaml was backed up to $saved)."
    return 1
  }
  if (( REMOVE )); then
    if ! user_has "$pdest"; then
      echo "    Not installed."
      record "$label" 3
    elif [[ -z "$HERMES" ]]; then
      echo "    hermes isn't on $TARGET's PATH; remove it with: hermes plugins remove $PLUGIN_NAME"
      record "$label" 4
    else
      rc=0; hermes_cmd remove || rc=$?
      record "$label" "$rc"
    fi
  else
    copied=0; helper plugin "$PLUGIN_SRC" "$pdest" "$STAMP" "$DRY_RUN" || copied=$?
    state="$(helper plugin-state "$UHOME/.hermes/config.yaml" "$PLUGIN_NAME" 2>/dev/null || echo unknown)"
    if (( copied == 1 )); then
      enabled=1
    elif [[ "$state" == on ]]; then
      echo "    Enabled already."
      enabled=3
    elif [[ -z "$HERMES" ]]; then
      echo "    hermes isn't on $TARGET's PATH; enable it with: hermes plugins enable $PLUGIN_NAME"
      enabled=4
    else
      enabled=0; hermes_cmd enable || enabled=$?
    fi
    if (( copied == 1 || enabled == 1 )); then record "$label" 1
    elif (( copied == 0 || enabled == 0 )); then record "$label" 0
    elif (( enabled == 4 )); then record "$label" 4
    else record "$label" 3; fi
  fi
fi

echo "==> pi"
if user_has "$UHOME/.pi/agent" || [[ -n "$(find_tool pi)" ]]; then
  run_step "pi (~/.pi/agent/mcp.json)" helper edit pi "$MODE" "$UHOME/.pi/agent/mcp.json" "$WRAPPER" "$URL" "$STAMP" "$DRY_RUN"
else
  echo "    Not installed; skipped."
fi

echo "==> OpenCode"
if user_has "$UHOME/.config/opencode" || [[ -n "$(find_tool opencode)" ]]; then
  run_step "OpenCode (~/.config/opencode/opencode.json)" \
    helper edit opencode "$MODE" "$UHOME/.config/opencode/opencode.json" "$WRAPPER" "$URL" "$STAMP" "$DRY_RUN"
else
  echo "    Not installed; skipped."
fi

echo "==> Claude Code"
CLAUDE="$(find_tool claude)"
if [[ -z "$CLAUDE" ]]; then
  echo "    Not installed; skipped."
else
  current="$(as_user timeout 60 "$CLAUDE" mcp get signalbox </dev/null 2>&1)" && have=1 || have=0
  ours=0
  if (( have )) && [[ "$current" == *"$WRAPPER"* ]]; then
    ours=1
    if [[ -n "$URL" && "$current" != *"SIGNALBOX_BRIDGE_URL=$URL"* ]] || [[ -z "$URL" && "$current" == *SIGNALBOX_BRIDGE_URL* ]]; then
      ours=2  # ours, but for another port
    fi
  fi
  add=(mcp add --scope user signalbox)
  [[ -z "$URL" ]] || add+=(-e "SIGNALBOX_BRIDGE_URL=$URL")
  add+=(-- node "$WRAPPER")
  if (( REMOVE )); then
    if (( ours )); then
      echo "    claude mcp remove --scope user signalbox"
      if (( DRY_RUN )); then record "Claude Code" 0
      elif as_user timeout 60 "$CLAUDE" mcp remove --scope user signalbox </dev/null >/dev/null 2>&1; then record "Claude Code" 0
      else echo "    Failed; run it yourself as $TARGET."; record "Claude Code" 1; fi
    else
      echo "    No signalbox server registered."
      record "Claude Code" 3
    fi
  elif (( ours == 1 )); then
    echo "    Already registered (claude mcp get signalbox)."
    record "Claude Code" 3
  elif (( have && ! ours )); then
    echo "    A different \"signalbox\" MCP server is registered; left alone. To replace it, as $TARGET:"
    echo "      claude mcp remove signalbox && claude ${add[*]}"
    record "Claude Code" 4
  else
    echo "    claude ${add[*]}"
    if (( DRY_RUN )); then
      record "Claude Code" 0
    else
      rc=0
      if (( ours == 2 )); then as_user timeout 60 "$CLAUDE" mcp remove --scope user signalbox </dev/null >/dev/null 2>&1 || rc=$?; fi
      if (( rc == 0 )) && out="$(as_user timeout 60 "$CLAUDE" "${add[@]}" </dev/null 2>&1)"; then
        record "Claude Code" 0
      else
        echo "    Failed: ${out:-claude mcp remove failed}"
        record "Claude Code" 1
      fi
    fi
  fi
fi

# Signalbox's launch hook: `claude -p` runs that agents start report themselves, so Signalbox
# nests them under the agent (the script is root-owned in /opt/signalbox/bin; see claude-hook/).
if [[ -n "$CLAUDE" ]]; then
  run_step "Claude Code hook (~/.claude/settings.json)" \
    helper claude-hook "$MODE" "$UHOME/.claude/settings.json" "/usr/bin/python3 -I /opt/signalbox/bin/signalbox-claude-hook.py" "$STAMP" "$DRY_RUN"
fi

if user_has "$UHOME/.copilot" || [[ -n "$(find_tool copilot)" ]]; then
  echo "==> Copilot CLI"
  echo "    Skipped: its MCP config format isn't verified here. Add a local server named signalbox that runs:"
  echo "      node $WRAPPER"
  MANUAL+=("Copilot CLI")
fi

echo
echo "==> Summary for $TARGET$( (( DRY_RUN )) && echo ' (dry run)')"
if (( ${#CHANGED[@]} )); then echo "    Changed: $(IFS=,; echo "${CHANGED[*]}" | sed 's/,/, /g')"; fi
if (( ${#UNCHANGED[@]} )); then echo "    Already done: $(IFS=,; echo "${UNCHANGED[*]}" | sed 's/,/, /g')"; fi
if (( ${#MANUAL[@]} )); then echo "    Left for you (see above): $(IFS=,; echo "${MANUAL[*]}" | sed 's/,/, /g')"; fi
if (( ${#FAILED[@]} )); then echo "    Failed: $(IFS=,; echo "${FAILED[*]}" | sed 's/,/, /g')"; fi
if (( ! DRY_RUN && ! REMOVE )); then
  echo
  echo "To load it:"
  echo "  - Hermes: restart the Hermes dashboard and the gateway (hermes gateway restart), so both load the plugin"
  echo "    and the new bridge. Without the plugin (--no-hermes-plugin), /reload-mcp in a chat is enough."
  echo "  - Paseo: new agents pick it up; restart running ones to give them the tools."
  echo "  - Claude Code, pi, OpenCode: start a new session (running ones keep their old tools and hooks)."
fi
(( ${#FAILED[@]} == 0 ))
