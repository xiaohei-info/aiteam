"""Executor / Driver 抽象（06 §7.2 / §7.3，D7/D16）。

- Executor 按**协议族**复用（ACP / JSON-RPC stdio / JSON stream CLI / 降级 plain）；
  负责进程/stdio/stream/超时/取消/idle watchdog/session/日志/脱敏前置钩子等通用机制。
- Driver 按**runtime 差异**收口：CLI 路径与参数、capability 声明、握手、原始事件解析、
  session_id/usage 提取、错误归类。**Driver 是唯一翻译点**，网关核心与业务层不碰原生格式。

铁律：Driver 只解析 runtime 事件，**不懂企业/员工/账单/权限**（CLAUDE/AGENTS §8 风险边界）。
runtime 启动配置由各 Driver 在用户端自身配置声明，不读 app/.env、不用 HERMES_WEBUI_*（06 §7.3）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

from pydantic import BaseModel, ConfigDict, Field

from .events import AgentRuntimeEvent
from .runspec import AgentRunRequest, RunSpec

# Gateway 把归一事件回流给 Agent Service 的回调（端内流式，05 §5.2）。
EventSink = Callable[[AgentRuntimeEvent], Awaitable[None]]


class RuntimeCapability(BaseModel):
    """Driver 的能力声明（06 §7.5.4）。不支持的能力须显式降级或标 unsupported，绝不静默丢弃。"""

    model_config = ConfigDict(extra="forbid")

    runtime: str
    supports_native_skills: bool = False
    supports_native_memory: bool = False
    supports_resume: bool = False
    supports_mcp: bool = True
    system_prompt_injection: str = Field(
        default="flag", description="persona 注入方式：flag | protocol | file"
    )
    model_catalog_mode: str = Field(default="static", description="static | dynamic（shell 出 CLI 列模型）")


class RunResult(BaseModel):
    """一次 run 的终态汇总（由 Executor 返回）。"""

    model_config = ConfigDict(extra="forbid")

    run_id: str
    success: bool
    session_id: str | None = None
    error: str | None = None
    usage: dict | None = None


class Driver(ABC):
    """具体 runtime 适配器（06 §7.3）。每个 runtime 一个 Driver，绑定一个 Executor 协议族。"""

    @abstractmethod
    def capabilities(self) -> RuntimeCapability:
        """声明本 runtime 支持的能力与注入方式。"""

    @abstractmethod
    def build_command(self, run_spec: RunSpec) -> list[str]:
        """把中立 RunSpec 翻译为该 runtime 的启动命令/参数（优先 flag/协议；custom_args 过 denylist）。"""

    @abstractmethod
    def parse_event(self, raw: object) -> AgentRuntimeEvent | None:
        """把一条 runtime 原始事件归一为 AgentRuntimeEvent；无法映射返回 None（不静默伪造）。"""

    @abstractmethod
    def extract_session_id(self, raw: object) -> str | None:
        """从原始事件/握手中提取 session_id/thread_id。"""

    @abstractmethod
    def extract_usage(self, raw: object) -> dict | None:
        """提取 usage（token/成本）。"""


class Executor(ABC):
    """按协议族抽象的执行器（06 §7.2）。负责通用机制，不懂 runtime 差异（差异在 Driver）。"""

    @abstractmethod
    async def execute(
        self,
        request: AgentRunRequest,
        driver: Driver,
        on_event: EventSink,
    ) -> RunResult:
        """启动/连接 runtime，驱动一次 run，把归一事件经 on_event 回流，返回终态。"""

    @abstractmethod
    async def cancel(self, run_id: str) -> None:
        """取消运行中的 run（清理进程/连接/超时）。"""
