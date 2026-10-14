"""Compatibility name for the same Wayroost caller mapping. Enable only one name."""
from pathlib import Path
_source = Path(__file__).resolve().parent.parent / "wayroost-identity" / "__init__.py"
_legacy_identity_entry = True
_identity_settings_file = _source.with_name("wayroost-bridge.json")
exec(compile(_source.read_text(encoding="utf-8"), str(_source), "exec"), globals())
