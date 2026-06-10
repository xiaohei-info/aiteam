"""Profile capability write-through — Loop/memory/skills/MCP onto Hermes.

Per 业务解决方案设计 §5.2 (D/E/F/G): AI Team owns the business objects and
management views; Hermes owns the actual capability runtimes. This module is
the single write-through seam from Team Panel business writes onto the Hermes
capability surfaces, via the Hermes CLI:

- Loop / ScheduledJob   → ``hermes cron create|pause|resume|remove``
- Memory items          → built-in memory file (profile MEMORY.md)
- Skill installs        → ``hermes skills install|uninstall|list``
- Connectors (MCP)      → ``hermes mcp add|remove|test``

All calls run against the shared HERMES_HOME (or a profile home via
``--profile`` where the CLI supports it). Failures are returned, never
raised — business writes stay authoritative in Team Panel; runtime sync
status is recorded honestly.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from pathlib import Path

logger = logging.getLogger(__name__)

_CLI_TIMEOUT = int(os.getenv("AITEAM_CAPABILITY_CLI_TIMEOUT", "60"))


def _hermes_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()


def _hermes_bin() -> str:
    agent_dir = os.getenv("HERMES_WEBUI_AGENT_DIR", "").strip()
    candidates = []
    if agent_dir:
        candidates.append(Path(agent_dir) / "venv" / "bin" / "hermes")
    candidates.append(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes")
    for c in candidates:
        if c.is_file():
            return str(c)
    return "hermes"


def _run_cli(args: list[str], timeout: int = _CLI_TIMEOUT) -> tuple[bool, str]:
    cmd = [_hermes_bin(), *args]
    env = dict(os.environ)
    env.setdefault("HERMES_HOME", str(_hermes_home()))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        return False, f"hermes {' '.join(args[:2])} timed out (>{timeout}s)"
    except OSError as exc:
        return False, f"hermes CLI unavailable: {exc}"
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        return False, (err or out or f"rc={proc.returncode}")[:500]
    return True, out


# ── Loop / cron (§5.2-F) ──────────────────────────────────────────────────

_JOB_ID_RE = re.compile(r"\b(?:job[_\s-]?id[:=\s]+|#)([A-Za-z0-9_-]{4,})", re.I)


def cron_create(*, schedule_expr: str, goal: str, name: str,
                profile: str = "") -> tuple[bool, str]:
    """Create a real Hermes cron job. Returns (ok, runtime_job_id_or_error)."""
    args = ["cron", "create", schedule_expr, goal or name, "--name", name]
    if profile and profile != "default":
        args += ["--profile", profile]
    ok, out = _run_cli(args)
    if not ok:
        return False, out
    m = _JOB_ID_RE.search(out)
    return True, (m.group(1) if m else out.splitlines()[0][:80] if out else name)


def cron_pause(runtime_job_id: str) -> tuple[bool, str]:
    return _run_cli(["cron", "pause", runtime_job_id])


def cron_resume(runtime_job_id: str) -> tuple[bool, str]:
    return _run_cli(["cron", "resume", runtime_job_id])


def cron_remove(runtime_job_id: str) -> tuple[bool, str]:
    return _run_cli(["cron", "remove", runtime_job_id])


# ── Memory write-through (§5.2-E) ─────────────────────────────────────────

_CATEGORY_LABEL = {
    "preference": "偏好", "habit": "习惯", "decision": "决策", "event": "事实",
}


def sync_employee_memory(profile_name: str, items: list) -> tuple[bool, str]:
    """Project Team Panel memory items into the profile's built-in MEMORY.md.

    One-way idempotent projection (regenerate-on-change): Hermes' built-in
    memory (MEMORY.md) is always active per ``hermes memory``, so the agent
    actually recalls these entries on its next turn.
    """
    profile_dir = _hermes_home() / "profiles" / (profile_name or "default")
    if not profile_dir.is_dir():
        return False, f"profile dir missing: {profile_dir}"
    lines = ["# MEMORY", "",
             "<!-- managed by AI Team — projected from Team Panel memory items -->",
             ""]
    for item in sorted(items, key=lambda i: (-int(getattr(i, "importance", 3) or 3),
                                             getattr(i, "created_at", ""))):
        label = _CATEGORY_LABEL.get(getattr(item, "category", ""), "记录")
        content = str(getattr(item, "content", "") or "").strip()
        if not content:
            continue
        tags = ""
        try:
            tag_list = json.loads(getattr(item, "tags_json", "[]") or "[]")
            if tag_list:
                tags = " (" + ", ".join(str(t) for t in tag_list[:5]) + ")"
        except (TypeError, json.JSONDecodeError):
            pass
        lines.append(f"- [{label}] {content}{tags}")
    try:
        (profile_dir / "MEMORY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError as exc:
        return False, f"MEMORY.md write failed: {exc}"
    return True, str(profile_dir / "MEMORY.md")


# ── Skills (§5.2-G) ───────────────────────────────────────────────────────

def skills_install(skill_code: str) -> tuple[bool, str]:
    """Install a skill from the real registries (skills.sh/ClawHub/...)."""
    return _run_cli(["skills", "install", skill_code], timeout=180)


def skills_uninstall(skill_code: str) -> tuple[bool, str]:
    return _run_cli(["skills", "uninstall", skill_code])


def skills_list_installed() -> tuple[bool, str]:
    return _run_cli(["skills", "list"])


# ── Connectors / MCP (§5.2 工具中心) ──────────────────────────────────────

def mcp_add(name: str, *, url: str = "", command: str = "",
            args: list[str] | None = None,
            env_vars: dict | None = None) -> tuple[bool, str]:
    cli = ["mcp", "add", name]
    if url:
        cli += ["--url", url]
    elif command:
        cli += ["--command", command]
        if args:
            cli += ["--args", *[str(a) for a in args]]
    else:
        return False, "connector needs url or command"
    if env_vars:
        cli += ["--env", *[f"{k}={v}" for k, v in env_vars.items()]]
    return _run_cli(cli)


def mcp_remove(name: str) -> tuple[bool, str]:
    return _run_cli(["mcp", "remove", name])


def mcp_test(name: str) -> tuple[bool, str]:
    """Real MCP connection probe via ``hermes mcp test``."""
    return _run_cli(["mcp", "test", name], timeout=90)
