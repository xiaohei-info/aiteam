"""Operator platform skill market: ClawHub discovery and internal imports."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict, Field

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope, ListEnvelope
from shared.contracts.enums import PlatformRole
from shared.contracts.platform_skill import PlatformSkillPackage
from shared.contracts.skill import SkillFile, SkillPackage, derive_file_hash
from shared.errors import AppError, NotFound, ValidationProblem

from .platform_skill_market import ClawHubClient, PlatformSkillRepository, parse_skill_zip

router = APIRouter(prefix="/api/operation/skill-market", tags=["operation", "skill-market"])


class _OperatorSkillStoreUnavailable(AppError):
    status, code, title = 503, "operator_skill_store_unavailable", "Operator skill store unavailable"


class _ClawHubUnavailable(AppError):
    status, code, title = 503, "clawhub_unavailable", "ClawHub unavailable"


class SkillMarketSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    auto_publish_downloads: bool = Field(description="下载后的外部技能是否自动发布到平台目录。")


class SkillMarketSettingsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    auto_publish_downloads: bool = Field(description="下载后的外部技能是否自动发布。")


class ExternalSkillOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(description="外部技能发布者句柄。")
    slug: str = Field(description="外部技能 slug。")
    display_name: str = Field(description="技能展示名称。")
    summary: str = Field(description="外部技能摘要。")
    version: str | None = Field(default=None, description="当前版本。")
    latest_version: str | None = Field(default=None, description="最新可用版本。")
    updated_at: int | None = Field(default=None, description="外部市场更新时间（Unix 秒）。")
    downloads: int = Field(default=0, ge=0, description="外部市场下载次数。")
    canonical_url: str = Field(default="", description="外部技能规范 URL。")
    security_ok: bool | None = Field(default=None, description="外部安全检查结果。")


class ExternalSkillBrowseOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    data: list[ExternalSkillOut] = Field(default_factory=list, description="外部技能结果列表。")
    next_cursor: str | None = Field(default=None, description="下一页游标。")


class PlatformSkillOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="平台技能 ID。")
    owner: str = Field(default="", description="技能发布者。")
    slug: str = Field(default="", description="技能 slug。")
    display_name: str = Field(default="", description="技能展示名称。")
    summary: str = Field(default="", description="技能摘要。")
    latest_external_version: str | None = Field(default=None, description="外部市场最新版本。")
    latest_internal_version: str | None = Field(default=None, description="平台导入的最新版本。")
    published_version: str | None = Field(default=None, description="当前发布版本。")
    status: str = Field(default="", description="平台技能状态。")
    latest_content_hash: str | None = Field(default=None, description="最新版本内容哈希。")
    content_hash: str | None = Field(default=None, description="当前发布版本内容哈希。")
    latest_version_status: str | None = Field(default=None, description="最新版本状态。")
    version_id: str | None = Field(default=None, description="导入版本 ID。")
    version: str | None = Field(default=None, description="导入版本号。")


class PlatformSkillImportOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="平台技能 ID。")
    version_id: str = Field(description="导入版本 ID。")
    owner: str = Field(description="外部技能发布者。")
    slug: str = Field(description="外部技能 slug。")
    display_name: str = Field(description="技能展示名称。")
    summary: str = Field(default="", description="技能摘要。")
    version: str = Field(description="导入版本。")
    content_hash: str = Field(description="技能内容哈希。")
    status: str = Field(description="导入后的发布状态。")


def _verified_text_manifest(verification: dict, *, owner: str, slug: str, version: str) -> set[tuple[object, object, object]]:
    identity_matches = (
        verification.get("publisherHandle", "").lower() == owner.lower()
        and verification.get("slug") == slug
        and verification.get("version") == version
    )
    security_passed = bool((verification.get("security") or {}).get("passed"))
    reasons = set(verification.get("reasons") or [])
    card_only_pending = not verification.get("ok") and reasons == {"card.missing"}
    if not identity_matches or not security_passed or (not verification.get("ok") and not card_only_pending):
        raise ValidationProblem("ClawHub skill version did not pass exact security verification")

    expected_files = (verification.get("artifact") or {}).get("files", [])
    allowed_registry_files = {"_meta.json", "skill-card.md"}
    if any(
        item.get("path") not in allowed_registry_files
        and item.get("path") != "SKILL.md"
        and not (str(item.get("path") or "").startswith("references/") and str(item.get("path") or "").endswith(".md"))
        for item in expected_files
    ):
        raise ValidationProblem("该技能包含脚本或资源文件，当前仅支持 SKILL.md 和 references/*.md 纯文本技能")
    return {
        (item.get("path"), item.get("sha256"), item.get("size"))
        for item in expected_files
        if item.get("path") == "SKILL.md" or (str(item.get("path") or "").startswith("references/") and str(item.get("path") or "").endswith(".md"))
    }


def _claims(request: Request) -> TokenClaims:
    claims = require_claims(request.app.state._token_verifier)(request)
    authorize(claims, [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value])
    return claims


def _service_token(request: Request) -> None:
    from shared.service_token import verify_service_token
    verify_service_token(request)


def _repo(request: Request) -> PlatformSkillRepository:
    injected = getattr(request.app.state, "_platform_skill_repository", None)
    if injected is not None:
        return injected
    dsn = request.app.state.settings.admin_db_url
    if not dsn:
        raise _OperatorSkillStoreUnavailable("Operator DB is not configured")
    repo = PlatformSkillRepository(dsn)
    request.app.state._platform_skill_repository = repo
    return repo


def _client(request: Request) -> ClawHubClient:
    client = getattr(request.app.state, "_clawhub_client", None)
    if client is None:
        client = ClawHubClient()
        request.app.state._clawhub_client = client
    return client


@router.get("/external", summary="浏览外部技能市场", description="从外部技能市场检索或分页浏览可导入的纯文本技能。", operation_id="operation_skill_market_external_list", response_model_exclude_none=True)
async def browse_external(
    request: Request,
    q: str | None = Query(default=None, description="外部技能搜索关键词。"),
    cursor: str | None = Query(default=None, description="外部市场分页游标。"),
    limit: int = Query(default=20, ge=1, le=100, description="返回条数上限。"),
    claims: TokenClaims = Depends(_claims),
) -> ExternalSkillBrowseOut:
    del claims
    client = _client(request)
    try:
        if q and q.strip():
            return ExternalSkillBrowseOut(data=[ExternalSkillOut.model_validate(item.__dict__) for item in client.search(q.strip(), limit=limit)])
        items, next_cursor = client.browse(cursor=cursor, limit=limit)
        return ExternalSkillBrowseOut(data=[ExternalSkillOut.model_validate(item.__dict__) for item in items], next_cursor=next_cursor)
    except AppError:
        raise
    except Exception as exc:
        raise _ClawHubUnavailable("ClawHub is unavailable") from exc


@router.get("/internal", summary="列出平台技能目录", description="列出已导入 Operator 平台目录的技能及其发布状态。", operation_id="operation_skill_market_internal_list")
async def list_internal(
    request: Request,
    _claims: TokenClaims = Depends(_claims),
) -> ListEnvelope[PlatformSkillOut]:
    return ListEnvelope(data=[PlatformSkillOut(**item) for item in _repo(request).list_internal()])


@router.get("/settings", summary="读取技能市场设置", description="读取外部技能下载后的自动发布开关。", operation_id="operation_skill_market_settings_get")
async def get_settings(
    request: Request,
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[SkillMarketSettingsOut]:
    return Envelope(data=SkillMarketSettingsOut(auto_publish_downloads=_repo(request).get_setting()))


@router.put("/settings", summary="更新技能市场设置", description="更新外部技能下载后的自动发布策略。", operation_id="operation_skill_market_settings_update")
async def set_settings(
    request: Request,
    body: SkillMarketSettingsIn,
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[SkillMarketSettingsOut]:
    return Envelope(data=SkillMarketSettingsOut(auto_publish_downloads=_repo(request).set_setting(body.auto_publish_downloads)))


@router.post("/external/{owner}/{slug}/download", summary="导入外部技能", description="校验外部技能安全清单后下载并导入平台目录。", operation_id="operation_skill_market_external_download")
async def download_external(
    owner: str,
    slug: str,
    request: Request,
    version: str | None = Query(default=None, description="要导入的技能版本；缺省使用最新版本。"),
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[PlatformSkillImportOut]:
    client = _client(request)
    repo = _repo(request)
    try:
        detail = client.detail(owner=owner, slug=slug)
        latest = (detail.get("latestVersion") or {}).get("version")
        chosen = version or latest
        if not chosen:
            raise ValidationProblem("ClawHub skill has no downloadable version")
        verification = client.verify(owner=owner, slug=slug, version=chosen)
        expected = _verified_text_manifest(verification, owner=owner, slug=slug, version=chosen)
        raw = client.download(owner=owner, slug=slug, version=chosen)
        files, content_hash = parse_skill_zip(raw)
        actual = {(item["path"], __import__("hashlib").sha256(item["content"].encode()).hexdigest(), len(item["content"].encode())) for item in files}
        if not expected or actual != expected:
            raise ValidationProblem("downloaded skill files do not match ClawHub verified artifact")
        package = {
            "skill_id": f"clawhub-{owner}-{slug}".replace("/", "-"),
            "version": chosen,
            "content_hash": content_hash,
            "display_name": detail.get("skill", {}).get("displayName") or slug,
            "description": detail.get("skill", {}).get("summary") or "",
            "files": [
                {"path": f["path"], "content": f["content"], "content_hash": __import__("hashlib").sha256(f["content"].encode()).hexdigest()[:16]}
                for f in files
            ],
        }
        auto_publish = repo.get_setting()
        return Envelope(data=repo.upsert_download(
            owner=owner, slug=slug, display_name=package["display_name"], summary=package["description"],
            version=chosen, files=files, content_hash=content_hash,
            security=verification.get("security") or {}, auto_publish=auto_publish,
            source_url=verification.get("pageUrl") or f"https://clawhub.ai/{owner}/skills/{slug}",
        ))
    except (ValidationProblem, NotFound):
        raise
    except Exception as exc:
        raise _ClawHubUnavailable("ClawHub skill download failed") from exc


@router.post("/internal/{skill_id}/publish", summary="发布平台技能", description="发布指定版本的平台技能，使 Manager 可以拉取。", operation_id="operation_skill_market_internal_publish")
async def publish_internal(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformSkillOut]:
    return Envelope(data=_repo(request).set_status(skill_id=skill_id, status="published"))


@router.post("/internal/{skill_id}/unpublish", summary="下架平台技能", description="下架指定平台技能，阻止新的 Manager 拉取。", operation_id="operation_skill_market_internal_unpublish")
async def unpublish_internal(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformSkillOut]:
    return Envelope(data=_repo(request).set_status(skill_id=skill_id, status="unpublished"))


@router.get("/pull/skills", summary="拉取已发布技能目录", description="供 Manager 服务间调用，返回已发布的平台技能摘要。", operation_id="operation_skill_market_pull_list")
async def pull_published_skills(request: Request) -> ListEnvelope[PlatformSkillOut]:
    _service_token(request)
    return ListEnvelope(data=[PlatformSkillOut(**item) for item in _repo(request).list_internal(status="published")])


@router.get("/pull/skills/{skill_id}/versions/{version}", summary="拉取固定版本技能包", description="供 Manager 服务间调用，返回已发布技能的固定版本和签名材料。", operation_id="operation_skill_market_pull_package")
async def pull_published_skill_package(skill_id: str, version: str, request: Request) -> Envelope[PlatformSkillPackage]:
    _service_token(request)
    row = _repo(request).get_package(skill_id=skill_id, version=version, published_only=True)
    files = [
        SkillFile(path=item["path"], content=item["content"], content_hash=derive_file_hash(item["content"]))
        for item in row["files"]
    ]
    package = SkillPackage(
        skill_id=skill_id,
        version=version,
        content_hash=row["content_hash"],
        display_name=row["display_name"],
        description=row["summary"],
        files=files,
    )
    package.validate_package()
    return Envelope(data=PlatformSkillPackage(owner=row["owner"], slug=row["slug"], source_url=row["source_url"], package=package))
