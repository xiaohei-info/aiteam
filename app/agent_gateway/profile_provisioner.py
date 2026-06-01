"""Profile provisioner — ensures every active employee has a Hermes profile."""

import subprocess
from pathlib import Path


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
        "hermes", "profile", "create", profile_name,
        "--home", str(profile_home),
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
