"""F03 目录发布通知收端（POST /api/manager/catalog/notify，Operator→Manager 云侧调用，05 §5.4）。

收 CatalogReleaseNotify → 记录目录变更事件。Manager 不持久化模板真相（真相归 Operator），
只据通知刷新/失效本端缓存的租户可见目录索引；Manager 亦可经 F06/F07 向 Operator 按需拉取最新数据。

鉴权：服务间调用（X-Service-Token，平面③ 代码层，03 §9.1）。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request, status

from shared.contracts.crosstier import CatalogReleaseNotify
from shared.contracts.envelope import Envelope
from shared.service_token import verify_service_token

logger = logging.getLogger(__name__)

router = APIRouter(tags=["manager", "control-plane"])


@router.post(
    "/api/manager/catalog/notify",
    summary="F03 目录发布通知——刷新 Manager 可见目录索引（Operator→Manager 云侧调用）",
    description="运营端Manager云侧调用：模板/方案发布、下架、可见范围变更通知。",
    operation_id="manager_catalog_notify",
    status_code=status.HTTP_200_OK,
)
def catalog_notify(
    body: CatalogReleaseNotify,
    request: Request,
    _svc=Depends(verify_service_token),
) -> Envelope[dict]:
    """接收目录变更通知并记录日志（Manager 按需拉取，不持久化模板真相）。

    当前实现：记录通知用于审计与缓存失效；租户侧可见目录由 F06/F07 拉取保证最终一致。
    """
    logger.info(
        "catalog notify: type=%s id=%s version=%s action=%s",
        body.catalog_type,
        body.template_id,
        body.version,
        body.action,
    )
    # 失效本端缓存的目录索引（如有）。Manager 真相来自 F06/F07 拉取，通知只是提前刷新的提示。
    catalog = getattr(request.app.state, "_operator_catalog", None)
    if catalog is not None and hasattr(catalog, "invalidate"):
        try:
            catalog.invalidate(body.catalog_type, body.template_id)
        except Exception:  # noqa: BLE001
            logger.debug("catalog cache invalidate skipped", exc_info=True)

    return Envelope[dict](
        data={"received": True, "template_id": body.template_id, "action": body.action}
    )
