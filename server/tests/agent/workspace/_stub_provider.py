"""测试用 stub provider：代替已移除的 FakeMarketplaceProvider。

返回固定模板列表（含 1 条），满足 WorkspaceService 构造需要"真实 provider"的前置条件；
不对外暴露任何假数据给业务路径。
"""

from agent_service.workspace.service import MarketTemplate


class StubMarketplaceProvider:
    """测试用的最小 provider：返回 1 条固定 MarketTemplate。"""

    def __init__(self, templates: list[MarketTemplate] | None = None) -> None:
        self._templates = templates if templates is not None else [
            MarketTemplate(template_id="stub-tpl", display_name="stub",
                           category="general", tags=["stub"]),
        ]

    def list_templates(self) -> list[MarketTemplate]:
        return list(self._templates)
