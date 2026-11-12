"""行业文档生成北向路由（/api/operation/solution-authoring）。

鉴权：读 / 建 / 上传 / 生成 / 编辑 / 处理敏感项 / 提交审核 → system_admin | system_operator；
审核通过 / 驳回 / 发布 → 仅 system_admin。响应统一 Envelope，错误统一 problem+json。
路由全部是同步函数（FastAPI 放进线程池执行）：解析资料与写目录都是阻塞操作。
"""

from __future__ import annotations

from uuid import UUID

from fastapi import (
    APIRouter,
    Depends,
    File,
    Header,
    Request,
    Response,
    UploadFile,
    status,
)

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import PlatformRole
from shared.contracts.envelope import Envelope, ListEnvelope

from .solution_authoring_dependencies import get_solution_authoring_service
from .solution_authoring_schemas import (
    DraftCreate,
    DraftDetailOut,
    DraftOut,
    FindingResolve,
    JobOut,
    PackageUpdate,
    ReviewNote,
    SourceOut,
)
from .solution_authoring_service import MAX_SOURCE_BYTES, SolutionAuthoringService

_OPERATOR_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]
_REVIEWER_ROLES = [PlatformRole.SYSTEM_ADMIN.value]

router = APIRouter(prefix="/api/operation/solution-authoring", tags=["operation-solution-authoring"])


def _operator(request: Request) -> TokenClaims:
    claims = require_claims(request.app.state._token_verifier)(request)
    authorize(claims, _OPERATOR_ROLES)
    return claims


def _reviewer(request: Request) -> TokenClaims:
    claims = require_claims(request.app.state._token_verifier)(request)
    authorize(claims, _REVIEWER_ROLES)
    return claims


# ---- 草稿 ----

@router.get(
    "/drafts", summary="列出方案草稿", operation_id="operation_solution_authoring_draft_list",
    description="列出未归档的行业方案草稿，按最近更新倒序。只含概要，不含正文。",
)
def list_drafts(
    _claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> ListEnvelope[DraftOut]:
    return ListEnvelope[DraftOut](data=service.list_drafts())


@router.post(
    "/drafts", summary="新建方案草稿", operation_id="operation_solution_authoring_draft_create",
    status_code=status.HTTP_201_CREATED,
    description="新建一个空草稿并选定生成用的平台模型与图片识别方式。模型必须已发布且有价格；选择多模态识别时模型必须支持图片输入。",
)
def create_draft(
    body: DraftCreate,
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftOut]:
    return Envelope[DraftOut](data=service.create_draft(claims.user_id, body))


@router.get(
    "/drafts/{draft_id}", summary="草稿详情", operation_id="operation_solution_authoring_draft_get",
    description="返回草稿正文、资料清单、被引用的来源片段、敏感项（仅脱敏片段）、最近一次生成任务与操作记录。",
)
def get_draft(
    draft_id: UUID,
    _claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    return Envelope[DraftDetailOut](data=service.get_draft(str(draft_id)))


@router.delete(
    "/drafts/{draft_id}", summary="归档草稿", operation_id="operation_solution_authoring_draft_archive",
    status_code=status.HTTP_204_NO_CONTENT,
    description="归档草稿并删除其资料原件。生成进行中不可归档；已审核通过或已发布的草稿只有 system_admin 能归档；已发布到目录的方案不受影响。",
)
def archive_draft(
    draft_id: UUID,
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Response:
    reviewer = PlatformRole.SYSTEM_ADMIN.value in claims.roles
    service.archive_draft(str(draft_id), claims.user_id, can_archive_reviewed=reviewer)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---- 资料 ----

@router.post(
    "/drafts/{draft_id}/sources", summary="上传资料", operation_id="operation_solution_authoring_source_upload",
    status_code=status.HTTP_201_CREATED,
    description=(
        "上传一份行业资料（multipart）。支持 txt / md / csv / html / docx / pptx / xlsx / pdf / png / jpg / webp；"
        "单文件不超过 20 MB，每个草稿最多 20 份、合计不超过 100 MB。上传时即完整解析，不支持或损坏的文件返回 422。"
    ),
)
def upload_source(
    draft_id: UUID,
    file: UploadFile = File(..., description="资料文件"),
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[SourceOut]:
    # 多读 1 字节用于判定超限；超限由服务层统一返回 413。
    data = file.file.read(MAX_SOURCE_BYTES + 1)
    return Envelope[SourceOut](data=service.add_source(str(draft_id), claims.user_id, file.filename, data))


@router.delete(
    "/drafts/{draft_id}/sources/{source_id}", summary="删除资料", operation_id="operation_solution_authoring_source_delete",
    status_code=status.HTTP_204_NO_CONTENT,
    description="从草稿中移除一份资料并删除原件。仅在草稿可编辑（未在生成 / 审核中）时可用。",
)
def delete_source(
    draft_id: UUID, source_id: UUID,
    _claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Response:
    service.remove_source(str(draft_id), str(source_id))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---- 生成 ----

@router.post(
    "/drafts/{draft_id}/generate", summary="发起生成", operation_id="operation_solution_authoring_generate",
    status_code=status.HTTP_202_ACCEPTED,
    description=(
        "把生成任务排入队列并立即返回；用任务状态接口轮询进度。同一 Idempotency-Key 重复请求返回同一个任务；"
        "草稿已有进行中的任务时返回 409。重新生成成功后会整体替换草稿正文与敏感项。"
    ),
)
def generate(
    draft_id: UUID,
    idempotency_key: str = Header(..., alias="Idempotency-Key", description="幂等键：同一次点击的重试使用同一个值"),
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[JobOut]:
    job, _created = service.request_generation(str(draft_id), claims.user_id, idempotency_key)
    return Envelope[JobOut](data=job)


@router.get(
    "/drafts/{draft_id}/jobs/{job_id}", summary="生成任务状态", operation_id="operation_solution_authoring_job_get",
    description="返回生成任务的阶段（queued / parsing / analyzing / succeeded / failed）、失败码与用量。",
)
def get_job(
    draft_id: UUID, job_id: UUID,
    _claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[JobOut]:
    return Envelope[JobOut](data=service.get_job(str(draft_id), str(job_id)))


# ---- 正文与敏感项 ----

@router.put(
    "/drafts/{draft_id}/package", summary="编辑草稿正文", operation_id="operation_solution_authoring_package_update",
    description="整体替换草稿正文并重新扫描敏感项。请求需带上所基于的草稿版本，版本不一致返回 409。",
)
def update_package(
    draft_id: UUID, body: PackageUpdate,
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    return Envelope[DraftDetailOut](data=service.update_package(str(draft_id), claims.user_id, body))


@router.post(
    "/drafts/{draft_id}/findings/{finding_id}/resolve", summary="处理敏感项",
    operation_id="operation_solution_authoring_finding_resolve",
    description="处理一条待处理的敏感项：脱敏替换、从正文删除、确认可公开，或（对不在正文中的提示项）确认已知悉。",
)
def resolve_finding(
    draft_id: UUID, finding_id: UUID, body: FindingResolve,
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    detail = service.resolve_finding(str(draft_id), str(finding_id), claims.user_id, body.resolution)
    return Envelope[DraftDetailOut](data=detail)


# ---- 审核与发布 ----

@router.post(
    "/drafts/{draft_id}/submit-review", summary="提交审核", operation_id="operation_solution_authoring_submit_review",
    description="把草稿提交给管理员审核。仍有待处理的敏感项时返回 409。",
)
def submit_review(
    draft_id: UUID,
    claims: TokenClaims = Depends(_operator), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    return Envelope[DraftDetailOut](data=service.submit_review(str(draft_id), claims.user_id))


@router.post(
    "/drafts/{draft_id}/approve", summary="审核通过", operation_id="operation_solution_authoring_approve",
    description="审核通过（仅 system_admin）。草稿必须处于审核中。",
)
def approve(
    draft_id: UUID, body: ReviewNote,
    claims: TokenClaims = Depends(_reviewer), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    return Envelope[DraftDetailOut](data=service.approve(str(draft_id), claims.user_id, body.note))


@router.post(
    "/drafts/{draft_id}/reject", summary="审核驳回", operation_id="operation_solution_authoring_reject",
    description="驳回审核中或已通过的草稿（仅 system_admin），必须填写理由。驳回后草稿可继续编辑并重新提交。",
)
def reject(
    draft_id: UUID, body: ReviewNote,
    claims: TokenClaims = Depends(_reviewer), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    return Envelope[DraftDetailOut](data=service.reject(str(draft_id), claims.user_id, body.note))


@router.post(
    "/drafts/{draft_id}/publish", summary="发布到目录", operation_id="operation_solution_authoring_publish",
    description=(
        "把已通过的草稿写入目录并发布（仅 system_admin）：每位专家注册为专家模板，方案注册为行业方案模板。"
        "中途失败可原样重试，不会重复注册。"
    ),
)
def publish(
    draft_id: UUID,
    claims: TokenClaims = Depends(_reviewer), service: SolutionAuthoringService = Depends(get_solution_authoring_service),
) -> Envelope[DraftDetailOut]:
    return Envelope[DraftDetailOut](data=service.publish(str(draft_id), claims.user_id))
