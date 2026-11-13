"""招募 / 应用方案的模型校验：每个新建专家必须由企业显式选一个本企业可用的平台模型。

模板不再携带模型（运营端不管专家的模型与思考档位），所以这里是模型进入员工配置的唯一入口。
校验只读（按租户过滤后的平台目录），必须在任何写入之前完成；
`resolve_tenant_access` 有预配副作用，留在招募订单追踪之内调用：失败时不留订单、员工、技能安装或授权。
"""

from __future__ import annotations

from shared.contracts.envelope import ProblemFieldError
from shared.contracts.tenancy import TenantContext
from shared.errors import AppError, Conflict

from .employee_config_service import _validate_thinking_level
from .operator_catalog import OperatorCatalogPort
from .schemas import RecruitModelPolicy


class ModelRequired(AppError):
    status, code, title = 422, "model_required", "Model required"


class ModelUnavailable(AppError):
    status, code, title = 422, "model_unavailable", "Model unavailable"


def _reason(exc: AppError) -> str:
    return exc.detail if exc.detail else exc.title


def _catalog(operator: OperatorCatalogPort, tenant_id: str) -> dict:
    try:
        return operator.list_platform_catalog(tenant_id=tenant_id)
    except TypeError:
        return operator.list_platform_catalog()


def validate_recruit_model(
    operator: OperatorCatalogPort, ctx: TenantContext, policy: RecruitModelPolicy | None,
) -> dict:
    """返回通过校验的 `platform_model_ref`（{provider_id, model_id}）。

    - 没选模型 → 422 model_required；
    - 模型不存在 / 未发布 / 价格未知 / 企业未开通 / 思考档位不支持 → 422 model_unavailable
      （对企业不区分「未开通」与「不存在」，不泄露平台策略）。
    Operator 不可达等 5xx 原样抛出，由调用方按上游故障处理。
    """
    model = (policy.model if policy else "").strip()
    provider = (policy.provider_ref if policy else "").strip()
    if not model or not provider:
        raise ModelRequired("a platform model must be selected")
    catalog = _catalog(operator, ctx.tenant_id)
    providers = catalog.get("providers") if isinstance(catalog, dict) else None
    listed = next((p for p in providers or [] if isinstance(p, dict) and p.get("provider_id") == provider), None)
    # 极简测试替身可能只给模型清单；生产目录总带 providers，且要求 provider 已发布。
    if providers is not None and not (listed and listed.get("status") == "published"):
        raise ModelUnavailable("the selected model is not available")
    entry = next(
        (
            item for item in (catalog.get("models", []) if isinstance(catalog, dict) else [])
            if isinstance(item, dict)
            and (item.get("model") or {}).get("provider_id") == provider
            and (item.get("model") or {}).get("model_id") == model
        ),
        None,
    )
    if entry is None:
        raise ModelUnavailable("the selected model is not available")
    detail, rate = entry.get("model") or {}, entry.get("rate") or {}
    if detail.get("status") != "published" or rate.get("pricing_status") != "known":
        raise ModelUnavailable("the selected model is not available")
    try:
        _validate_thinking_level(policy.thinking_level if policy else None, detail.get("capabilities") or {})
    except Conflict as exc:
        raise ModelUnavailable(_reason(exc)) from exc
    return {"provider_id": provider, "model_id": model}


def collect_model_errors(
    operator: OperatorCatalogPort, ctx: TenantContext, wanted: dict[str, RecruitModelPolicy | None],
) -> dict[str, dict]:
    """批量校验（应用方案）：任一失败则整单 422，`errors[]` 逐个列出 template_id。

    `wanted`：template_id → 请求里选的模型（None 表示该新建专家没选）。成功时返回 template_id → platform_model_ref。
    """
    refs: dict[str, dict] = {}
    failures: list[tuple[str, AppError]] = []
    for template_id, policy in wanted.items():
        try:
            refs[template_id] = validate_recruit_model(operator, ctx, policy)
        except (ModelRequired, ModelUnavailable) as exc:
            failures.append((template_id, exc))
    if failures:
        errors = [
            ProblemFieldError(loc=["body", "expert_models", template_id], message=_reason(exc), type=exc.code)
            for template_id, exc in failures
        ]
        cls = ModelRequired if any(isinstance(exc, ModelRequired) for _, exc in failures) else ModelUnavailable
        raise cls(f"{len(errors)} expert(s) have no usable model", errors=errors)
    return refs
