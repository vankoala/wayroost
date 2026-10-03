"""Tests for signalbox_skills (python3 -m unittest helper/test_signalbox_skills.py)."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import signalbox_skills as S  # noqa: E402
from wayroost_runtime import BackgroundGate


def write_skill(root: Path, name: str, body: str = "Body.", platforms: str = "", extra: dict | None = None) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    head = f"---\nname: {name}\ndescription: Use when testing {name}.\n{platforms}---\n\n"
    (d / "SKILL.md").write_text(head + body)
    for rel, text in (extra or {}).items():
        (d / rel).parent.mkdir(parents=True, exist_ok=True)
        (d / rel).write_text(text)
    return d


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.home, self.hermes, self.win = t / "home", t / "home" / ".hermes", t / "win"
        for p in (self.home / ".agents" / "skills", self.home / ".claude" / "skills", self.hermes / "skills",
                  self.home / ".codex" / "skills", self.win / ".agents" / "skills", self.win / ".claude" / "skills",
                  self.win / ".codex" / "skills"):
            p.mkdir(parents=True)
        self.shared = self.home / ".agents" / "skills"
        self.claude = self.home / ".claude" / "skills"
        self.hskills = self.hermes / "skills"
        self.codex = self.home / ".codex" / "skills"
        self.scans = []
        self.verdict = "safe"
        self.now = [1_700_000_000.0]

    def tearDown(self):
        self.tmp.cleanup()

    def service(self):
        places = S.default_places(self.home, self.hermes, self.win, None)

        def scan(path):
            self.scans.append(path.name)
            return {"verdict": self.verdict, "findings": []}

        return S.SkillsService(places, self.hermes / "signalbox-skills", self.hermes, scan=scan,
                               clock=lambda: self.now[0], background=BackgroundGate("primary"))

    def tick(self, svc, seconds=60):
        self.now[0] += seconds
        return svc.refresh(force_windows=True)


class FrontmatterTests(unittest.TestCase):
    def test_parses_inline_and_block_values(self):
        meta = S.parse_frontmatter('---\r\nname: "x"\r\ndescription: >\r\n  one\r\n  two\r\nplatforms:\r\n  - linux\r\n---\r\nbody')
        self.assertEqual(meta, {"name": "x", "description": "one two", "platforms": ["linux"]})
        self.assertEqual(S.parse_frontmatter("---\nplatforms: [linux, macos]\n---\n")["platforms"], ["linux", "macos"])
        self.assertEqual(S.parse_frontmatter("no header"), {})

    def test_hash_ignores_line_endings_and_paseo_marker(self):
        with tempfile.TemporaryDirectory() as t:
            a = write_skill(Path(t) / "a", "s", "one\ntwo\n", extra={".paseo-managed-files.json": "1"})
            b = write_skill(Path(t) / "b", "s", "one\ntwo\n", extra={".paseo-managed-files.json": "2"})
            (b / "SKILL.md").write_bytes((b / "SKILL.md").read_bytes().replace(b"\n", b"\r\n"))
            self.assertEqual(S.content_hash(a), S.content_hash(b))
            (b / "notes.md").write_text("x")
            self.assertNotEqual(S.content_hash(a), S.content_hash(b))


class SyncTests(Base):
    def test_first_run_copies_to_mirrors_and_respects_platforms(self):
        write_skill(self.shared, "anywhere")
        write_skill(self.shared, "wsl-only", platforms="platforms: [linux]\n")
        svc = self.service()
        svc.refresh(force_windows=True)
        self.assertTrue((self.claude / "anywhere" / "SKILL.md").exists())
        self.assertTrue((self.claude / "wsl-only" / "SKILL.md").exists())
        self.assertTrue((self.win / ".claude" / "skills" / "anywhere").exists())
        self.assertFalse((self.win / ".claude" / "skills" / "wsl-only").exists())
        self.assertTrue((self.win / ".agents" / "skills" / "anywhere").exists())
        # Twin folders only get skills they already have.
        self.assertFalse((self.codex / "anywhere").exists())
        listing = svc.listing()
        row = next(s for s in listing["skills"] if s["name"] == "wsl-only")
        self.assertEqual(row["apps"]["win-claude"], "other-platform")
        self.assertEqual(row["apps"]["hermes"], "yes")
        self.assertEqual(row["apps"]["claude"], "yes")

    def test_shared_edits_spread_and_old_copies_are_backed_up(self):
        write_skill(self.shared, "s", "v1")
        write_skill(self.codex, "s", "old codex copy")
        write_skill(self.hskills / "category", "s", "old hermes copy")
        svc = self.service()
        svc.refresh(force_windows=True)
        self.assertIn("v1", (self.codex / "s" / "SKILL.md").read_text())
        self.assertIn("v1", (self.hskills / "category" / "s" / "SKILL.md").read_text())
        backups = list((self.hermes / "signalbox-skills" / "backups").rglob("SKILL.md"))
        self.assertEqual(len(backups), 2)
        write_skill(self.shared, "s", "v2")
        self.assertTrue(self.tick(svc))
        for p in (self.claude / "s", self.codex / "s", self.hskills / "category" / "s", self.win / ".agents" / "skills" / "s"):
            self.assertIn("v2", (p / "SKILL.md").read_text(), p)
        kinds = {(e["kind"], e.get("place")) for e in svc.listing()["events"]}
        self.assertIn(("changed", "shared"), kinds)
        self.assertIn(("synced", "codex"), kinds)

    def test_a_copy_edited_in_an_app_is_left_alone_and_flagged(self):
        write_skill(self.shared, "s", "v1")
        svc = self.service()
        svc.refresh(force_windows=True)
        write_skill(self.claude, "s", "my claude edit")
        self.tick(svc)
        write_skill(self.shared, "s", "v2")
        self.tick(svc)
        self.assertIn("my claude edit", (self.claude / "s" / "SKILL.md").read_text())
        row = next(s for s in svc.listing()["skills"] if s["name"] == "s")
        self.assertEqual(row["places"]["claude"]["state"], "edited")
        self.assertEqual(row["apps"]["claude"], "edited")
        # Put the shared version back.
        svc.take_shared("claude", "s")
        self.assertIn("v2", (self.claude / "s" / "SKILL.md").read_text())

    def test_use_an_apps_version_everywhere(self):
        write_skill(self.shared, "s", "v1")
        svc = self.service()
        svc.refresh(force_windows=True)
        write_skill(self.claude, "s", "better")
        self.tick(svc)
        result = svc.share("claude", "s")
        self.assertTrue(result["shared"])
        self.assertEqual(self.scans, ["s"])
        for p in (self.shared / "s", self.win / ".claude" / "skills" / "s"):
            self.assertIn("better", (p / "SKILL.md").read_text())

    def test_share_a_hermes_skill_needs_a_clean_scan(self):
        write_skill(self.hskills / "research", "made-by-hermes", "content")
        svc = self.service()
        svc.refresh(force_windows=True)
        row = next(s for s in svc.listing()["skills"] if s["name"] == "made-by-hermes")
        self.assertEqual(row["origin"], "hermes-made")
        self.assertEqual(row["apps"]["claude"], "missing")
        self.verdict = "dangerous"
        with self.assertRaises(S.SkillsError):
            svc.share("hermes", "made-by-hermes")
        self.verdict = "caution"
        self.assertFalse(svc.share("hermes", "made-by-hermes")["shared"])
        self.assertFalse((self.shared / "made-by-hermes").exists())
        self.assertTrue(svc.share("hermes", "made-by-hermes", confirm_caution=True)["shared"])
        self.assertTrue((self.claude / "made-by-hermes" / "SKILL.md").exists())
        row = next(s for s in svc.listing()["skills"] if s["name"] == "made-by-hermes")
        self.assertEqual(row["origin"], "shared")
        self.assertEqual(row["places"]["hermes"]["state"], "same")

    def test_switching_off_removes_only_our_copy(self):
        write_skill(self.shared, "s")
        svc = self.service()
        svc.refresh(force_windows=True)
        svc.set_excluded("s", "win-claude", True)
        self.assertFalse((self.win / ".claude" / "skills" / "s").exists())
        self.assertTrue((self.claude / "s").exists())
        row = next(r for r in svc.listing()["skills"] if r["name"] == "s")
        self.assertEqual(row["apps"]["win-claude"], "off")
        svc.set_excluded("s", "win-claude", False)
        self.assertTrue((self.win / ".claude" / "skills" / "s").exists())
        with self.assertRaises(S.SkillsError):
            svc.set_excluded("s", "hermes", True)

    def test_removing_a_shared_skill_takes_back_unchanged_copies(self):
        write_skill(self.shared, "s")
        write_skill(self.shared, "keep")
        svc = self.service()
        svc.refresh(force_windows=True)
        write_skill(self.win / ".claude" / "skills", "s", "edited on windows")
        self.tick(svc)
        svc.remove_shared("s")
        self.assertFalse((self.shared / "s").exists())
        self.assertFalse((self.claude / "s").exists())
        self.assertTrue((self.win / ".claude" / "skills" / "s").exists())   # edited: left alone
        self.assertTrue((self.claude / "keep").exists())
        self.assertTrue(list((self.hermes / "signalbox-skills" / "backups").rglob("s/SKILL.md")))

    def test_symlinks_and_claude_account_skills_are_never_written(self):
        target = write_skill(Path(self.tmp.name) / "elsewhere", "linked", "v1")
        os.symlink(target, self.claude / "linked")
        write_skill(self.shared, "linked", "different")
        write_skill(self.claude / "synced" / "bucket", "docs", "account skill")
        write_skill(self.shared, "docs", "shared docs")
        svc = self.service()
        svc.refresh(force_windows=True)
        self.assertIn("v1", (target / "SKILL.md").read_text())
        self.assertIn("account skill", (self.claude / "synced" / "bucket" / "docs" / "SKILL.md").read_text())
        self.assertTrue((self.claude / "docs" / "SKILL.md").exists())   # the shared one goes beside it
        row = next(r for r in svc.listing()["skills"] if r["name"] == "linked")
        self.assertEqual(row["places"]["claude"]["state"], "linked")

    def test_copies_where_modes_and_times_cant_be_set(self):
        # The Windows drive lets the helper write files but not chmod or utime them.
        write_skill(self.shared, "s", extra={"run.sh": "echo hi"})
        real = S.shutil.copymode
        def refuse(*a, **k):
            raise PermissionError(1, "Operation not permitted")
        S.shutil.copymode = refuse
        try:
            self.service().refresh(force_windows=True)
        finally:
            S.shutil.copymode = real
        self.assertTrue((self.win / ".claude" / "skills" / "s" / "run.sh").exists())

    def test_a_failed_copy_is_reported_once_and_not_retried_at_once(self):
        write_skill(self.shared, "s")
        svc = self.service()
        calls = []
        real = svc._copy_tree
        def broken(src, dst):
            calls.append(dst)
            if "win" in str(dst):
                (dst).mkdir(parents=True, exist_ok=True)
                raise PermissionError(1, "Operation not permitted")
            return real(src, dst)
        svc._copy_tree = broken
        svc.refresh(force_windows=True)
        for _ in range(3):
            self.tick(svc, 5)
        failures = [e for e in svc.listing()["events"] if e["kind"] == "failed"]
        self.assertEqual(len(failures), 2)                     # win-agents and win-claude, once each
        self.assertIn("Operation not permitted", failures[0]["detail"])
        self.assertEqual(sum("win" in str(c) for c in calls), 2)
        self.assertFalse([p for p in (self.win / ".claude" / "skills").iterdir() if S.TMP_MARK in p.name])
        svc._copy_tree = real
        self.tick(svc, 601)                                     # tried again after 10 minutes
        self.assertTrue((self.win / ".claude" / "skills" / "s" / "SKILL.md").exists())

    def test_bad_names_are_refused(self):
        svc = self.service()
        for name in ("../x", "", ".hidden", "a/b"):
            with self.assertRaises(S.SkillsError):
                svc.content("shared", name)

    def test_quiet_refresh_reports_no_change(self):
        write_skill(self.shared, "s")
        svc = self.service()
        svc.refresh(force_windows=True)
        v = svc.version
        self.assertFalse(self.tick(svc))
        self.assertEqual(svc.version, v)


if __name__ == "__main__":
    unittest.main()
