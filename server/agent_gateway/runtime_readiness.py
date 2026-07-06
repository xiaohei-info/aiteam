"""Runtime readiness 校验（AITEAM-688 M0：部署级 runtime 固定与生产 Fake 禁用）。

把"部署时决定 runtime"这条边界落到代码：给定 runtime_selection 与是否生产，返回结构化
``RuntimeReadiness``，供启动 fail-fast 与 ``/agent/health`` 端点共用同一判定口径。

规则（与验收矩阵对齐）：
- 未配置 AGENT_RUNTIME：dev/test → ready（Fake）；生产 → runtime_not_ready（必须显式配 runtime）。
- 未知 runtime（不在 DRIVER_REGISTRY）：runtime_not_ready（不静默切换）。
- 生产显式选 fake：runtime_not_ready（生产禁止 Fake runtime 回退）。
- 已知真实 runtime：透出 driver.runtime_health()（CLI 可用性/版本/capabilities），CLI 缺失→not_ready。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.gateway import RuntimeHealth

from .drivers import DRIVER_REGISTRY, get_driver

_FAKE_RUNTIME = "fake"


class RuntimeReadiness(BaseModel):
    """runtime readiness 结论（启动校验与 /agent/health 共用）。"""

    model_config = ConfigDict(extra="forbid")

    status: str = Field(description="ready | runtime_not_ready")
    runtime: str = Field(description="当前 runtime 标识；未配置时为 fake（dev 回退）")
    reason: str | None = Field(default=None, description="runtime_not_ready 原因")
    health: RuntimeHealth | None = Field(default=None, description="driver 自检详情（CLI/capabilities）")
    production: bool = Field(default=False, description="是否按生产模式判定")


def check_runtime_readiness(
    runtime_selection: str | None,
    *,
    production: bool,
) -> RuntimeReadiness:
    """判定 runtime readiness。纯函数：不查宿主 env，只据入参与 DRIVER_REGISTRY。"""
    # 1) 未配置 runtime
    if not runtime_selection:
        if production:
            return RuntimeReadiness(
                status="runtime_not_ready",
                runtime=_FAKE_RUNTIME,
                reason="AGENT_RUNTIME is not configured; production requires an explicit runtime",
                production=production,
            )
        # dev/test：回退 Fake，ready。透出 Fake driver 自检（capabilities）便于 /agent/health 展示。
        fake_driver = get_driver(_FAKE_RUNTIME)
        return RuntimeReadiness(
            status="ready",
            runtime=_FAKE_RUNTIME,
            health=fake_driver.runtime_health(),
            production=production,
        )

    # 2) 未知 runtime（不在注册表）
    if runtime_selection not in DRIVER_REGISTRY:
        return RuntimeReadiness(
            status="runtime_not_ready",
            runtime=runtime_selection,
            reason=(
                f"unknown runtime_selection: {runtime_selection!r}; "
                f"known runtimes: {sorted(DRIVER_REGISTRY)}"
            ),
            production=production,
        )

    # 3) 生产禁止 Fake runtime
    if production and runtime_selection == _FAKE_RUNTIME:
        return RuntimeReadiness(
            status="runtime_not_ready",
            runtime=_FAKE_RUNTIME,
            reason="Fake runtime is forbidden in production (AITEAM-688)",
            production=production,
        )

    # 4) 已知 runtime：透出 driver 自检（CLI 可用性等）
    driver = get_driver(runtime_selection)
    health = driver.runtime_health()
    status = "ready" if health.status == "ready" else "runtime_not_ready"
    return RuntimeReadiness(
        status=status,
        runtime=runtime_selection,
        health=health,
        reason=health.reason if status != "ready" else None,
        production=production,
    )
