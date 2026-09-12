"""Operator 目录拉取客户端抽象（M6，05 F06/F07 + §5.3，D4/D14）。

职责：封装 Manager → Operator 的「单向只读拉取」——拉专家模板详情（ExpertTemplateDetail）
与行业方案包（SolutionPackage）。Manager 拉下来**只读用、不改模板真相**（05 F06/F07 红线：
Operator 持模板真相，Manager 不写、不改）。

抽象边界：
- 真实实现 `OperatorCatalogClient`（生产）经 `shared.service_client.ServiceClient` 走云侧受控
  服务间调用（05 §5.3，#176/#213 已落地：调 Operator `/api/operation/catalog/pull/*`，服务身份认证）。
- 测试/骨架期注入 `FakeOperatorCatalogClient`（内存预置模板/方案包），使 F06/F07 流程可在
  不依赖 Operator 服务的前提下端到端验证。
- 调用方（RecruitService）只依赖 `OperatorCatalogPort` 抽象，便于后续无侵入替换真实实现。

红线：本接口**绝不反向写 Operator**——Manager 单向拉（05 §5 通信面方向铁律）。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Mapping
from urllib.parse import quote

from shared.contracts.crosstier import ExpertTemplateDetail, SolutionPackage
from shared.contracts.platform_skill import PlatformSkillPackage
from shared.errors import AppError


class OperatorCatalogUnavailable(AppError):
    status, code, title = 503, "operator_unavailable", "Operator catalog unavailable"


class OperatorCatalogPort(ABC):
    """Manager 拉取 Operator 目录的只读端口（05 F06/F07，D4）。

    所有方法只读返回模板/方案包真相；Manager 不通过本端口回写 Operator（红线）。
    """

    @abstractmethod
    def pull_expert_template(
        self, *, template_id: str, version: str | None = None
    ) -> ExpertTemplateDetail:
        """F06 拉专家模板详情（05 F06）。template_id/version 为 Operator 侧只读标识。"""

    @abstractmethod
    def pull_solution_package(
        self, *, solution_id: str, version: str | None = None
    ) -> SolutionPackage:
        """F07 拉行业方案包（05 F07）。solution_id/version 为 Operator 侧只读标识。"""

    @abstractmethod
    def list_expert_templates(self) -> list[ExpertTemplateDetail]:
        """F06 浏览：列可招募专家模板（各 template 取最新版本）。只读，不写 Operator。"""

    @abstractmethod
    def list_solution_packages(self) -> list[SolutionPackage]:
        """F07 浏览：列可应用行业方案包（各 solution 取最新版本）。只读，不写 Operator。"""

    def list_platform_skills(self) -> list[dict]:
        return []

    def pull_platform_skill(self, *, skill_id: str, version: str) -> PlatformSkillPackage:
        from shared.errors import NotFound
        raise NotFound(f"platform skill not found: {skill_id}@{version}")

    def list_platform_catalog(self, *, tenant_id: str | None = None) -> dict:
        return {"providers": [], "models": []}

    def resolve_tenant_access(self, *, tenant_id: str, provider_id: str, model_ids: list[str]) -> dict:
        from shared.errors import NotFound
        raise NotFound("platform tenant access is unavailable")


class OperatorCatalogClient(OperatorCatalogPort):
    """生产实现：经 shared.service_client 走 Operator 云侧端点（05 §5.3，#176）。

    通过 ServiceClient 调用 Operation 的拉取端点，使用短期 signed service identity。
    """

    def __init__(
        self,
        base_url: str,
        *,
        service_identity: str | None = None,
        service_token: str | None = None,
        service_audience: str | None = None,
        client_kwargs: Mapping[str, Any] | None = None,
    ):
        """构造 Operator 目录客户端。

        Args:
            base_url: Operator 服务地址（如 http://operator:8000）
            service_identity: 服务身份标识（审计用）
            service_token: 仅 dev/test 兼容的共享密钥；production 不使用
        """
        from shared.service_client import ServiceClient

        kwargs = dict(client_kwargs or {})
        kwargs.setdefault("service_identity", service_identity)
        kwargs.setdefault("service_token", service_token)
        kwargs.setdefault("service_audience", service_audience)
        kwargs.update(base_url=base_url, timeout=10.0)
        self._client = ServiceClient(**kwargs)

    def pull_expert_template(
        self, *, template_id: str, version: str | None = None
    ) -> ExpertTemplateDetail:
        """F06：拉取专家模板详情。调用 GET /api/operation/catalog/pull/expert-templates/{template_id}"""
        path = f"/api/operation/catalog/pull/expert-templates/{template_id}"
        if version:
            path += f"?version={version}"
        resp = self._get(path)
        # 响应为 Envelope[ExpertTemplateDetail]，取 data 字段
        data = resp.get("data", {})
        return ExpertTemplateDetail.model_validate(data)

    def pull_solution_package(
        self, *, solution_id: str, version: str | None = None
    ) -> SolutionPackage:
        """F07：拉取行业方案包。调用 GET /api/operation/catalog/pull/solution-templates/{solution_id}"""
        path = f"/api/operation/catalog/pull/solution-templates/{solution_id}"
        if version:
            path += f"?version={version}"
        resp = self._get(path)
        # 响应为 Envelope[SolutionPackage]，取 data 字段
        data = resp.get("data", {})
        return SolutionPackage.model_validate(data)

    def list_expert_templates(self) -> list[ExpertTemplateDetail]:
        """F06：列举可招募专家模板。调用 GET /api/operation/catalog/pull/expert-templates"""
        resp = self._get("/api/operation/catalog/pull/expert-templates")
        # 响应为 ListEnvelope[ExpertTemplateDetail]，取 data 字段
        data_list = resp.get("data", [])
        return [ExpertTemplateDetail.model_validate(item) for item in data_list]

    def list_solution_packages(self) -> list[SolutionPackage]:
        """F07：列举可应用行业方案包。调用 GET /api/operation/catalog/pull/solution-templates"""
        resp = self._get("/api/operation/catalog/pull/solution-templates")
        # 响应为 ListEnvelope[SolutionPackage]，取 data 字段
        data_list = resp.get("data", [])
        return [SolutionPackage.model_validate(item) for item in data_list]

    def pull_platform_skill(self, *, skill_id: str, version: str) -> PlatformSkillPackage:
        path = f"/api/operation/skill-market/pull/skills/{skill_id}/versions/{version}"
        data = self._get(path).get("data", {})
        return PlatformSkillPackage.model_validate(data)

    def list_platform_skills(self) -> list[dict]:
        return self._get("/api/operation/skill-market/pull/skills").get("data", [])

    def list_platform_catalog(self, *, tenant_id: str | None = None) -> dict:
        """Pull the catalog with an exact tenant-only service target binding."""
        path = "/api/operation/catalog/platform-providers"
        if tenant_id:
            path += f"?tenant_id={quote(tenant_id, safe='')}"
        return self._get(
            path,
            service_purpose="catalog:read",
            service_tenant_id=tenant_id,
        ).get("data", {})

    def resolve_tenant_access(self, *, tenant_id: str, provider_id: str, model_ids: list[str]) -> dict:
        try:
            return self._client.post(
                "/api/operation/provider-access/resolve",
                json={"tenant_id": tenant_id, "provider_id": provider_id, "model_ids": model_ids},
                idempotency_key=f"provider-access:{tenant_id}:{provider_id}",
                service_purpose="relay:resolve",
                service_tenant_id=tenant_id,
            ).get("data", {})
        except AppError:
            raise
        except Exception as exc:
            raise OperatorCatalogUnavailable("Operator provider access is unavailable") from exc

    def _get(
        self,
        path: str,
        *,
        service_purpose: str | None = None,
        service_tenant_id: str | None = None,
    ) -> dict:
        try:
            return self._client.get(
                path,
                service_purpose=service_purpose,
                service_tenant_id=service_tenant_id,
            )
        except AppError:
            raise
        except Exception as exc:
            raise OperatorCatalogUnavailable("Operator catalog is unavailable") from exc

    def close(self) -> None:
        """关闭 HTTP 客户端连接。"""
        self._client.close()


class FakeOperatorCatalogClient(OperatorCatalogPort):
    """测试/骨架期内存 fake：预置模板/方案包真相，模拟 Operator 目录拉取。

    用法：
        fake = FakeOperatorCatalogClient()
        fake.seed_expert(ExpertTemplateDetail(template_id="...", ...))
        fake.seed_solution(SolutionPackage(solution_id="...", ...))
    本实现**只读返回**预置数据，绝不反向写——守 Manager 单向拉红线。
    """

    def __init__(self) -> None:
        self._experts: dict[tuple[str, str], ExpertTemplateDetail] = {}
        self._experts_latest: dict[str, ExpertTemplateDetail] = {}
        self._solutions: dict[tuple[str, str], SolutionPackage] = {}
        self._solutions_latest: dict[str, SolutionPackage] = {}
        self._platform_skills: dict[tuple[str, str], PlatformSkillPackage] = {}
        self._platform_catalog: dict = {"providers": [], "models": []}
        self.invalidated: list[tuple[str, str]] = []

    def invalidate(self, catalog_type: str, template_id: str) -> None:
        """记录缓存失效请求（fake 无真实缓存，仅用于测试观测）。"""
        self.invalidated.append((catalog_type, template_id))

    # ---- 预置（测试/骨架用，生产不调）----
    def seed_expert(self, detail: ExpertTemplateDetail) -> None:
        self._experts[(detail.template_id, detail.version)] = detail
        self._experts_latest[detail.template_id] = detail

    def seed_solution(self, package: SolutionPackage) -> None:
        self._solutions[(package.solution_id, package.version)] = package
        self._solutions_latest[package.solution_id] = package

    def seed_platform_skill(self, package: PlatformSkillPackage) -> None:
        self._platform_skills[(package.package.skill_id, package.package.version)] = package

    def seed_platform_catalog(self, catalog: dict) -> None:
        self._platform_catalog = catalog

    # ---- 只读拉取（红线：不改预置真相）----
    def pull_expert_template(
        self, *, template_id: str, version: str | None = None
    ) -> ExpertTemplateDetail:
        if version is not None:
            detail = self._experts.get((template_id, version))
        else:
            detail = self._experts_latest.get(template_id)
        if detail is None:
            from shared.errors import NotFound

            raise NotFound(f"expert template not found in operator catalog: {template_id}@{version}")
        return detail.model_copy(deep=True)  # 返回副本，防止调用方改模板真相

    def pull_solution_package(
        self, *, solution_id: str, version: str | None = None
    ) -> SolutionPackage:
        if version is not None:
            package = self._solutions.get((solution_id, version))
        else:
            package = self._solutions_latest.get(solution_id)
        if package is None:
            from shared.errors import NotFound

            raise NotFound(f"solution package not found in operator catalog: {solution_id}@{version}")
        return package.model_copy(deep=True)  # 返回副本，防止调用方改模板真相

    # ---- 只读列举（浏览；各标识取最新版本，返回副本防改真相）----
    def list_expert_templates(self) -> list[ExpertTemplateDetail]:
        return [d.model_copy(deep=True) for d in self._experts_latest.values()]

    def list_solution_packages(self) -> list[SolutionPackage]:
        return [p.model_copy(deep=True) for p in self._solutions_latest.values()]

    def list_platform_skills(self) -> list[dict]:
        latest: dict[str, PlatformSkillPackage] = {}
        for (skill_id, _), package in self._platform_skills.items():
            latest[skill_id] = package
        return [
            {
                "skill_id": skill_id,
                "owner": item.owner,
                "slug": item.slug,
                "display_name": item.package.display_name,
                "summary": item.package.description,
                "published_version": item.package.version,
                "content_hash": item.package.content_hash,
                "status": "published",
            }
            for skill_id, item in latest.items()
        ]

    def pull_platform_skill(self, *, skill_id: str, version: str) -> PlatformSkillPackage:
        package = self._platform_skills.get((skill_id, version))
        if package is None:
            from shared.errors import NotFound
            raise NotFound(f"platform skill not found: {skill_id}@{version}")
        return package.model_copy(deep=True)

    def list_platform_catalog(self, *, tenant_id: str | None = None) -> dict:
        catalog = dict(self._platform_catalog)
        # Tests may provide an explicit per-tenant projection without making the
        # fake pretend to be an Operator database.
        by_tenant = catalog.pop("allowed_models_by_tenant", None)
        if tenant_id and isinstance(by_tenant, dict):
            allowed = {(str(ref.get("provider_id")), str(ref.get("model_id"))) for ref in by_tenant.get(tenant_id, []) if isinstance(ref, dict)}
            catalog["models"] = [
                item for item in catalog.get("models", [])
                if isinstance(item, dict)
                and isinstance(item.get("model"), dict)
                and (str(item["model"].get("provider_id")), str(item["model"].get("model_id"))) in allowed
            ]
            catalog["model_access_configured"] = True
        return catalog

    def resolve_tenant_access(self, *, tenant_id: str, provider_id: str, model_ids: list[str]) -> dict:
        by_tenant = self._platform_catalog.get("allowed_models_by_tenant")
        if tenant_id and isinstance(by_tenant, dict):
            allowed = {
                (str(ref.get("provider_id")), str(ref.get("model_id")))
                for ref in by_tenant.get(tenant_id, [])
                if isinstance(ref, dict)
            }
            if any((provider_id, model_id) not in allowed for model_id in model_ids):
                from shared.errors import NotFound
                raise NotFound("platform model not found")
        return {
            "access": {"access_id": f"access-{tenant_id}-{provider_id}", "tenant_id": tenant_id, "provider_id": provider_id,
                       "allowed_model_ids": model_ids, "status": "active", "version": 1, "expires_at": None},
            "relay_base_url": "https://relay.test/v1", "api_protocol": "openai-completions", "relay_token": "test-tenant-token",
        }
