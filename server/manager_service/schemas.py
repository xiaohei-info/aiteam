"""employee/expert 配置 API 边界 schema（M2，06 §7.5/§7.6 / 04 §6.1，D16）。

口径（D16）：所有配置字段 **runtime 中立**。本文件只 import 共享契约的 ModelPolicy /
RuntimePolicy（snapshot.py），不重定义；API 入参/出参以此为中立载体，绝不出现 runtime 原生
格式（SOUL.md/config.yaml/启动参数——那是用户端 Driver 的职责，06 §7.5.3）。
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field, model_validator

from shared.contracts.snapshot import ModelPolicy, RuntimePolicy


# ---- 配置载体：复用契约的中立 ModelPolicy / RuntimePolicy，外加 persona 与能力引用 ----

class EmployeeConfig(BaseModel):
    """employee 的中立运行配置真相（runtime 无关）。

    本结构即 M7 EmployeeExecutionSnapshot 的配置来源（去掉 version/snapshot_version 等快照字段）。
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str = ""
    persona: str | None = Field(default=None, description="中立 persona 文本（不写 SOUL.md，D16）")
    model_policy: ModelPolicy = Field(default_factory=ModelPolicy)
    runtime_policy: RuntimePolicy = Field(default_factory=RuntimePolicy)
    tools: list[str] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list, description="技能引用；A 类能力本地经 MCP 注入")
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    connector_refs: list[str] = Field(default_factory=list)
    memory_policy: dict | None = Field(default=None, description="记忆策略（04 §6.6，mem0）")


class EmployeeConfigIn(EmployeeConfig):
    """写入请求体。继承 EmployeeConfig 全部中立字段。"""

    @model_validator(mode="after")
    def _runtime_neutral(self) -> "EmployeeConfigIn":
        # 守红线（issue 红线：不配置 runtime 非中立）。runtime_binding 只允许中立标识符，
        # 不含启动参数/路径/原生 profile 片段（06 §7.6）。
        rb = self.runtime_policy.runtime_binding
        if rb is not None and not _is_neutral_runtime_binding(rb):
            raise ValueError(
                "runtime_binding 必须是中立 runtime 标识符（小写字母/数字/下划线），"
                "禁止内联 runtime 启动参数或原生 profile（D16）"
            )
        return self


def _is_neutral_runtime_binding(value: str) -> bool:
    """runtime_binding 中立性：仅允许 `[a-z0-9_]+` 标识符（如 hermes_acp、claude_code_json_stream）。

    拒绝任何含路径分隔符、空格、=、-- 等 runtime 参数痕迹的取值——它们属于用户端 Driver（06 §7.3）。
    """
    if not value:
        return False
    return all(c.isalnum() or c == "_" for c in value) and value.isascii() and value.islower()


class EmployeeConfigOut(EmployeeConfig):
    """读取响应体。带 employee 身份与版本（供增量 sync / 快照冻结）。"""

    employee_id: str
    employee_slug: str
    version: int = Field(description="配置版本；每次配置变更单调递增")
