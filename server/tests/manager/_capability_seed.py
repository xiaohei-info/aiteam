"""集成测试用：先在企业目录里建好可用的技能 / 连接器，员工才能引用（保存时会校验新增的引用）。"""

from manager_service.capability_catalog_service import build_capability_catalog_service
from manager_service.schemas import ConnectorCatalogIn, SkillCatalogIn
from shared.contracts.tenancy import TenantContext
from shared.db import PgTenantRouter


def seed_ready_capabilities(db_url: str, tenant_id: str, *, skills=(), connectors=()) -> None:
    catalog = build_capability_catalog_service(PgTenantRouter(db_url))
    ctx = TenantContext(tenant_id=tenant_id, user_id="seed-owner", roles=["owner"])
    for skill_id in skills:
        catalog.create_skill(ctx, SkillCatalogIn(
            skill_id=skill_id, display_name=skill_id, version="1",
            files=[{"path": "SKILL.md", "content": f"---\nname: {skill_id}\ndescription: Seeded\n---\nDo the work."}],
        ))
    for connector_id in connectors:
        catalog.create_connector(ctx, ConnectorCatalogIn(connector_id=connector_id, display_name=connector_id))
