"""Profile provisioner — ensures every active employee has a Hermes profile."""

import os
import subprocess
from pathlib import Path


def _build_hermes_cli(profile_home: str | Path) -> list[str]:
    """Return the Hermes CLI command honoring the configured app env.

    Preference order (app/.env contract, CLAUDE.md §3.2):
    1. {HERMES_WEBUI_AGENT_DIR}/venv/bin/hermes — the runtime's own CLI
    2. ~/.hermes/hermes-agent/venv/bin/hermes
    3. plain `hermes` on PATH as a compatibility fallback
    """
    agent_dir = (os.getenv("HERMES_WEBUI_AGENT_DIR") or "").strip()
    candidates = []
    if agent_dir:
        candidates.append(Path(agent_dir) / "venv" / "bin" / "hermes")
    candidates.append(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes")
    for c in candidates:
        if c.is_file():
            return [str(c)]
    return ["hermes"]


def ensure_profile(
    profile_name: str,
    profile_home: str | Path,
    employee_id: str = "",
    template_config: dict | None = None,
) -> bool:
    """Ensure a Hermes profile exists for this employee.

    Idempotent — returns False if profile directory already exists,
    True if created.
    """
    profile_dir = Path(profile_home) / "profiles" / profile_name
    if profile_dir.exists():
        return False
    cmd = [
        *_build_hermes_cli(profile_home),
        "profile",
        "create",
        profile_name,
        "--home",
        str(profile_home),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Profile create failed: {result.stderr}")
    return True


def resolve_profile_path(hermes_home: str | Path, profile_name: str) -> Path:
    """Resolve the profile directory path."""
    return Path(hermes_home) / "profiles" / profile_name


def profile_exists(hermes_home: str | Path, profile_name: str) -> bool:
    """Check whether a profile directory exists."""
    return resolve_profile_path(hermes_home, profile_name).exists()
