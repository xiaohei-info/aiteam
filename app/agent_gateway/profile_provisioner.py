"""Profile provisioner — ensures every active employee has a Hermes profile."""

import os
import shutil
import subprocess
from pathlib import Path

try:  # YAML is used only for config materialization; degrade gracefully.
    import yaml
except ImportError:  # pragma: no cover
    yaml = None


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
    # Working CLI is in the WebUI venv (sibling of HERMES_WEBUI_PYTHON); the
    # agent dir has no venv. Prefer it over a bare ``hermes`` not on PATH.
    webui_python = (os.getenv("HERMES_WEBUI_PYTHON") or "").strip()
    if webui_python:
        candidates.append(Path(webui_python).parent / "hermes")
    candidates.append(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes")
    for c in candidates:
        if c.is_file():
            return [str(c)]
    return ["hermes"]


def _root_config_path(profile_home: str | Path) -> Path:
    """Resolve the root config.yaml the profiles should inherit providers from.

    HERMES_CONFIG_PATH (app/.env contract) wins; otherwise the runtime home's
    own config.yaml.
    """
    override = (os.getenv("HERMES_CONFIG_PATH") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path(profile_home) / "config.yaml"


def _seed_profile_config(profile_dir: Path, profile_home: str | Path) -> None:
    """Make a profile inherit the root provider configuration.

    hermes_cli.config reads ``{HERMES_HOME}/config.yaml``, and when a profile
    is active HERMES_HOME becomes the profile dir — so a freshly-created profile
    has NO providers: block and every run dies with "Provider 'x' is set in
    config.yaml but no API key was found". Copying the root config.yaml into the
    profile lets provider/model/fallback resolution succeed under the profile
    while persona/memory/session state stay profile-scoped (separate files).

    Idempotent and self-healing: copies when the profile config is missing or
    differs from root, so root provider edits propagate on the next ensure.
    """
    root_cfg = _root_config_path(profile_home)
    if not root_cfg.is_file():
        return
    profile_cfg = profile_dir / "config.yaml"
    try:
        if profile_cfg.is_file() and profile_cfg.read_bytes() == root_cfg.read_bytes():
            return
        shutil.copyfile(root_cfg, profile_cfg)
    except OSError:
        # Degraded: provider resolution under this profile may fail, but the
        # caller's run path surfaces that as a normal terminal error.
        pass


def materialize_root_providers(providers: list[dict], *,
                               profile_home: str | Path | None = None) -> bool:
    """Write enterprise-configured LLM providers into the Hermes root config.yaml.

    DB is the source of truth; this is a one-way DB -> config.yaml projection.
    Each provider dict: {provider_key, base_url, api_key, transport, default_model,
    models: [{model_id, context_length}]}.

    Reconciliation, not blind merge: every entry this function writes is tagged
    ``_aiteam_managed: true``. On each call we first drop ALL previously-managed
    entries, then write the current input set. A provider deleted/disabled in the
    DB therefore disappears from config.yaml, while hand-configured runtime
    providers (no marker) are never touched. An empty input is valid — it means
    "no managed providers", so we still run to clear stale ones. Returns True on
    a successful write (or no-op when there was nothing managed to clear).
    """
    if yaml is None:
        return False
    root_cfg = _root_config_path(profile_home or _default_home())
    try:
        cfg = {}
        if root_cfg.is_file():
            cfg = yaml.safe_load(root_cfg.read_text(encoding="utf-8")) or {}
        block = cfg.get("providers")
        if not isinstance(block, dict):
            block = {}
        # Drop previously AI-Team-managed entries; keep hand-configured ones.
        had_managed = any(
            isinstance(v, dict) and v.get("_aiteam_managed") for v in block.values()
        )
        block = {
            k: v for k, v in block.items()
            if not (isinstance(v, dict) and v.get("_aiteam_managed"))
        }
        if not providers and not had_managed:
            return True  # nothing managed before, nothing to write — no-op
        for p in providers:
            key = (p.get("provider_key") or "").strip()
            if not key:
                continue
            models = {
                m["model_id"]: {"context_length": int(m.get("context_length") or 0)}
                for m in (p.get("models") or []) if m.get("model_id")
            }
            entry = {
                "api": p.get("base_url") or "",
                "name": key,
                "api_key": p.get("api_key") or "",
                "transport": p.get("transport") or "openai_chat",
                "_aiteam_managed": True,
            }
            if p.get("default_model"):
                entry["default_model"] = p["default_model"]
            if models:
                entry["models"] = models
            block[key] = entry
        cfg["providers"] = block
        root_cfg.parent.mkdir(parents=True, exist_ok=True)
        root_cfg.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                            encoding="utf-8")
        return True
    except (OSError, yaml.YAMLError):
        return False


def set_profile_model(profile_dir: str | Path, provider_key: str,
                      model_id: str) -> bool:
    """Write the default model/provider into a profile's config.yaml model block.

    Lets the employee's selected model take effect when the profile is active,
    without depending on per-run model passthrough. Preserves all other fields.
    """
    if yaml is None or not (provider_key and model_id):
        return False
    cfg_path = Path(profile_dir) / "config.yaml"
    try:
        cfg = {}
        if cfg_path.is_file():
            cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        model_block = cfg.setdefault("model", {})
        model_block["default"] = model_id
        model_block["provider"] = provider_key
        cfg_path.parent.mkdir(parents=True, exist_ok=True)
        cfg_path.write_text(yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False),
                           encoding="utf-8")
        return True
    except (OSError, yaml.YAMLError):
        return False


def _default_home() -> Path:
    return Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes")).expanduser()


def ensure_profile(
    profile_name: str,
    profile_home: str | Path,
    employee_id: str = "",
    template_config: dict | None = None,
) -> bool:
    """Ensure a Hermes profile exists for this employee and inherits providers.

    Returns False if the profile directory already existed, True if created.
    The root provider config is (re)seeded on every call so existing profiles
    created before this fix self-heal on their next run.
    """
    profile_dir = Path(profile_home) / "profiles" / profile_name
    already_existed = profile_dir.exists()
    if not already_existed:
        # `hermes profile create` reads HERMES_HOME from the environment; it does
        # NOT accept a --home flag (passing one makes argparse reject the call
        # with "unrecognized arguments: --home", so the profile is never created
        # and the cron/run that needs it silently falls back to a stub).
        cmd = [
            *_build_hermes_cli(profile_home),
            "profile",
            "create",
            profile_name,
        ]
        env = dict(os.environ)
        env["HERMES_HOME"] = str(profile_home)
        result = subprocess.run(cmd, capture_output=True, text=True, env=env)
        if result.returncode != 0:
            raise RuntimeError(f"Profile create failed: {result.stderr}")
    _seed_profile_config(profile_dir, profile_home)
    return not already_existed


def resolve_profile_path(hermes_home: str | Path, profile_name: str) -> Path:
    """Resolve the profile directory path."""
    return Path(hermes_home) / "profiles" / profile_name


def profile_exists(hermes_home: str | Path, profile_name: str) -> bool:
    """Check whether a profile directory exists."""
    return resolve_profile_path(hermes_home, profile_name).exists()
