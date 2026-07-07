"""M3 能力健康检查 + env 解析（AITEAM-692）。

运行前对 registry 条目做本地探测：
- mode=command：``shutil.which`` 找 CLI；找不到 → not_ready。
- mode=url：校验 url_env 指定的 env var 是否存在且非空。
- mode=none：跳过探测（信任声明）。

凭据解析（D18）：从宿主 os.environ 按 required_env 取值；缺失则 not_ready，
由调用方按能力种类决定阻断/降级。
"""

from __future__ import annotations

import os
import shutil
import subprocess
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from .registry import CapabilityEntry, CapabilityKind


class HealthStatus(str, Enum):
    READY = "ready"
    NOT_READY = "not_ready"
    DEGRADED = "degraded"  # memory 不可用时的降级态


class CapabilityHealth(BaseModel):
    """单个能力的健康检查结果。"""

    model_config = ConfigDict(extra="forbid")

    name: str
    kind: CapabilityKind
    ref: str
    status: HealthStatus
    reason: str | None = Field(default=None, description="not_ready/degraded 原因")
    cli_available: bool = Field(default=False, description="CLI 是否在 PATH 中可找到")
    cli_version: str | None = Field(default=None, description="CLI 版本（best-effort）")
    env_missing: list[str] = Field(default_factory=list, description="缺失的 required_env 名")
    resolved_env: dict[str, str] = Field(
        default_factory=dict,
        description="从宿主 env 解析出的凭据（名/值）；仅探测用，调用方负责不落盘/日志（D18）",
    )


def check_capability_health(entry: CapabilityEntry, *, ref: str) -> CapabilityHealth:
    """对单个 registry 条目做健康检查。

    不抛错：把结果收敛到 CapabilityHealth，由调用方按 kind 决定阻断/降级。
    """
    resolved: dict[str, str] = {}
    missing: list[str] = []
    for name in entry.required_env:
        val = _safe_getenv(host_env(), name)
        if val is None:
            missing.append(name)
        else:
            resolved[name] = val

    hc = entry.health_check
    cli_available = False
    cli_version: str | None = None
    reason: str | None = None

    if hc.mode == "none":
        if missing:
            reason = f"missing env: {missing}"
        return CapabilityHealth(
            name=entry.name, kind=entry.kind, ref=ref,
            status=HealthStatus.NOT_READY if missing else HealthStatus.READY,
            reason=reason, cli_available=True, cli_version=None,
            env_missing=missing, resolved_env=resolved,
        )

    if hc.mode == "url":
        url_val = _safe_getenv(host_env(), hc.url_env) if hc.url_env else None
        if url_val:
            cli_available = True
        elif missing:
            reason = f"missing env: {missing}"
        else:
            reason = f"endpoint env {hc.url_env!r} not set"
        return CapabilityHealth(
            name=entry.name, kind=entry.kind, ref=ref,
            status=HealthStatus.READY if cli_available and not missing else HealthStatus.NOT_READY,
            reason=reason, cli_available=cli_available, cli_version=None,
            env_missing=missing, resolved_env=resolved,
        )

    # mode == command
    probe_cmd = hc.command or entry.command
    if not probe_cmd:
        reason = "no command to probe"
        return CapabilityHealth(
            name=entry.name, kind=entry.kind, ref=ref,
            status=HealthStatus.NOT_READY, reason=reason,
            cli_available=False, cli_version=None,
            env_missing=missing, resolved_env=resolved,
        )
    found_path = shutil.which(probe_cmd)
    cli_available = bool(found_path)
    if cli_available:
        cli_version = _probe_version(probe_cmd, hc.args)
    if not cli_available:
        reason = f"CLI {probe_cmd!r} not found in PATH"
    elif missing:
        reason = f"missing env: {missing}"
    return CapabilityHealth(
        name=entry.name, kind=entry.kind, ref=ref,
        status=HealthStatus.READY if (cli_available and not missing) else HealthStatus.NOT_READY,
        reason=reason, cli_available=cli_available, cli_version=cli_version,
        env_missing=missing, resolved_env=resolved,
    )


def resolve_env_for_entries(entries: list[CapabilityEntry]) -> dict[str, str]:
    """批量解析 entries 的 required_env → 合并 env dict（供 mcp_config.env 注入）。

    仅从宿主 os.environ 取值；缺失的跳过（由 health 检查负责报错）。
    返回的 dict 不落盘、不日志（D18）：调用方只用于构造 RunSpec.mcp_config 的 env 字段。
    """
    env = host_env()
    out: dict[str, str] = {}
    for e in entries:
        for name in e.required_env:
            val = env.get(name)
            if val and name not in out:
                out[name] = val
    return out


def host_env() -> dict[str, str]:
    """宿主 env 只读快照（dict 拷贝）。测试可通过 ``patch`` 此函数注入假 env。"""
    return dict(os.environ)


def _safe_getenv(env: dict[str, str], name: str | None) -> str | None:
    """从 env 快照读单个变量；None / 空串视为缺失。"""
    if not name:
        return None
    val = env.get(name)
    return val if val else None


def _probe_version(command: str, args: list[str]) -> str | None:
    """best-effort 取 ``<command> --version`` 首行；失败返回 None。"""
    try:
        out = subprocess.run(
            [command, *args, "--version"] if args else [command, "--version"],
            capture_output=True, text=True, timeout=3, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    line = (out.stdout or out.stderr or "").strip().splitlines()
    return line[0] if line else None
