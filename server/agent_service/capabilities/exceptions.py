"""M3 能力装配异常体系（AITEAM-692）。

失败策略（issue 设计）：
- 知识库不可用 → KnowledgeUnavailable（阻断提示，run 不发起）；
- memory 不可用 → 不抛错，由调用方按 degradation 处理（可降级继续）；
- connector 按能力类型明确失败 → ConnectorCapabilityError（凭据缺失/服务不可达）。
"""


class CapabilityError(Exception):
    """能力装配失败的基类。"""


class CapabilityUnavailable(CapabilityError):
    """能力整体不可用（registry 中找不到对应条目）。"""


class KnowledgeUnavailable(CapabilityUnavailable):
    """知识库不可用：阻断 run，需提示用户。"""


class ConnectorCapabilityError(CapabilityUnavailable):
    """连接器能力失败（凭据缺失 / 服务不可达 / MCP 不健康）。按连接器类型明确报错。"""

    def __init__(self, connector_id: str, reason: str) -> None:
        super().__init__(f"connector {connector_id!r} unavailable: {reason}")
        self.connector_id = connector_id
        self.reason = reason
