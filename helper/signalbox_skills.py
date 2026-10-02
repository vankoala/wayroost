"""Settings → Skills: one view of every agent's skills, kept the same everywhere.

The shared folder (~/.agents/skills) is the source. pi, OpenCode, Codex and both
Hermes installs read it directly; this module copies it to the folders that
don't (Claude Code, and on Windows Claude Code and the .agents folder Codex
reads), and refreshes the copies an app keeps of a shared skill under the same
name (Hermes' own copy wins over the shared one, so a stale copy there matters).

Rules that keep it safe:
* Only the shared folder spreads by itself. A copy edited inside one app is
  reported as a change there, and spreads only when someone taps
  "Use this version everywhere" (after a security scan).
* A copy is only overwritten or removed when it still matches what this module
  last wrote there. Anything else is backed up first.
* Folder entries that are symlinks are read, never written.
* Windows folders skip skills marked for other platforms (platforms: [linux]).

Standard library only. Logs skill names and folder ids, never skill content.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path

SKILL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
IGNORED = {"__pycache__", ".DS_Store", ".git"}
MAX_SKILL_BYTES = 50 * 1024 * 1024
MAX_EVENTS = 200
POLL_SECONDS = 5
WINDOWS_POLL_SECONDS = 30
TMP_MARK = ".signalbox-tmp-"
# Copied, but not compared: Paseo's installer records the exact bytes it wrote (so CRLF and LF
# copies of the same text disagree there only).
UNHASHED = {".paseo-managed-files.json"}


class SkillsError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Place:
    id: str
    label: str
    path: Path
    # "source": the shared folder. "mirror": gets every shared skill.
    # "twins": only refreshes shared skills it already has a copy of.
    # "readonly": listed, never written.
    mode: str
    windows: bool = False
    depth: int = 1      # how deep skills sit (Hermes keeps them in category folders)


@dataclass(frozen=True)
class App:
    id: str
    label: str
    reads: tuple        # place ids, first wins on a name clash
    note: str = ""


def _env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip()
    return Path(value) if value else None


def default_places(home: Path, hermes_home: Path, win_home: Path | None, win_hermes: Path | None) -> list:
    places = [
        Place("shared", "Shared folder", home / ".agents" / "skills", "source"),
        Place("claude", "Claude Code", home / ".claude" / "skills", "mirror"),
        # Skills from the claude.ai account, which the Claude desktop app keeps in sync itself.
        Place("claude-account", "Claude account", home / ".claude" / "skills" / "synced", "readonly", depth=2),
        Place("hermes", "Hermes", hermes_home / "skills", "twins", depth=3),
        Place("codex", "Codex", home / ".codex" / "skills", "twins"),
        Place("pi", "pi", home / ".pi" / "agent" / "skills", "twins"),
        Place("opencode", "OpenCode", home / ".config" / "opencode" / "skills", "twins"),
    ]
    if win_home:
        places += [
            Place("win-agents", "Windows .agents", win_home / ".agents" / "skills", "mirror", windows=True),
            Place("win-claude", "Windows Claude Code", win_home / ".claude" / "skills", "mirror", windows=True),
            Place("win-codex", "Windows Codex", win_home / ".codex" / "skills", "twins", windows=True),
        ]
    if win_hermes:
        places.append(Place("win-hermes", "Windows Hermes app", win_hermes / "skills", "twins", windows=True, depth=3))
    return places


APPS = [
    App("hermes", "Hermes", ("hermes", "shared"), "Also Hermes in Paseo, Conduit and WhatsApp."),
    App("pi", "pi", ("pi", "shared"), "Also pi in Paseo."),
    App("claude", "Claude Code", ("claude", "claude-account"), "Also the Claude desktop app's Code tab."),
    App("codex", "Codex", ("codex", "shared")),
    App("opencode", "OpenCode", ("opencode", "shared")),
    App("win-hermes", "Hermes (Windows app)", ("win-hermes", "shared")),
    App("win-claude", "Claude Code (Windows)", ("win-claude",)),
    App("win-codex", "Codex (Windows)", ("win-codex", "win-agents")),
]


# ---- reading skills -------------------------------------------------------------

def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


def parse_frontmatter(text: str) -> dict:
    """name, description and platforms from a SKILL.md's YAML header (the subset skills use)."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        return {}
    out: dict = {}
    i = 1
    while i < len(lines) and lines[i].strip() != "---":
        line = lines[i]
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        i += 1
        if not m:
            continue
        key, value = m.group(1), m.group(2).strip()
        block: list = []
        while i < len(lines) and lines[i].strip() != "---" and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
            block.append(lines[i].strip())
            i += 1
        if key == "platforms":
            if value.startswith("["):
                out["platforms"] = [_unquote(v) for v in value.strip("[]").split(",") if v.strip()]
            else:
                out["platforms"] = [_unquote(b[1:]) for b in block if b.startswith("-")]
        elif key in ("name", "description"):
            if value in (">", "|", ">-", "|-", ">+", "|+"):
                value = " ".join(b for b in block if b)
            elif block:
                value = " ".join([value] + [b for b in block if b])
            out[key] = _unquote(value)
    return out


def _walk_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED)
        for name in sorted(filenames):
            if name in IGNORED or name.endswith(".pyc"):
                continue
            yield Path(dirpath) / name


def signature(skill_dir: Path) -> tuple:
    """Cheap change detector: every file's path, size and mtime."""
    base = skill_dir.resolve()
    sig = []
    for f in _walk_files(base):
        try:
            st = f.stat()
        except OSError:
            continue
        sig.append((str(f.relative_to(base)), st.st_size, st.st_mtime_ns))
    return tuple(sig)


def content_hash(skill_dir: Path) -> str:
    """Hash of the skill's files, with Windows line endings read as Unix ones."""
    base = skill_dir.resolve()
    h = hashlib.sha256()
    total = 0
    for f in _walk_files(base):
        if f.name in UNHASHED:
            continue
        try:
            data = f.read_bytes()
        except OSError:
            continue
        total += len(data)
        if total > MAX_SKILL_BYTES:
            raise SkillsError(413, f"{skill_dir.name} is larger than {MAX_SKILL_BYTES // 2**20} MB.")
        h.update(str(f.relative_to(base)).replace(os.sep, "/").encode())
        h.update(b"\0")
        h.update(data.replace(b"\r\n", b"\n"))
        h.update(b"\0")
    return h.hexdigest()[:20]


def find_skills(place: Place) -> dict:
    """{name: path} for every skill folder (one holding SKILL.md) under a place."""
    found: dict = {}
    root = place.path
    if not root.is_dir():
        return found

    def visit(folder: Path, depth: int, rel: str) -> None:
        try:
            entries = sorted(folder.iterdir())
        except OSError:
            return
        for entry in entries:
            name = entry.name
            if name.startswith(".") or name in IGNORED or TMP_MARK in name:
                continue
            try:
                if not entry.is_dir():
                    continue
            except OSError:
                continue
            if (entry / "SKILL.md").is_file():
                found.setdefault(name, entry)
            elif depth < place.depth:
                visit(entry, depth + 1, f"{rel}{name}/")

    visit(root, 1, "")
    return found


def platform_ok(platforms: list, windows: bool) -> bool:
    if not platforms:
        return True
    wanted = {p.lower() for p in platforms}
    return bool(wanted & ({"windows", "win32"} if windows else {"linux"}))


# ---- the service ------------------------------------------------------------------

class SkillsService:
    def __init__(self, places: list, state_dir: Path, hermes_home: Path, scan=None, clock=time.time):
        self.places = {p.id: p for p in places}
        self.state_dir = state_dir
        self.hermes_home = hermes_home
        self.state_path = state_dir / "state.json"
        self.backup_dir = state_dir / "backups"
        self.lock = threading.RLock()
        self.clock = clock
        self.scan_fn = scan or self._hermes_scan
        self.version = 0
        self.inventory: dict = {}
        self._sigs: dict = {}         # (place, name) -> (signature, hash)
        self._last_windows = 0.0
        self._fingerprint: dict = {}  # place -> {name: signature}
        self._failed: dict = {}       # (place, name) -> (shared hash, when): a failed copy waits

        self.state = self._load_state()

    # -- state --

    def _load_state(self) -> dict:
        try:
            data = json.loads(self.state_path.read_text())
            if isinstance(data, dict):
                data.setdefault("synced", {})
                data.setdefault("excluded", {})
                data.setdefault("events", [])
                data.setdefault("seen", None)
                return data
        except (OSError, ValueError):
            pass
        return {"synced": {}, "excluded": {}, "events": [], "seen": None}

    def _save_state(self) -> None:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, indent=1))
        os.replace(tmp, self.state_path)

    def _event(self, kind: str, name: str, place: str = "", detail: str = "") -> None:
        event = {"at": int(self.clock() * 1000), "kind": kind, "name": name}
        if place:
            event["place"] = place
        if detail:
            event["detail"] = detail[:300]
        self.state["events"] = ([event] + self.state["events"])[:MAX_EVENTS]

    def _synced(self, place: str, name: str) -> str | None:
        return self.state["synced"].get(place, {}).get(name)

    def _set_synced(self, place: str, name: str, digest: str | None) -> None:
        bucket = self.state["synced"].setdefault(place, {})
        if digest is None:
            bucket.pop(name, None)
        else:
            bucket[name] = digest

    # -- scanning --

    def _hash(self, place: str, name: str, path: Path) -> str:
        sig = signature(path)
        cached = self._sigs.get((place, name))
        # Timestamps are coarse: a same-size edit right after the last look can keep the
        # signature, so anything touched in the last few seconds is hashed again.
        newest = max((s[2] for s in sig), default=0) / 1e9
        if cached and cached[0] == sig and time.time() - newest > 3:
            return cached[1]
        digest = content_hash(path)
        self._sigs[(place, name)] = (sig, digest)
        return digest

    def _hermes_origins(self) -> tuple:
        bundled, hub = set(), {}
        try:
            for line in (self.hermes_home / "skills" / ".bundled_manifest").read_text().splitlines():
                if ":" in line:
                    bundled.add(line.split(":", 1)[0].strip())
        except OSError:
            pass
        try:
            installed = json.loads((self.hermes_home / "skills" / ".hub" / "lock.json").read_text()).get("installed") or {}
            for name, entry in installed.items():
                if isinstance(entry, dict):
                    hub[name] = {"identifier": str(entry.get("identifier") or ""), "path": str(entry.get("install_path") or "")}
        except (OSError, ValueError, AttributeError):
            pass
        return bundled, hub

    def _read(self, include_windows: bool) -> dict:
        """{name: {place: {path, hash, linked, meta}}} for every place (Windows when due)."""
        skills: dict = {}
        for place in self.places.values():
            if place.windows and not include_windows:
                for name, copy in self.inventory.get("_windows", {}).get(place.id, {}).items():
                    skills.setdefault(name, {})[place.id] = copy
                continue
            for name, path in find_skills(place).items():
                try:
                    digest = self._hash(place.id, name, path)
                except SkillsError as err:
                    digest = f"error:{err}"
                linked = path.is_symlink()
                try:
                    meta = parse_frontmatter((path / "SKILL.md").read_text(errors="replace")[:65536])
                except OSError:
                    meta = {}
                skills.setdefault(name, {})[place.id] = {
                    "path": str(path), "hash": digest, "linked": linked, "meta": meta,
                    "mtime": int((path / "SKILL.md").stat().st_mtime * 1000) if (path / "SKILL.md").exists() else 0,
                }
        return skills

    # -- copying --

    @staticmethod
    def _copy_tree(src: Path, dst: Path) -> None:
        """Copy a skill's files. Contents only: on the Windows drive the helper may create files
        but not set their mode or times, so those are copied only where allowed (scripts keep +x)."""
        base = src.resolve()
        dst.mkdir(parents=True, exist_ok=True)
        for f in _walk_files(base):
            out = dst / f.relative_to(base)
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, out)
            try:
                shutil.copymode(f, out)
            except OSError:
                pass

    def _backup(self, place: Place, name: str, path: Path) -> None:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(self.clock()))
        dest = self.backup_dir / stamp / place.id / name
        if not dest.exists():
            self._copy_tree(path, dest)

    def _write(self, src: Path, place: Place, name: str, existing: Path | None) -> None:
        """Copy a skill folder into a place, swapping it in whole."""
        target = existing or (place.path / name)
        if target.is_symlink():
            raise SkillsError(409, f"{place.label} links {name} somewhere else, so it is left alone.")
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.parent / f".{name}{TMP_MARK}{os.getpid()}"
        old = target.parent / f".{name}{TMP_MARK}old-{os.getpid()}"
        for leftover in (tmp, old):
            if leftover.exists():
                shutil.rmtree(leftover, ignore_errors=True)
        try:
            self._copy_tree(src, tmp)
            if target.exists():
                os.rename(target, old)
            os.rename(tmp, target)
        except OSError as err:
            shutil.rmtree(tmp, ignore_errors=True)
            if old.exists() and not target.exists():
                os.rename(old, target)
            raise SkillsError(500, f"Couldn't write to {place.label}: {err.strerror or type(err).__name__}.")
        shutil.rmtree(old, ignore_errors=True)

    def _remove(self, place: Place, path: Path) -> None:
        if path.is_symlink():
            return
        shutil.rmtree(path)

    # -- the sync pass --

    def _sync(self, skills: dict, first_run: bool) -> list:
        """Spread the shared folder. Returns (kind, name, place) for what changed."""
        done: list = []
        now = self.clock()

        def blocked(place_id: str, name: str, digest: str) -> bool:
            # A copy that failed is tried again when the skill changes, or after 10 minutes.
            failed = self._failed.get((place_id, name))
            return bool(failed and failed[0] == digest and now - failed[1] < 600)

        def failed(place_id: str, name: str, digest: str, err: Exception) -> None:
            first = (place_id, name) not in self._failed or self._failed[(place_id, name)][0] != digest
            self._failed[(place_id, name)] = (digest, now)
            if first:
                done.append(("failed", name, place_id, str(err)))
        shared_now = {n for n, copies in skills.items() if "shared" in copies}
        shared_before = set(self.state["synced"].get("shared", {}))
        for name in sorted(shared_now):
            src = skills[name]["shared"]
            if src["hash"].startswith("error:"):
                continue
            platforms = src["meta"].get("platforms") or []
            for place in self.places.values():
                if place.mode in ("source", "readonly"):
                    continue
                copy = skills[name].get(place.id)
                excluded = place.id in self.state["excluded"].get(name, [])
                wanted = place.mode == "mirror" and not excluded and platform_ok(platforms, place.windows)
                if copy is None:
                    if wanted and not blocked(place.id, name, src["hash"]):
                        try:
                            self._write(Path(src["path"]), place, name, None)
                        except (OSError, SkillsError) as err:
                            failed(place.id, name, src["hash"], err)
                            continue
                        self._failed.pop((place.id, name), None)
                        self._set_synced(place.id, name, src["hash"])
                        done.append(("copied", name, place.id, ""))
                    continue
                if copy["linked"]:
                    continue
                if (excluded or (place.mode == "mirror" and not platform_ok(platforms, place.windows))) \
                        and copy["hash"] == self._synced(place.id, name):
                    try:
                        self._remove(place, Path(copy["path"]))
                    except OSError as err:
                        done.append(("failed", name, place.id, str(err)))
                        continue
                    self._set_synced(place.id, name, None)
                    done.append(("removed", name, place.id, ""))
                    continue
                if excluded:
                    continue
                if copy["hash"] == src["hash"]:
                    self._set_synced(place.id, name, src["hash"])
                    continue
                # A copy from before this sync existed (sync-claude.sh, Paseo's installer, an older
                # install): the shared folder is the source, so it is replaced, and kept in backups.
                never_synced = self._synced(place.id, name) is None
                if (copy["hash"] == self._synced(place.id, name) or never_synced) and not blocked(place.id, name, src["hash"]):
                    try:
                        if never_synced:
                            self._backup(place, name, Path(copy["path"]))
                        self._write(Path(src["path"]), place, name, Path(copy["path"]))
                    except (OSError, SkillsError) as err:
                        failed(place.id, name, src["hash"], err)
                        continue
                    self._failed.pop((place.id, name), None)
                    self._set_synced(place.id, name, src["hash"])
                    done.append(("updated", name, place.id, ""))
            self._set_synced("shared", name, src["hash"])
        # Shared skills that were deleted: take back the copies made from them (unchanged ones only).
        for name in sorted(shared_before - shared_now):
            for place in self.places.values():
                if place.mode != "mirror":
                    continue
                copy = skills.get(name, {}).get(place.id)
                if copy and not copy["linked"] and copy["hash"] == self._synced(place.id, name):
                    try:
                        self._remove(place, Path(copy["path"]))
                        done.append(("removed", name, place.id, ""))
                    except OSError as err:
                        done.append(("failed", name, place.id, str(err)))
                        continue
                self._set_synced(place.id, name, None)
            self._set_synced("shared", name, None)
        return done

    def _changes(self, before: dict, after: dict) -> None:
        """Events for skills that appeared, changed or went away since the last look."""
        for name in sorted(set(before) | set(after)):
            old, new = before.get(name, {}), after.get(name, {})
            for place in sorted(set(old) | set(new)):
                if place not in self.places:
                    continue
                if place not in old:
                    self._event("added", name, place)
                elif place not in new:
                    self._event("removed", name, place)
                elif old[place]["hash"] != new[place]["hash"]:
                    self._event("changed", name, place)

    def refresh(self, force_windows: bool = False) -> bool:
        """Look at every folder, spread shared changes, record what happened. True if anything moved."""
        with self.lock:
            now = self.clock()
            include_windows = force_windows or now - self._last_windows >= WINDOWS_POLL_SECONDS \
                or "_windows" not in self.inventory
            skills = self._read(include_windows)
            if include_windows:
                self._last_windows = now
            first_run = self.state.get("seen") is None
            fingerprint = {n: {p: c["hash"] for p, c in copies.items()} for n, copies in skills.items()}
            before = self.state.get("seen") or {}
            if not first_run:
                self._changes({n: {p: {"hash": h} for p, h in v.items()} for n, v in before.items()},
                              {n: {p: {"hash": h} for p, h in v.items()} for n, v in fingerprint.items()})
            done = self._sync(skills, first_run)
            for kind, name, place, detail in done:
                self._event({"copied": "synced", "updated": "synced"}.get(kind, kind), name, place, detail)
            if done:
                skills = self._read(True)
                fingerprint = {n: {p: c["hash"] for p, c in copies.items()} for n, copies in skills.items()}
            changed = fingerprint != before or bool(done)
            self.state["seen"] = fingerprint
            windows = {p.id: {} for p in self.places.values() if p.windows}
            for name, copies in skills.items():
                for pid, copy in copies.items():
                    if pid in windows:
                        windows[pid][name] = copy
            self.inventory = {"skills": skills, "_windows": windows, "at": int(now * 1000)}
            if changed or first_run:
                self.version += 1
                self._save_state()
            return changed

    # -- what the page shows --

    def listing(self) -> dict:
        with self.lock:
            if not self.inventory:
                self.refresh(force_windows=True)
            bundled, hub = self._hermes_origins()
            skills = self.inventory["skills"]
            out = []
            for name in sorted(skills, key=str.lower):
                copies = skills[name]
                shared = copies.get("shared")
                lead = shared or next(iter(copies.values()))
                meta = lead["meta"]
                platforms = meta.get("platforms") or []
                if shared:
                    origin = "shared"
                elif "hermes" in copies:
                    origin = "hermes-hub" if name in hub else "hermes-bundled" if name in bundled else "hermes-made"
                elif "claude-account" in copies:
                    origin = "claude-account"
                else:
                    origin = "app"
                places = {}
                for pid, copy in copies.items():
                    if pid == "shared":
                        state = "source"
                    elif self.places[pid].mode == "readonly":
                        state = "own"
                    elif copy["linked"]:
                        state = "linked"
                    elif not shared:
                        state = "own"
                    elif copy["hash"] == shared["hash"]:
                        state = "same"
                    elif copy["hash"] == self._synced(pid, name):
                        state = "behind"      # ours, about to be refreshed
                    else:
                        state = "edited"      # changed in that app: needs a decision
                    places[pid] = {"state": state, "updatedAt": copy["mtime"]}
                apps = {}
                for app in APPS:
                    readable = [p for p in app.reads if p in self.places]
                    if not readable:
                        continue
                    winner = next((p for p in readable if p in copies), None)
                    if winner is None:
                        place_ids = [p for p in readable if self.places[p].mode == "mirror"]
                        if shared and place_ids and any(p in self.state["excluded"].get(name, []) for p in place_ids):
                            apps[app.id] = "off"
                        elif shared and not platform_ok(platforms, self.places[readable[0]].windows):
                            apps[app.id] = "other-platform"
                        else:
                            apps[app.id] = "missing"
                        continue
                    st = places[winner]["state"]
                    apps[app.id] = {"source": "yes", "same": "yes", "linked": "yes", "own": "yes",
                                    "behind": "updating", "edited": "edited"}[st]
                entry = {
                    "name": name,
                    "description": (meta.get("description") or "")[:600],
                    "platforms": platforms,
                    "origin": origin,
                    "places": places,
                    "apps": apps,
                    "excluded": self.state["excluded"].get(name, []),
                    "updatedAt": max(c["mtime"] for c in copies.values()),
                }
                if name in hub:
                    entry["hub"] = hub[name]["identifier"]
                out.append(entry)
            return {
                "version": self.version,
                "checkedAt": self.inventory["at"],
                "skills": out,
                "places": [{"id": p.id, "label": p.label, "mode": p.mode, "windows": p.windows,
                            "exists": p.path.is_dir()} for p in self.places.values()],
                "apps": [{"id": a.id, "label": a.label, "reads": [p for p in a.reads if p in self.places], "note": a.note}
                         for a in APPS if any(p in self.places for p in a.reads)],
                "events": self.state["events"][:100],
            }

    def content(self, place_id: str, name: str) -> dict:
        place, path = self._locate(place_id, name)
        text = (path / "SKILL.md").read_text(errors="replace")
        return {"name": name, "place": place.id, "text": text[:200_000], "truncated": len(text) > 200_000}

    def _locate(self, place_id: str, name: str) -> tuple:
        if not SKILL_NAME.match(name or ""):
            raise SkillsError(400, "That isn't a skill name.")
        place = self.places.get(place_id)
        if not place:
            raise SkillsError(400, "Unknown folder.")
        path = find_skills(place).get(name)
        if not path:
            raise SkillsError(404, f"{place.label} has no skill called {name}.")
        return place, path

    # -- actions --

    def _hermes_scan(self, path: Path) -> dict:
        """Hermes' skills-guard verdict on a folder (the same scanner hub installs use)."""
        candidates = sorted(
            (self.hermes_home / "installs").glob("*/environments/*/venv/bin/python"),
            key=lambda p: p.stat().st_mtime, reverse=True,
        )
        code = (
            "import json,sys\nfrom pathlib import Path\nfrom tools.skills_guard import scan_skill\n"
            "r=scan_skill(Path(sys.argv[1]),source='community')\n"
            "print(json.dumps({'verdict':r.verdict,'findings':[{'severity':f.severity,'category':f.category,"
            "'file':f.file,'line':f.line,'description':f.description} for f in r.findings][:30]}))\n"
        )
        env = {k: v for k, v in os.environ.items() if k in {"PATH", "LANG", "LC_ALL", "HOME", "USER", "TZ"}}
        env["HERMES_HOME"] = str(self.hermes_home)
        env["PYTHONPATH"] = str(self.hermes_home / "hermes-agent")
        for python in candidates:
            try:
                out = subprocess.run([str(python), "-c", code, str(path)], capture_output=True, text=True,
                                     timeout=120, env=env, cwd=str(self.hermes_home / "hermes-agent"))
            except subprocess.TimeoutExpired:
                raise SkillsError(504, "The security scan took too long.")
            if out.returncode == 0:
                try:
                    return json.loads(out.stdout.strip().splitlines()[-1])
                except (ValueError, IndexError):
                    pass
        raise SkillsError(503, "Hermes' security scanner isn't available, so nothing was shared.")

    def scan(self, place_id: str, name: str) -> dict:
        _, path = self._locate(place_id, name)
        return self.scan_fn(path)

    def share(self, place_id: str, name: str, confirm_caution: bool = False) -> dict:
        """Make one app's copy the shared version (then it spreads to every app)."""
        with self.lock:
            place, path = self._locate(place_id, name)
            if place.mode == "source":
                raise SkillsError(400, f"{name} is already shared.")
            result = self.scan_fn(path)
            verdict = result.get("verdict")
            if verdict == "dangerous":
                raise SkillsError(422, f"The security scan flagged {name} as dangerous, so it wasn't shared.")
            if verdict != "safe" and not confirm_caution:
                return {"shared": False, "scan": result}
            shared = self.places["shared"]
            existing = find_skills(shared).get(name)
            if existing is not None:
                if existing.is_symlink():
                    raise SkillsError(409, f"The shared {name} is a link to somewhere else, so it was left alone.")
                self._backup(shared, name, existing)
            self._write(path, shared, name, existing)
            digest = content_hash(path)
            # The app copy now matches the shared one, so later shared edits refresh it.
            self._set_synced(place.id, name, digest)
            self._event("shared", name, place.id)
            self._save_state()
        self.refresh(force_windows=True)
        return {"shared": True, "scan": result}

    def take_shared(self, place_id: str, name: str) -> dict:
        """Put the shared version back over an app's edited copy (the edited copy is backed up)."""
        with self.lock:
            place, path = self._locate(place_id, name)
            if place.mode == "source":
                raise SkillsError(400, "That is the shared copy.")
            src = find_skills(self.places["shared"]).get(name)
            if not src:
                raise SkillsError(404, f"There is no shared {name}.")
            self._backup(place, name, path)
            self._write(src, place, name, path)
            self._set_synced(place.id, name, content_hash(src))
            self._event("reverted", name, place.id)
            self._save_state()
        self.refresh(force_windows=place.windows)
        return {"ok": True}

    def set_excluded(self, name: str, place_id: str, excluded: bool) -> dict:
        with self.lock:
            place = self.places.get(place_id)
            if not place or place.mode != "mirror":
                raise SkillsError(400, "Only folders that get copies can be switched off.")
            if not find_skills(self.places["shared"]).get(name):
                raise SkillsError(404, f"There is no shared {name}.")
            current = set(self.state["excluded"].get(name, []))
            current = current | {place_id} if excluded else current - {place_id}
            if current:
                self.state["excluded"][name] = sorted(current)
            else:
                self.state["excluded"].pop(name, None)
            self._save_state()
        self.refresh(force_windows=place.windows)
        return {"ok": True}

    def remove_shared(self, name: str) -> dict:
        """Take a skill out of the shared folder (backed up); unchanged copies made from it go too."""
        with self.lock:
            shared = self.places["shared"]
            path = find_skills(shared).get(name) if SKILL_NAME.match(name or "") else None
            if not path:
                raise SkillsError(404, f"There is no shared {name}.")
            if path.is_symlink():
                raise SkillsError(409, f"The shared {name} is a link, so it was left alone.")
            self._backup(shared, name, path)
            shutil.rmtree(path)
            self._event("removed", name, "shared", "Removed from the shared folder in Signalbox.")
            self._save_state()
        self.refresh(force_windows=True)
        return {"ok": True}

    # -- the watcher --

    def watch(self, on_error) -> None:
        def loop():
            while True:
                try:
                    self.refresh()
                except Exception as err:  # keep watching; report the type only
                    on_error(type(err).__name__)
                time.sleep(POLL_SECONDS)
        threading.Thread(target=loop, name="skills-watch", daemon=True).start()


def from_env(hermes_home: Path) -> SkillsService:
    home = _env_path("SIGNALBOX_SKILLS_HOME") or Path.home()
    win_home = _env_path("SIGNALBOX_SKILLS_WINDOWS_HOME")
    win_hermes = _env_path("SIGNALBOX_SKILLS_WINDOWS_HERMES") or (win_home / "AppData" / "Local" / "hermes" if win_home else None)
    if win_home and not win_home.is_dir():
        win_home = None
    if win_hermes and not win_hermes.is_dir():
        win_hermes = None
    places = default_places(home, hermes_home, win_home, win_hermes)
    return SkillsService(places, hermes_home / "signalbox-skills", hermes_home)
