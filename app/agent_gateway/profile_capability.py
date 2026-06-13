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
    # The hermes CLI is installed (editable) into the WebUI's own venv, so the
    # working binary is the sibling of HERMES_WEBUI_PYTHON — not a venv under
    # the agent dir (which may not exist). Check it before falling back to a
    # bare ``hermes`` that won't be on the server process PATH.
    webui_python = os.getenv("HERMES_WEBUI_PYTHON", "").strip()
    if webui_python:
        candidates.append(Path(webui_python).parent / "hermes")
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

# Match the CLI's job-id output, e.g. "Created job: 06eccc49e1a7", "job_id: x",
# or "#x". The earlier pattern missed the "Created job:" form, so the whole
# first output line ("Created job: <id>") leaked into runtime_job_id.
_JOB_ID_RE = re.compile(
    r"(?:created\s+job|job[_\s-]?id|#)[:=\s]+([A-Za-z0-9_-]{4,})", re.I
)


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


# Skill-market slugs come from SkillHub (the 国内镜像), whose skills carry
# ``"source": "clawhub"`` — they share ClawHub's slug namespace. Prefixing the
# identifier with ``clawhub/`` routes Hermes straight to its ClawHubSource
# adapter and skips the short-name fuzzy-search path (which resolves bare names
# against skills.sh/GitHub and would miss these slugs).
def skills_install_to_profile(profile_name: str, skill_code: str) -> tuple[bool, str]:
    """Install a market skill into one employee profile's own skills dir.

    Overrides ``HERMES_HOME`` to the profile dir so Hermes' skills runtime
    lands files at ``<profile>/skills/<skill_code>/`` (SKILL.md + assets),
    isolated per employee. This is the real landing point per the design:
    skills live in the Hermes profile, not behind an MCP shim.

    Returns ``(ok, detail)``; never raises — callers keep the Team Panel
    business record authoritative and log sync failures honestly.
    """
    code = str(skill_code or "").strip()
    if not code or code.startswith(".") or code.startswith("/"):
        return False, f"invalid skill_code: {skill_code!r}"
    profile_dir = _hermes_home() / "profiles" / (profile_name or "default")
    if not profile_dir.is_dir():
        return False, f"profile dir not found: {profile_dir}"

    identifier = code if "/" in code else f"clawhub/{code}"
    env = dict(os.environ)
    env["HERMES_HOME"] = str(profile_dir)
    cmd = [_hermes_bin(), "skills", "install", identifier, "--yes"]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180, env=env)
    except subprocess.TimeoutExpired:
        return False, f"skills install timed out for {code} in {profile_name}"
    except OSError as exc:
        return False, f"hermes CLI unavailable: {exc}"
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        return False, (err or out or f"rc={proc.returncode}")[:500]
    # A zero exit with no "Installed:" line means either the skill was already
    # present (idempotent success) or the source couldn't fetch it (failure).
    low = out.lower()
    if "installed:" in low or "already installed" in low:
        return True, out
    return False, (out or "install produced no result")[:500]


def skills_uninstall(skill_code: str) -> tuple[bool, str]:
    return _run_cli(["skills", "uninstall", skill_code])


def skills_list_installed() -> tuple[bool, str]:
    return _run_cli(["skills", "list"])


# AI-Team-managed skill dirs carry this marker so sync never deletes Hermes'
# bundled skills — only dirs it created itself.
_SKILL_MARKER = ".aiteam_managed"


def sync_employee_skills(profile_name: str, skills: list) -> tuple[bool, str]:
    """Down-provision an employee's granted skills into its own profile.

    Per design §6.7 "绑定/授权归 Team Panel；实际下发至 profile, 按 enabled 过滤".
    Writes each enabled skill as ``{profile}/skills/{code}/SKILL.md`` (isolated
    per profile), and removes previously-managed skills no longer granted. Only
    touches dirs bearing ``_SKILL_MARKER`` so Hermes' bundled skills are safe.
    One-way idempotent projection, mirroring ``sync_employee_memory``.

    ``skills``: list of objects/dicts with skill_code, display_name, description,
    enabled.
    """
    profile_dir = _hermes_home() / "profiles" / (profile_name or "default")
    if not profile_dir.is_dir():
        return False, f"profile dir missing: {profile_dir}"
    skills_dir = profile_dir / "skills"
    try:
        skills_dir.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return False, f"skills dir create failed: {exc}"

    def _attr(item, key, default=""):
        if isinstance(item, dict):
            return item.get(key, default)
        return getattr(item, key, default)

    wanted = {}
    for item in skills or []:
        if not _attr(item, "enabled", True):
            continue
        code = str(_attr(item, "skill_code", "") or "").strip()
        if not code or "/" in code or code.startswith("."):
            continue
        wanted[code] = item

    # Remove managed skills no longer granted.
    removed = 0
    for child in skills_dir.iterdir() if skills_dir.is_dir() else []:
        if not child.is_dir() or not (child / _SKILL_MARKER).is_file():
            continue
        if child.name not in wanted:
            try:
                for f in child.iterdir():
                    f.unlink()
                child.rmdir()
                removed += 1
            except OSError:
                pass

    written = 0
    for code, item in wanted.items():
        name = str(_attr(item, "display_name", "") or code)
        desc = str(_attr(item, "description", "") or f"{name} skill").replace('"', "'")
        skill_dir = skills_dir / code
        try:
            skill_dir.mkdir(parents=True, exist_ok=True)
            (skill_dir / _SKILL_MARKER).write_text("", encoding="utf-8")
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {code}\ndescription: \"{desc}\"\nversion: 1.0.0\n"
                f"metadata:\n  hermes:\n    tags: []\n---\n\n"
                f"# {name}\n\n{desc}\n\n"
                "<!-- managed by AI Team — projected from employee skill bindings -->\n",
                encoding="utf-8")
            written += 1
        except OSError:
            continue
    return True, f"skills synced: {written} written, {removed} removed"



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
