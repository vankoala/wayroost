#!/usr/bin/env python3
"""Rename selected owner registrations and references without discovering private state.

Requires python3-yaml for Hermes YAML. Receipts contain hashes and edit spans,
never copies of configuration documents or bridge credentials.
"""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile

OLD, NEW = "signalbox", "wayroost"
OLD_PLUGIN, NEW_PLUGIN = "signalbox-identity", "wayroost-identity"
STAMP = "WAYROOST_BRIDGE_NAME"
CONFIG_NAMES = {"config.yaml", "config.yml", "config.json", "mcp.json", ".mcp.json", ".claude.json",
                "opencode.json", "mcp-config.json", "settings.json", "jobs.json"}
MAP_NAMES = {"mcp_servers", "mcpServers", "mcp-servers", "mcp"}


class RegistrationError(ValueError):
    """A public diagnostic without private configuration values."""


def fail(message):
    raise RegistrationError(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("Duplicate configuration key")
        result[key] = value
    return result


def read_owned(path):
    """No symlinks in the selected path, no hardlinks, current owner only."""
    path = Path(path)
    if not path.is_absolute():
        fail("Paths must be absolute")
    for part in [*reversed(path.parents), path]:
        if part.is_symlink():
            fail("Symlink paths are refused")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid():
            fail("Selected file must be a regular, singly linked file owned by this user")
        return stream.read(), info


def pointer(parts):
    return "/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in parts)


def at(data, parts):
    for part in parts:
        data = data[part]
    return data


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def semantic_hash(data):
    return digest(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())


def parse(raw, kind):
    """Return data and token locations; offsets are Unicode character positions."""
    text = raw.decode("utf-8")
    nodes, keys = {}, {}
    is_json = kind != "hermes"
    if is_json or text.lstrip().startswith(("{", "[")):
        try:
            data = json.loads(text, object_pairs_hook=no_duplicates)
        except json.JSONDecodeError:
            if is_json:
                raise
        else:
            is_json = True
    if is_json:
        decoder = json.JSONDecoder()

        def walk(index, parts):
            index = space(index)
            start = index
            children = []
            if text[index] == "{":
                index = space(index + 1)
                while text[index] != "}":
                    key_start = index
                    key, end = decoder.raw_decode(text, index)
                    child_parts = parts + (key,)
                    keys[child_parts] = (key_start, end)
                    index = space(end)
                    if text[index] != ":":
                        fail("Invalid JSON object")
                    index = walk(index + 1, child_parts)
                    children.append(child_parts)
                    index = space(index)
                    if text[index] == "}":
                        break
                    index = space(index + 1)
                index += 1
            elif text[index] == "[":
                index = space(index + 1)
                count = 0
                while text[index] != "]":
                    child_parts = parts + (count,)
                    index = space(walk(index, child_parts))
                    children.append(child_parts)
                    count += 1
                    if text[index] == "]":
                        break
                    index = space(index + 1)
                index += 1
            else:
                _, index = decoder.raw_decode(text, index)
            nodes[parts] = {"start": start, "end": index, "children": children, "flow": True}
            return index

        def space(index):
            while index < len(text) and text[index].isspace():
                index += 1
            return index

        walk(0, ())
        return data, {"nodes": nodes, "keys": keys, "json": True, "text": text}
    import yaml
    root = yaml.compose(text)
    seen = set()

    def walk_yaml(node, parts):
        if id(node) in seen:
            fail("YAML aliases are refused")
        seen.add(id(node))
        children = []
        if node.id == "mapping":
            names = set()
            for key, value in node.value:
                if key.id != "scalar" or key.tag != "tag:yaml.org,2002:str" or key.value == "<<":
                    fail("Only plain string YAML keys are supported")
                if key.value in names:
                    fail("Duplicate configuration key")
                names.add(key.value)
                child_parts = parts + (key.value,)
                keys[child_parts] = (key.start_mark.index, key.end_mark.index)
                children.append(child_parts)
                walk_yaml(value, child_parts)
        elif node.id == "sequence":
            for index, item in enumerate(node.value):
                child_parts = parts + (index,)
                children.append(child_parts)
                walk_yaml(item, child_parts)
        nodes[parts] = {"start": node.start_mark.index, "end": node.end_mark.index,
                        "children": children, "flow": bool(getattr(node, "flow_style", False))}

    if root is not None:
        walk_yaml(root, ())
    return yaml.safe_load(text), {"nodes": nodes, "keys": keys, "json": False, "text": text}


def container_at(data, selected):
    if not isinstance(selected, str) or not selected.startswith("/"):
        fail("Each map must be an explicit JSON pointer")
    parts = tuple(part.replace("~1", "/").replace("~0", "~") for part in selected[1:].split("/"))
    if not (len(parts) == 1 and parts[0] in MAP_NAMES) and not (
        len(parts) == 4 and parts[:2] == ("agents", "providers") and parts[3] == "mcpServers"
    ):
        fail("Unsupported registration map")
    try:
        mapping = at(data, parts)
    except (KeyError, TypeError):
        fail("Selected registration map is absent")
    if not isinstance(mapping, dict):
        fail("Selected registration map must be an object")
    return mapping, parts


def is_reference(value):
    return value in (OLD, NEW) or value.startswith(("mcp__signalbox__", "mcp__wayroost__", "signalbox_", "wayroost_"))


def supported(kind, path, key, value):
    if kind == "hermes" and not key and value in (OLD, NEW):
        return len(path) == 3 and path[0] == "platform_toolsets" and isinstance(path[-1], int)
    if kind == "hermes-cron" and not key and value in (OLD, NEW):
        return len(path) >= 2 and path[-2] == "enabled_toolsets" and isinstance(path[-1], int)
    if kind in ("claude", "paseo") and not key:
        return len(path) == 3 and path[:2] in (("permissions", "allow"), ("permissions", "deny")) and (
            isinstance(path[-1], int) and value.startswith(("mcp__signalbox__", "mcp__wayroost__")))
    return kind == "opencode" and key and len(path) == 2 and path[0] in ("tools", "permission") and (
        value.startswith(("mcp__signalbox__", "mcp__wayroost__")))


def references(data, kind, excluded=(), strict=True):
    found, unknown = [], []

    def check(value, path, key=False):
        if isinstance(value, str) and is_reference(value):
            if supported(kind, path, key, value):
                found.append((path, key, value))
            elif strict:
                unknown.append(pointer(path))

    def walk(value, path):
        if path in excluded:
            return
        if isinstance(value, dict):
            for name, child in value.items():
                child_path = path + (name,)
                if child_path not in excluded:
                    check(name, child_path, True)
                    walk(child, child_path)
        elif isinstance(value, list):
            for index, child in enumerate(value):
                walk(child, path + (index,))
        else:
            check(value, path)

    walk(data, ())
    if unknown:
        fail("Unsupported reference paths: " + ", ".join(unknown))
    return found


def reference_kind(target):
    return "hermes-cron" if target["kind"] == "hermes" and Path(target["path"]).name == "jobs.json" else target["kind"]


def plugin_names(data, enabled_only=False):
    plugins = data.get("plugins", {})
    if not isinstance(plugins, dict):
        fail("Exactly one identity plugin must be selected")
    found = []
    for state in ("enabled", "disabled"):
        items = plugins.get(state, [])
        if not isinstance(items, list) or not all(isinstance(item, str) for item in items):
            fail("Hermes plugin states must be lists of names")
        found.extend((("plugins", state, index), item) for index, item in enumerate(items)
                     if item in (OLD_PLUGIN, NEW_PLUGIN))
    enabled = [item for item in found if item[0][1] == "enabled"]
    if len(enabled) > 1 or len({item for _, item in found}) != len(found) or (
        not enabled and len(found) > 1):
        fail("Identity plugin collision; exactly one identity plugin must be selected")
    return enabled if enabled_only else found


def apply_edits(raw, edits, reverse=False):
    text = raw.decode("utf-8")
    edits = sorted(edits, key=lambda edit: edit["start"])
    if reverse:
        shifted, delta = [], 0
        for edit in edits:
            shifted.append({"start": edit["start"] + delta, "before": edit["after"], "after": edit["before"]})
            delta += len(edit["after"]) - len(edit["before"])
        edits = shifted
    end = 0
    for edit in edits:
        start = edit["start"]
        if start < end or text[start:start + len(edit["before"])] != edit["before"]:
            fail("Invalid or overlapping receipt spans")
        end = start + len(edit["before"])
    for edit in reversed(edits):
        start = edit["start"]
        text = text[:start] + edit["after"] + text[start + len(edit["before"]):]
    return text.encode("utf-8")


def replace_token(loc, path, value, edits, key=False):
    node = loc["nodes"].get(path)
    start, end = loc["keys"][path] if key else (node["start"], node["end"])
    original = loc["text"][start:end]
    if not loc["json"] and original.startswith((">", "|")):
        fail("Block YAML scalar renames are unsupported at " + pointer(path))
    replacement = json.dumps(value, ensure_ascii=False) if loc["json"] or original.startswith(('"', "'")) else value
    edits.append({"start": start, "before": original, "after": replacement})


def insert_field(loc, path, name, value, edits):
    node, text = loc["nodes"][path], loc["text"]
    if node["flow"]:
        content = json.dumps(name) + ": " + json.dumps(value, ensure_ascii=False)
        prefix = ""
        if node["children"]:
            tail = text[loc["nodes"][node["children"][-1]]["end"]:node["end"] - 1]
            trailing = any("," in line.split("#", 1)[0] for line in tail.splitlines())
            prefix = " " if trailing else ", "
        edits.append({"start": node["end"] - 1, "before": "",
                      "after": prefix + content})
    else:
        first = node["children"][0]
        index = loc["keys"][first][0]
        col = index - text.rfind("\n", 0, index) - 1
        edits.append({"start": index, "before": "", "after": name + ": " + json.dumps(value) + "\n" + " " * col})


def remove_field(loc, path, edits):
    parent = loc["nodes"][path[:-1]]
    siblings = parent["children"]
    index = siblings.index(path)
    start = loc["keys"][path][0]
    end = loc["nodes"][path]["end"]
    text = loc["text"]
    if parent["flow"]:
        if index:
            separator_start, separator_end = loc["nodes"][siblings[index - 1]]["end"], start
        elif len(siblings) > 1:
            separator_start, separator_end = end, loc["keys"][siblings[1]][0]
        else:
            separator_start, separator_end = end, parent["end"] - 1
        gap = text[separator_start:separator_end]
        offset = separator_start
        for line in gap.splitlines(keepends=True):
            comma = line.split("#", 1)[0].find(",")
            if comma >= 0:
                comma_start = offset + comma
                comma_end = comma_start + 1
                if "#" not in gap and len(siblings) > 1:
                    comma_start, comma_end = separator_start, separator_end
                edits.append({"start": comma_start, "before": text[comma_start:comma_end], "after": ""})
                break
            offset += len(line)
    else:
        start = text.rfind("\n", 0, start) + 1
        leaves = [node["end"] for child_path, node in loc["nodes"].items()
                  if child_path[:len(path)] == path and not node["children"]]
        end = text.find("\n", max(leaves, default=end)) + 1
        if not end:
            end = len(text)
    edits.append({"start": start, "before": text[start:end], "after": ""})


def transform(raw, target, reverse=False, stamp=None):
    data, loc = parse(raw, target["kind"])
    if not isinstance(data, dict) and not (reference_kind(target) == "hermes-cron" and isinstance(data, list)):
        fail("Selected configuration must be an object")
    source, dest = (NEW, OLD) if reverse else (OLD, NEW)
    expected = copy.deepcopy(data)
    edits, excluded, metadata = [], [], {"stamp": None, "entryBeforeHash": None, "entryAfterHash": None}
    if "map" in target:
        mapping, parts = container_at(data, target["map"])
        if OLD in mapping and NEW in mapping:
            fail("Both bridge names are registered; resolve the collision first")
        name = source if source in mapping else dest
        if name not in mapping or not isinstance(mapping[name], dict):
            fail("Selected map has no bridge registration object")
        map_dest = target.get("nameBefore", OLD) if reverse else NEW
        metadata["nameBefore"] = name
        entry_path = parts + (name,)
        excluded.append(entry_path)
        entry = mapping[name]
        metadata["entryBeforeHash"] = semantic_hash(entry)
        wanted_entry = copy.deepcopy(entry)
        if name != map_dest:
            replace_token(loc, entry_path, map_dest, edits, key=True)
        env_key = "environment" if target["kind"] == "opencode" else "env"
        env = entry.get(env_key, {})
        if not isinstance(env, dict):
            fail("Bridge environment must be an object")
        if reverse:
            if stamp and name == source and STAMP in env:
                if stamp["createdEnv"]:
                    remove_field(loc, entry_path + (env_key,), edits)
                    wanted_entry.pop(env_key)
                elif stamp["createdStamp"]:
                    remove_field(loc, entry_path + (env_key, STAMP), edits)
                    wanted_entry[env_key].pop(STAMP)
                else:
                    replace_token(loc, entry_path + (env_key, STAMP), stamp["before"], edits)
                    wanted_entry[env_key][STAMP] = stamp["before"]
        else:
            if STAMP in env and env[STAMP] not in (OLD, NEW):
                fail("Invalid bridge name stamp")
            metadata["stamp"] = {"createdEnv": env_key not in entry, "createdStamp": STAMP not in env,
                                  "before": env.get(STAMP)}
            wanted_entry.setdefault(env_key, {})[STAMP] = NEW
            if env_key not in entry:
                insert_field(loc, entry_path, env_key, {STAMP: NEW}, edits)
            elif STAMP not in env:
                insert_field(loc, entry_path + (env_key,), STAMP, NEW, edits)
            elif env[STAMP] != NEW:
                replace_token(loc, entry_path + (env_key, STAMP), NEW, edits)
        metadata["entryAfterHash"] = semantic_hash(wanted_entry)
        expected_mapping = at(expected, parts)
        expected_mapping.pop(name)
        expected_mapping[map_dest] = wanted_entry
        if target["kind"] == "hermes":
            if parts != ("mcp_servers",):
                fail("Hermes requires /mcp_servers")
            names = plugin_names(data)
            selected = names[0][1] if names else None
            metadata["identityPlugin"] = selected if names and names[0][0][1] == "enabled" else "none"
            metadata["pluginBefore"] = selected
            metadata["pluginStateBefore"] = names[0][0][1] if names else None
            metadata["pluginNamesBefore"] = [{"path": list(path), "name": value} for path, value in names]
            wanted = target.get("pluginBefore", OLD_PLUGIN) if reverse else NEW_PLUGIN
            if selected and selected != wanted:
                for path, value in names:
                    replacement = wanted if value == selected else selected
                    replace_token(loc, path, replacement, edits)
                    at(expected, path[:-1])[path[-1]] = replacement
    refs = references(data, reference_kind(target), excluded)
    metadata["references"] = []
    metadata["canonicalReferences"] = [{"path": list(path), "key": key, "value": value}
                                       for path, key, value in refs
                                       if value == NEW or value.startswith("mcp__" + NEW + "__")]
    migrated = {(tuple(reference["path"][:-1]) + (reference["after"],) if reference["key"] else
                 tuple(reference["path"]), reference["key"]): reference
                for reference in target.get("references", [])} if reverse else {}
    for path, key, value in refs:
        if reverse:
            recorded = migrated.get((path, key))
            if recorded is None or value != recorded["after"]:
                continue
            wanted = recorded["before"]
        else:
            wanted = dest if value == source else value.replace("mcp__" + source + "__", "mcp__" + dest + "__", 1)
        if wanted != value:
            if key and wanted in at(data, path[:-1]):
                fail("Permission reference collision at " + pointer(path[:-1]))
            replace_token(loc, path, wanted, edits, key)
            parent = at(expected, path[:-1])
            if key:
                parent[wanted] = parent.pop(path[-1])
            else:
                parent[path[-1]] = wanted
            metadata["references"].append({"path": list(path), "key": key, "before": value, "after": wanted})
    result = apply_edits(raw, edits)
    parsed, _ = parse(result, target["kind"])
    if parsed != expected:
        fail("Configuration span edit did not verify expected semantics")
    list_paths = dict.fromkeys(tuple(reference["path"][:index])
                              for reference in metadata["references"] + metadata["canonicalReferences"]
                              if not reference["key"] for index, part in enumerate(reference["path"])
                              if isinstance(part, int))
    metadata["referenceLists"] = [{"path": list(path), "length": len(at(data, path)),
                                    "beforeHash": semantic_hash(at(data, path)),
                                    "afterHash": semantic_hash(at(parsed, path))} for path in list_paths]
    if "map" in target:
        changed, _ = container_at(parsed, target["map"])
        if semantic_hash(changed[map_dest]) != metadata["entryAfterHash"]:
            fail("Bridge entry span edit did not verify")
    return result, sorted(edits, key=lambda edit: edit["start"]), metadata


def atomic(path, raw, info=None):
    fd, temporary = tempfile.mkstemp(prefix=".wayroost-names-", dir=Path(path).parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(raw)
            stream.flush()
            if info is not None:
                os.fchown(stream.fileno(), info.st_uid, info.st_gid)
            os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode) if info else 0o600)
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(Path(path).parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_manifest(manifest):
    raw, _ = read_owned(manifest)
    spec = json.loads(raw, object_pairs_hook=no_duplicates)
    if not isinstance(spec, dict) or not isinstance(spec.get("targets"), list) or not spec["targets"]:
        fail("Manifest requires explicit targets")
    validate_targets(spec["targets"], manifest)
    return spec, digest(raw)


def validate_targets(targets, manifest):
    paths = set()
    for target in targets:
        if not isinstance(target, dict) or set(target) not in ({"kind", "path", "map"}, {"kind", "path"}) or (
            target["kind"] not in ("hermes", "pi", "paseo", "opencode", "claude")):
            fail("Invalid registration target")
        path = Path(target["path"])
        if path.name not in CONFIG_NAMES or ".." in path.parts or str(path) in paths:
            fail("Only distinct, selected config files are allowed")
        if str(path) == os.path.abspath(manifest):
            fail("The manifest cannot also be a selected config")
        if "map" not in target and not (
            target["kind"] == "hermes" and path.name == "jobs.json" and path.parent.name == "cron" or
            target["kind"] in ("claude", "paseo") and path.name == "settings.json"
        ):
            fail("Reference-only targets must be Hermes cron/jobs.json or Claude settings.json")
        paths.add(str(path))


def plan(manifest):
    spec, manifest_hash = load_manifest(manifest)
    files = []
    for target in spec["targets"]:
        before, info = read_owned(target["path"])
        after, edits, metadata = transform(before, target)
        files.append({**target, **metadata, "uid": info.st_uid, "gid": info.st_gid, "mode": stat.S_IMODE(info.st_mode),
                      "edits": edits, "beforeHash": digest(before), "afterHash": digest(after)})
    return {"version": 2, "manifestHash": manifest_hash, "files": files}


def inspect_reference_lists(data, file, reverse=False):
    recorded_lists = {tuple(item["path"]): item for item in file.get("referenceLists", [])}
    for reference in file["references"] + file.get("canonicalReferences", []):
        if not reference["key"]:
            for index, part in enumerate(reference["path"]):
                if isinstance(part, int):
                    path = tuple(reference["path"][:index])
                    if path not in recorded_lists:
                        fail("Receipt lacks list reference provenance at " + pointer(path))
    for path, recorded in recorded_lists.items():
        try:
            items = at(data, path)
            valid = isinstance(items, list) and len(items) >= recorded["length"] and (
                semantic_hash(items[:recorded["length"]]) == recorded["beforeHash" if reverse else "afterHash"])
        except (KeyError, TypeError, IndexError):
            valid = False
        if not valid:
            fail("List reference provenance changed at " + pointer(path))


def inspect_current(raw, file, reverse=False, check_references=True):
    data, _ = parse(raw, file["kind"])
    source, dest = (NEW, OLD) if reverse else (OLD, NEW)
    excluded = []
    if "map" in file:
        mapping, parts = container_at(data, file["map"])
        excluded.extend(parts + (name,) for name in (OLD, NEW) if name in mapping)
    refs = references(data, reference_kind(file), excluded)
    if "map" in file:
        dest = file["nameBefore"] if reverse else NEW
        source = NEW if dest == OLD else OLD
        if source in mapping or dest not in mapping:
            fail("Registration verification failed")
        if semantic_hash(mapping[dest]) != file["entryBeforeHash" if reverse else "entryAfterHash"]:
            fail("Bridge entry changed since the receipt")
        if file["kind"] == "hermes":
            names = plugin_names(data)
            if file.get("identityPlugin") == "none" and file.get("pluginBefore") is None:
                valid = not names
            else:
                valid = bool(names) and names[0][1] == (file["pluginBefore"] if reverse else NEW_PLUGIN) and (
                    names[0][0][1] == file.get("pluginStateBefore", names[0][0][1]))
            if not valid:
                fail("Identity plugin verification failed")
    if not check_references:
        return data
    inspect_reference_lists(data, file, reverse)
    if reverse:
        allowed = {(tuple(item["path"]), item["key"], item["value"])
                   for item in file.get("canonicalReferences", [])}
        unknown = [pointer(path) for path, key, value in refs
                   if (value == NEW or value.startswith("mcp__" + NEW + "__")) and (path, key, value) not in allowed]
        if unknown:
            fail("Unrecorded canonical reference paths: " + ", ".join(unknown))
    source = NEW if reverse else OLD
    if not reverse and any(value == source or value.startswith("mcp__" + source + "__") for _, _, value in refs):
        fail("Supported reference verification failed")
    for recorded in file["references"]:
        path = tuple(recorded["path"])
        wanted = recorded["before" if reverse else "after"]
        try:
            if recorded["key"]:
                valid = wanted in at(data, path[:-1])
            else:
                valid = at(data, path) == wanted
        except (KeyError, TypeError, IndexError):
            valid = False
        if not valid:
            fail("Supported reference verification failed at " + pointer(path))
    return data


def registration_maps(data):
    for name in MAP_NAMES:
        if isinstance(data.get(name), dict):
            yield (name,), data[name]
    providers = data.get("agents", {}).get("providers", {}) if isinstance(data.get("agents"), dict) else {}
    if isinstance(providers, dict):
        for name, provider in providers.items():
            if isinstance(provider, dict) and isinstance(provider.get("mcpServers"), dict):
                yield ("agents", "providers", name, "mcpServers"), provider["mcpServers"]


def plugin_mirror(spec, manifest):
    mirror = Path(spec.get("pluginMirror", ""))
    selected = {target["path"] for target in spec["targets"]}
    if not mirror.is_absolute() or mirror.name != "wayroost-bridge.json" or ".." in mirror.parts or (
        str(mirror) in selected or str(mirror) == os.path.abspath(manifest)):
        fail("An explicit wayroost-bridge.json plugin mirror is required")
    return mirror


def require_installed_plugin(spec, manifest):
    mirror = plugin_mirror(spec, manifest)
    try:
        raw, _ = read_owned(mirror.parent / "plugin.yaml")
        data, _ = parse(raw, "hermes")
        if not isinstance(data, dict) or data.get("name") != NEW_PLUGIN:
            fail("Canonical identity plugin is not installed at the plugin mirror folder")
    except (OSError, RegistrationError):
        fail("Canonical identity plugin is not installed at the plugin mirror folder")


def audit(args, cutoff=False):
    spec, _ = load_manifest(args.manifest)
    inventory = spec.get("inventory")
    if not isinstance(inventory, list) or not inventory:
        fail("Audit requires the full explicit harness inventory")
    validate_targets(inventory, args.manifest)
    selected_paths = {target["path"] for target in spec["targets"]}
    if not selected_paths.issubset({target["path"] for target in inventory}):
        fail("Inventory must include every selected document")
    old, unverified = [], []
    for target in inventory:
        raw, _ = read_owned(target["path"])
        data, _ = parse(raw, target["kind"])
        if not isinstance(data, dict) and not (reference_kind(target) == "hermes-cron" and isinstance(data, list)):
            fail("Inventory configuration must be an object")
        excluded = []
        for parts, mapping in registration_maps(data) if isinstance(data, dict) else []:
            if OLD in mapping:
                old.append(pointer(parts + (OLD,)))
            if NEW in mapping:
                excluded.append(parts + (NEW,))
                entry = mapping[NEW]
                env = entry.get("environment" if parts == ("mcp",) else "env", {}) if isinstance(entry, dict) else {}
                if not isinstance(env, dict) or env.get(STAMP) != NEW:
                    fail("Canonical registration is unstamped at " + pointer(parts + (NEW,)))
                if target["kind"] == "hermes":
                    names = plugin_names(data, enabled_only=True)
                    if not names:
                        unverified.append(pointer(parts + (NEW,)))
                    elif names[0][1] != NEW_PLUGIN:
                        fail("Canonical identity plugin must be enabled before cutoff")
                    else:
                        require_installed_plugin(spec, args.manifest)
        if old:
            fail("Legacy registrations remain at " + ", ".join(old))
        for path, _, value in references(data, reference_kind(target), excluded):
            if value == OLD or value.startswith("mcp__" + OLD + "__"):
                fail("Legacy reference remains at " + pointer(path))
    mirror = plugin_mirror(spec, args.manifest)
    if cutoff:
        if mirror.exists():
            raw, info = read_owned(mirror)
            settings = json.loads(raw, object_pairs_hook=no_duplicates)
        else:
            # Validate the parent even when creating the mirror for the first time.
            for part in [*reversed(mirror.parents), mirror]:
                if part.is_symlink():
                    fail("Symlink mirror paths are refused")
            info, settings = None, {}
        if not isinstance(settings, dict) or not isinstance(settings.get("bridge", {}), dict):
            fail("Invalid plugin mirror")
        mirror.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        settings.setdefault("bridge", {})["legacyNames"] = False
        atomic(mirror, (json.dumps(settings, indent=2) + "\n").encode(), info)
    try:
        raw, _ = read_owned(mirror)
        settings = json.loads(raw, object_pairs_hook=no_duplicates)
        if settings["bridge"]["legacyNames"] is not False:
            fail("Plugin mirror must be false before cutoff completion")
    except (OSError, KeyError, TypeError):
        fail("A verified false plugin mirror is required before cutoff completion")
    return {"step": args.command, "targets": len(inventory), "legacyNames": False, "unverifiedHermes": unverified}


def run(args):
    if args.command in ("audit", "cutoff"):
        return audit(args, cutoff=args.command == "cutoff")
    if args.command == "plan":
        receipt = plan(args.manifest)
        return {"step": "plan", "targets": len(receipt["files"]),
                "changes": sum(file["beforeHash"] != file["afterHash"] for file in receipt["files"])}
    path = Path(args.receipt)
    if not path.is_absolute() or path.is_symlink():
        fail("Receipt must be an absolute, non-symlink owner path")
    lock_path = Path(str(path) + ".lock")
    for part in [*reversed(lock_path.parents), lock_path]:
        if part.is_symlink():
            fail("Symlink receipt paths are refused")
    fd = os.open(lock_path, (os.O_CREAT if args.command == "forward" else 0) | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or info.st_nlink != 1 or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            fail("Receipt lock must be private and owned by this user")
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not path.exists():
            if args.command != "forward":
                fail("No receipt; run forward first")
            receipt = plan(args.manifest)
            spec, _ = load_manifest(args.manifest)
            if any(file["path"] in (str(path), str(lock_path)) for file in receipt["files"]):
                fail("Receipt cannot be a selected config")
            new_receipt = True
        else:
            raw, info = read_owned(path)
            if stat.S_IMODE(info.st_mode) != 0o600:
                fail("Receipt must have mode 0600")
            receipt = json.loads(raw, object_pairs_hook=no_duplicates)
            spec, manifest_hash = load_manifest(args.manifest)
            if receipt.get("version") != 2 or receipt.get("manifestHash") != manifest_hash:
                fail("Receipt does not match this manifest")
            recorded = [{key: file[key] for key in ("kind", "path", "map") if key in file} for file in receipt["files"]]
            if recorded != spec["targets"]:
                fail("Receipt targets do not match the selected manifest")
            new_receipt = False
        if args.command in ("forward", "verify") and any(
            file["kind"] == "hermes" and file.get("pluginBefore") == OLD_PLUGIN and
            file.get("pluginStateBefore") == "enabled" for file in receipt["files"]
        ):
            require_installed_plugin(spec, args.manifest)
        if new_receipt:
            atomic(path, (json.dumps(receipt) + "\n").encode())
        reverse = args.command == "reverse" or args.expect == "reverse"
        checked = []
        for file in receipt["files"]:
            raw, info = read_owned(file["path"])
            if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (file["uid"], file["gid"], file["mode"]):
                fail("Configuration owner or mode changed")
            output = raw
            if args.command == "verify":
                inspect_current(raw, file, reverse)
            elif digest(raw) == file["afterHash" if reverse else "beforeHash"]:
                output = apply_edits(raw, file["edits"], reverse)
                if digest(output) != file["beforeHash" if reverse else "afterHash"]:
                    fail("Invalid receipt content")
                inspect_current(output, file, reverse)
            else:
                try:
                    data = inspect_current(raw, file, reverse, check_references=False)
                    current_reverse = reverse
                except RegistrationError:
                    data = inspect_current(raw, file, not reverse, check_references=False)
                    current_reverse = not reverse
                try:
                    inspect_reference_lists(data, file, current_reverse)
                except RegistrationError as error:
                    try:
                        data = inspect_current(raw, file, not current_reverse, check_references=False)
                    except RegistrationError:
                        raise error
                    inspect_reference_lists(data, file, not current_reverse)
                output, _, metadata = transform(raw, file, reverse, file["stamp"])
                if not reverse:
                    for reference in metadata["references"]:
                        if reference not in file["references"]:
                            fail("Reference migration is absent from the receipt at " + pointer(reference["path"]))
                inspect_current(output, file, reverse)
            checked.append((file, raw, info, output))
        if args.command != "verify":
            for file, raw, info, output in checked:
                current, current_info = read_owned(file["path"])
                if current != raw or (current_info.st_ino, current_info.st_dev) != (info.st_ino, info.st_dev):
                    fail("Configuration changed during publication")
                if raw != output:
                    atomic(file["path"], output, info)
                written, _ = read_owned(file["path"])
                if written != output:
                    fail("Publication verification failed")
        return {"step": args.command, "targets": len(checked), "state": "reverse" if reverse else "forward"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("plan", "forward", "verify", "reverse", "audit", "cutoff"))
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--receipt")
    parser.add_argument("--expect", choices=("forward", "reverse"), default="forward")
    args = parser.parse_args()
    if args.command in ("forward", "verify", "reverse") and not args.receipt:
        parser.error("--receipt is required for forward/verify/reverse")
    if args.command != "verify" and args.expect != "forward":
        parser.error("--expect applies only to verify")
    os.umask(0o077)
    try:
        print(json.dumps(run(args)))
    except RegistrationError as error:
        parser.exit(1, f"Bridge registration step refused: {error}.\n")
    except Exception:
        parser.exit(1, "Bridge registration step refused: invalid schema, collision, ownership, or content precondition.\n")


if __name__ == "__main__":
    main()
