import json

from team_panel.api_team import router_team
from team_panel.domain.entities import AgentTemplate, EnterpriseLlmModel, EnterpriseLlmProvider
from team_panel.repositories.enterprise_llm_provider_repo import (
    EnterpriseLlmModelRepo,
    EnterpriseLlmProviderRepo,
)
from team_panel.transactions.uow import UnitOfWork


def test_resolve_employee_model_falls_back_to_enterprise_default_when_template_has_no_model(uow, clean_tables_with_enterprise):
    with uow:
        provider = EnterpriseLlmProvider(
            id="prov_newapi",
            enterprise_id="ent_test",
            provider_key="newapi",
            display_name="New API",
            base_url="https://newapi.example.com/v1",
            api_key="sk-test",
            transport="openai_chat",
            enabled=True,
            created_by="test",
        )
        EnterpriseLlmProviderRepo(uow.cur).create(provider)
        model = EnterpriseLlmModel(
            id="model_default",
            enterprise_id="ent_test",
            provider_id=provider.id,
            model_id="minimax-m2.5",
            label="MiniMax M2.5",
            context_length=200000,
            enabled=True,
            is_default=True,
        )
        EnterpriseLlmModelRepo(uow.cur).create(model)

        template = AgentTemplate(
            id="tpl_no_model",
            name="前端开发",
            category_code="frontend",
            role_name="前端开发",
            status="published",
            prompt_pack_json=json.dumps({"description": "前端开发"}, ensure_ascii=False),
            default_model_json=json.dumps({"temperature": 0.7, "max_tokens": 2048}, ensure_ascii=False),
            default_binding_json="{}",
            publish_scope_json="{}",
            source_type="system",
            created_by="test",
        )

        provider_key, model_id = router_team._resolve_employee_model(  # noqa: SLF001
            uow.cur,
            "ent_test",
            template,
            {},
        )

        assert provider_key == "newapi"
        assert model_id == "minimax-m2.5"
