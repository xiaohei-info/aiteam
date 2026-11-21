"""Operator platform skill market: ClawHub discovery and internal imports.

Design 2026-11-20 (企业端技能MCP新增与ClawHub打通) §4.2:
* packages carry any safe UTF-8 text (scripts, assets); binaries / platform hooks are skipped and reported;
* ClawHub `/verify` is an *integrity* check (identity + per-file sha256/size), not a security gate;
* the `/scan` result is shown side by side for both scanners and stored with the version, never blocking.

ClawHub calls are blocking HTTP, so those handlers are plain `def` (FastAPI runs them in the threadpool).
"""

from __future__ import annotations

import hashlib
import os
from typing import Literal

import httpx
from fastapi import APIRouter, Depends, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.datastructures import UploadFile

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.enums import PlatformRole
from shared.contracts.envelope import Envelope, ListEnvelope, Page
from shared.contracts.platform_skill import PlatformSkillPackage
from shared.contracts.skill import SkillFile, SkillPackage, derive_file_hash
from shared.errors import AppError, ValidationProblem
from shared.skill_import import MAX_ARCHIVE_ENTRIES
from shared.skill_sources import UPLOAD_SOURCES

from .platform_custom_skill import CustomSkillRequest, CustomSkillService
from .platform_skill_market import (
    REGISTRY_FILES,
    ClawHubClient,
    ParsedSkillArchive,
    PlatformSkillRepository,
    clawhub_url_parts,
    parse_skill_zip,
)

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


class SecurityScannerOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(description="扫描器名称（如 skillspector / llm）。")
    status: str = Field(description="该扫描器结论（clean / suspicious / pending …）。")
    verdict: str | None = Field(default=None, description="模型复核结论。")
    confidence: str | None = Field(default=None, description="置信度。")
    recommendation: str | None = Field(default=None, description="建议（如 DO_NOT_INSTALL）。")
    severity: str | None = Field(default=None, description="严重程度。")
    issue_count: int | None = Field(default=None, description="问题数。")


class SkillSecurityOut(BaseModel):
    """ClawHub 安全扫描结论：两个扫描器并列显示，只提示不拦截。"""

    model_config = ConfigDict(extra="forbid")
    status: str = Field(description="ClawHub 汇总状态。")
    has_warnings: bool = Field(default=False, description="是否有警告。")
    scanners: list[SecurityScannerOut] = Field(default_factory=list, description="各扫描器结论。")


class SkippedFileOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(description="被跳过的文件路径。")
    reason: str = Field(description="platform_hook（平台专用钩子）| binary（二进制）| unsupported_path（路径不支持）。")


class SkillFileSummaryOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(description="文件路径。")
    size: int = Field(ge=0, description="字节数。")


class ExternalSkillPreviewOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(description="外部技能发布者。")
    slug: str = Field(description="外部技能 slug。")
    display_name: str = Field(description="技能展示名称。")
    summary: str = Field(default="", description="技能摘要。")
    version: str = Field(description="将导入的版本。")
    canonical_url: str = Field(description="ClawHub 页面地址。")
    files: list[SkillFileSummaryOut] = Field(default_factory=list, description="将导入的文件。")
    total_bytes: int = Field(ge=0, description="将导入的文件总字节数。")
    skipped: list[SkippedFileOut] = Field(default_factory=list, description="被跳过的文件及原因。")
    security: SkillSecurityOut | None = Field(default=None, description="ClawHub 安全扫描结论；取不到时为空。")
    imported_version: str | None = Field(default=None, description="平台目录里已导入的最新版本。")


class ClawHubCandidateOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    owner: str = Field(description="发布者句柄。")
    slug: str = Field(description="技能 slug。")
    url: str = Field(description="ClawHub 页面地址。")


class ClawHubResolveOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    slug: str = Field(description="技能 slug。")
    owner: str | None = Field(default=None, description="唯一确定时的发布者；多个同名时为空，见 candidates。")
    candidates: list[ClawHubCandidateOut] = Field(default_factory=list, description="同名技能候选（地址未写作者时）。")


class PlatformSkillOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="平台技能 ID。")
    source: Literal["clawhub", "custom"] = Field(default="clawhub", description="clawhub 从 ClawHub 导入；custom 运营端自建（上传 / 粘贴 / 网址 / 在线编辑）。")
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
    security: SkillSecurityOut | None = Field(default=None, description="最新版本导入时的 ClawHub 安全扫描结论。")


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
    skipped: list[SkippedFileOut] = Field(default_factory=list, description="被跳过的文件及原因。")
    security: SkillSecurityOut | None = Field(default=None, description="ClawHub 安全扫描结论（只提示）。")


class CustomSkillJsonIn(BaseModel):
    """自建技能（JSON 来源：粘贴 SKILL.md / 网址）。文件夹、压缩包、单个 .md、在线编辑用 multipart 上传。"""

    model_config = ConfigDict(extra="forbid")
    source: Literal["text", "url"] = Field(description="text 粘贴 SKILL.md；url 公开 https 网址（GitHub / .zip / .md）。")
    text: str = Field(default="", max_length=1024 * 1024, description="source=text 时的 SKILL.md 内容。")
    url: str = Field(default="", max_length=2048, description="source=url 时的地址（仅 https）。")
    roots: list[str] | None = Field(default=None, max_length=MAX_ARCHIVE_ENTRIES, description="要保存的技能根目录（检查结果里的 root）；缺省保存全部可用技能。")
    expected_hashes: dict[str, str] | None = Field(default=None, max_length=MAX_ARCHIVE_ENTRIES, description="检查返回的 root → content_hash；带上时来源内容与检查结果不一致即 409 content_changed，需重新检查。网址来源建议总是带上。")


class CustomSkillOriginOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(description="来源种类：folder / zip / file / text / editor / url。")
    label: str = Field(description="给人看的来源说明。")
    url: str | None = Field(default=None, description="远程来源地址。")


class CustomSkillItemOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root: str = Field(description="包内技能根目录；包根本身是技能时为空串。")
    ok: bool = Field(description="是否可以保存；否时见 reason。")
    reason: str | None = Field(default=None, description="不能保存的原因。")
    name: str = Field(description="SKILL.md 的 name。")
    description: str = Field(description="SKILL.md 的 description。")
    version: str = Field(description="将写入的版本：frontmatter version，否则内容哈希前 12 位。")
    content_hash: str | None = Field(default=None, description="内容哈希；保存时放进 expected_hashes，确认保存的就是这次检查的内容。")
    file_count: int = Field(ge=0, description="将保存的文件数。")
    total_bytes: int = Field(ge=0, description="将保存的总字节数。")
    files: list[SkillFileSummaryOut] = Field(default_factory=list, description="将保存的文件。")
    skipped: list[SkippedFileOut] = Field(default_factory=list, description="被跳过的文件及原因。")
    existing: Literal["none", "same", "update"] = Field(description="平台里同名自建技能：none 没有；same 内容相同；update 内容不同（将成为新版本）。")
    existing_version: str | None = Field(default=None, description="已有的当前版本。")


class CustomSkillCheckOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: CustomSkillOriginOut = Field(description="来源。")
    preview: CustomSkillItemOut | None = Field(default=None, description="来源里只有一个技能时的预览。")
    scan: list[CustomSkillItemOut] | None = Field(default=None, description="来源里有多个技能时逐个列出。")


class CustomSkillResultOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    root: str = Field(description="包内技能根目录。")
    name: str = Field(description="技能名。")
    version: str = Field(description="写入或已有的版本。")
    status: Literal["installed", "updated", "duplicate", "failed"] = Field(description="installed 新增；updated 新版本；duplicate 内容相同；failed 见 reason。")
    reason: str | None = Field(default=None, description="失败或重复的原因。")
    skill_id: str | None = Field(default=None, description="平台技能 ID。")


class CustomSkillSaveOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: CustomSkillOriginOut = Field(description="来源。")
    results: list[CustomSkillResultOut] = Field(description="逐个技能的结果。")
    auto_publish: bool = Field(description="保存后是否已自动开放给企业（跟随「自动开放」开关）。")


class PlatformSkillFileOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(description="文件相对路径。")
    content: str = Field(description="文件内容（UTF-8 文本）。")


class PlatformSkillFilesOut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    skill_id: str = Field(description="平台技能 ID。")
    source: Literal["clawhub", "custom"] = Field(description="来源；只有 custom 可以在控制台编辑。")
    display_name: str = Field(description="技能名称。")
    summary: str = Field(default="", description="技能说明。")
    version: str | None = Field(default=None, description="当前（最新导入）版本。")
    files: list[PlatformSkillFileOut] = Field(description="当前版本的全部文件。")


_CUSTOM_BODY = {
    "requestBody": {
        "required": True,
        "description": "JSON（text / url）或 multipart/form-data（folder / zip / file / editor：files + 一一对应的 paths，可选 roots）；技能包最多 256 个文件、共 10 MiB。",
        "content": {
            "application/json": {"schema": CustomSkillJsonIn.model_json_schema()},
            "multipart/form-data": {"schema": {
                "type": "object", "required": ["source", "files"],
                "properties": {
                    "source": {"type": "string", "enum": list(UPLOAD_SOURCES)},
                    "files": {"type": "array", "items": {"type": "string", "format": "binary"}},
                    "paths": {"type": "array", "items": {"type": "string"}},
                    "roots": {"type": "array", "items": {"type": "string"}},
                },
            }},
        },
    },
}


def verified_artifact(verification: dict, *, owner: str, slug: str, version: str) -> dict[str, tuple[str, int]]:
    """Expected `{path: (sha256, size)}` from ClawHub `/verify`. Integrity only — security is not consulted."""
    identity_matches = (
        str(verification.get("publisherHandle") or "").lower() == owner.lower()
        and verification.get("slug") == slug
        and verification.get("version") == version
    )
    if not identity_matches:
        raise ValidationProblem("ClawHub 校验信息与所选技能（作者 / 标识 / 版本）不一致，已停止导入")
    expected: dict[str, tuple[str, int]] = {}
    for item in (verification.get("artifact") or {}).get("files") or []:
        path = str(item.get("path") or "")
        if path and path not in REGISTRY_FILES:
            expected[path] = (str(item.get("sha256") or ""), int(item.get("size") or 0))
    if "SKILL.md" not in expected:
        raise ValidationProblem("ClawHub 没有返回该版本的文件清单，暂时无法校验完整性，请稍后再试")
    return expected


def check_integrity(parsed: ParsedSkillArchive, expected: dict[str, tuple[str, int]]) -> None:
    """Every kept file must match the verified sha256/size; every verified file must be kept or reported skipped."""
    for item in parsed.files:
        data = item["content"].encode("utf-8")
        if expected.get(item["path"]) != (hashlib.sha256(data).hexdigest(), len(data)):
            raise ValidationProblem(f"下载的文件与 ClawHub 校验清单不一致：{item['path']}")
    accounted = {item["path"] for item in parsed.files} | {item.path for item in parsed.skipped}
    missing = sorted(set(expected) - accounted)
    if missing:
        raise ValidationProblem(f"下载的技能包缺少 ClawHub 校验清单里的文件：{'、'.join(missing[:5])}")


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
    dsn = request.app.state.settings.db_url
    if not dsn:
        raise _OperatorSkillStoreUnavailable("Operator DB is not configured")
    repo = PlatformSkillRepository(dsn)
    request.app.state._platform_skill_repository = repo
    return repo


def _client(request: Request) -> ClawHubClient:
    client = getattr(request.app.state, "_clawhub_client", None)
    if client is None:
        # Tests and private mirrors may point at another ClawHub-compatible origin.
        client = ClawHubClient(os.environ.get("AITEAM_CLAWHUB_BASE_URL") or "https://clawhub.ai")
        request.app.state._clawhub_client = client
    return client


# 自建技能上传 / 粘贴的请求体上限：技能包 10 MiB + multipart 开销，与企业端导入一致（app 以 BodyLimit 在读体前拦截）。
CUSTOM_SKILL_MAX_BODY_BYTES = 12 * 1024 * 1024


def _custom_service(request: Request) -> CustomSkillService:
    service = getattr(request.app.state, "_custom_skill_service", None)
    return service if service is not None else CustomSkillService(_repo(request))


async def _read_custom(request: Request) -> CustomSkillRequest:
    """multipart（上传 / 在线编辑）或 JSON（粘贴 / 网址）→ 统一的自建技能请求。"""
    try:
        if request.headers.get("content-type", "").startswith("multipart/form-data"):
            form = await request.form(max_files=MAX_ARCHIVE_ENTRIES, max_fields=MAX_ARCHIVE_ENTRIES * 2 + 16)
            source = str(form.get("source") or "")
            if source not in UPLOAD_SOURCES:
                raise ValidationProblem("multipart 只用于 folder / zip / file / editor 来源")
            uploads = [item for item in form.getlist("files") if isinstance(item, UploadFile)]
            paths = [str(item) for item in form.getlist("paths")]
            if paths and len(paths) != len(uploads):
                raise ValidationProblem("paths 必须与 files 一一对应")
            roots = [str(item) for item in form.getlist("roots")]
            entries = [(paths[i] if paths else (upload.filename or ""), await upload.read()) for i, upload in enumerate(uploads)]
            return CustomSkillRequest(source=source, entries=entries, roots=roots or None)
        body = CustomSkillJsonIn.model_validate(await request.json())
    except ValidationError as exc:
        raise ValidationProblem("请求格式不对：" + "; ".join(err["msg"] for err in exc.errors()[:3])) from exc
    except ValueError as exc:  # malformed JSON / multipart
        raise ValidationProblem("请求体无法解析") from exc
    return CustomSkillRequest(source=body.source, text=body.text, url=body.url, roots=body.roots,
                              expected_hashes=body.expected_hashes)


def _upstream_error(exc: Exception, what: str) -> AppError:
    if isinstance(exc, httpx.HTTPStatusError):
        return _ClawHubUnavailable(f"{what}：ClawHub 返回 HTTP {exc.response.status_code}")
    if isinstance(exc, httpx.TimeoutException):
        return _ClawHubUnavailable(f"{what}：连接 ClawHub 超时")
    return _ClawHubUnavailable(f"{what}：连不上 ClawHub")


def _fetch_verified(client: ClawHubClient, *, owner: str, slug: str, version: str | None) -> tuple[dict, str, ParsedSkillArchive, dict | None]:
    detail = client.detail(owner=owner, slug=slug)
    chosen = version or (detail.get("latestVersion") or {}).get("version")
    if not chosen:
        raise ValidationProblem("ClawHub 上这个技能还没有可下载的版本")
    expected = verified_artifact(client.verify(owner=owner, slug=slug, version=chosen), owner=owner, slug=slug, version=chosen)
    parsed = parse_skill_zip(client.download(owner=owner, slug=slug, version=chosen))
    check_integrity(parsed, expected)
    return detail, chosen, parsed, client.scan(owner=owner, slug=slug, version=chosen)


def _skipped(parsed: ParsedSkillArchive) -> list[SkippedFileOut]:
    return [SkippedFileOut(path=item.path, reason=item.reason) for item in parsed.skipped]


@router.get("/external", summary="浏览外部技能市场", description="从 ClawHub 检索或分页浏览技能；不按扫描结论过滤，结论在预览里查看。", operation_id="operation_skill_market_external_list", response_model_exclude_none=True)
def browse_external(
    request: Request,
    q: str | None = Query(default=None, description="外部技能搜索关键词。"),
    cursor: str | None = Query(default=None, description="外部市场分页游标。"),
    limit: int = Query(default=20, ge=1, le=100, description="返回条数上限。"),
    claims: TokenClaims = Depends(_claims),
) -> ListEnvelope[ExternalSkillOut]:
    del claims
    client = _client(request)
    try:
        if q and q.strip():
            return ListEnvelope(data=[ExternalSkillOut.model_validate(item.__dict__) for item in client.search(q.strip(), limit=limit)])
        items, next_cursor = client.browse(cursor=cursor, limit=limit)
        return ListEnvelope(data=[ExternalSkillOut.model_validate(item.__dict__) for item in items], page=Page(next_cursor=next_cursor, has_more=bool(next_cursor)))
    except AppError:
        raise
    except Exception as exc:
        raise _upstream_error(exc, "ClawHub 列表读取失败") from exc


@router.get("/external/resolve", summary="解析 ClawHub 技能地址", description="把 ClawHub 技能页地址解析为作者与标识；地址没写作者时返回同名候选。", operation_id="operation_skill_market_external_resolve")
def resolve_external(
    request: Request,
    url: str = Query(min_length=1, max_length=2048, description="ClawHub 技能页地址，例如 https://clawhub.ai/作者/skills/标识。"),
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[ClawHubResolveOut]:
    client = _client(request)
    parts = clawhub_url_parts(url, base_url=client.base_url)
    if parts is None:
        raise ValidationProblem("不是 ClawHub 技能页地址：应为 https://clawhub.ai/作者/skills/标识")
    owner, slug = parts
    if owner:
        return Envelope(data=ClawHubResolveOut(slug=slug, owner=owner))
    try:
        candidates = client.candidates(slug)
    except AppError:
        raise
    except Exception as exc:
        raise _upstream_error(exc, "ClawHub 同名技能查询失败") from exc
    if not candidates:
        raise ValidationProblem(f"ClawHub 上找不到技能：{slug}")
    only = candidates[0]["owner"] if len(candidates) == 1 else None
    return Envelope(data=ClawHubResolveOut(slug=slug, owner=only, candidates=[ClawHubCandidateOut(**item) for item in candidates]))


@router.get("/external/{owner}/{slug}/preview", summary="预览外部技能", description="下载并校验完整性后返回将导入的文件、被跳过的文件与安全扫描结论；不写库。", operation_id="operation_skill_market_external_preview")
def preview_external(
    owner: str,
    slug: str,
    request: Request,
    version: str | None = Query(default=None, description="要预览的版本；缺省为最新版本。"),
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[ExternalSkillPreviewOut]:
    client = _client(request)
    try:
        detail, chosen, parsed, security = _fetch_verified(client, owner=owner, slug=slug, version=version)
    except AppError:
        raise
    except Exception as exc:
        raise _upstream_error(exc, "ClawHub 技能预览失败") from exc
    imported = next((row for row in _repo(request).list_internal() if row["owner"] == owner and row["slug"] == slug), None)
    skill = detail.get("skill") or {}
    files = [SkillFileSummaryOut(path=item["path"], size=len(item["content"].encode("utf-8"))) for item in parsed.files]
    return Envelope(data=ExternalSkillPreviewOut(
        owner=owner, slug=slug, display_name=str(skill.get("displayName") or slug), summary=str(skill.get("summary") or ""),
        version=chosen, canonical_url=f"{client.base_url}/{owner}/skills/{slug}",
        files=files, total_bytes=sum(item.size for item in files), skipped=_skipped(parsed),
        security=SkillSecurityOut.model_validate(security) if security else None,
        imported_version=imported["latest_internal_version"] if imported else None,
    ))


@router.get("/internal", summary="列出平台技能目录", description="列出已导入 Operator 平台目录的技能及其发布状态。", operation_id="operation_skill_market_internal_list")
def list_internal(
    request: Request,
    _claims: TokenClaims = Depends(_claims),
) -> ListEnvelope[PlatformSkillOut]:
    return ListEnvelope(data=[PlatformSkillOut(**item) for item in _repo(request).list_internal()])


@router.get("/settings", summary="读取技能市场设置", description="读取外部技能下载后的自动发布开关。", operation_id="operation_skill_market_settings_get")
def get_settings(
    request: Request,
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[SkillMarketSettingsOut]:
    return Envelope(data=SkillMarketSettingsOut(auto_publish_downloads=_repo(request).get_setting()))


@router.put("/settings", summary="更新技能市场设置", description="更新外部技能下载后的自动发布策略。", operation_id="operation_skill_market_settings_update")
def set_settings(
    request: Request,
    body: SkillMarketSettingsIn,
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[SkillMarketSettingsOut]:
    return Envelope(data=SkillMarketSettingsOut(auto_publish_downloads=_repo(request).set_setting(body.auto_publish_downloads)))


@router.post("/external/{owner}/{slug}/download", summary="导入外部技能", description="校验 ClawHub 文件清单完整性后下载并导入平台目录；安全扫描结论只记录与提示，不拦截。", operation_id="operation_skill_market_external_download")
def download_external(
    owner: str,
    slug: str,
    request: Request,
    version: str | None = Query(default=None, description="要导入的技能版本；缺省使用最新版本。"),
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[PlatformSkillImportOut]:
    client = _client(request)
    repo = _repo(request)
    try:
        detail, chosen, parsed, security = _fetch_verified(client, owner=owner, slug=slug, version=version)
    except AppError:
        raise
    except Exception as exc:
        raise _upstream_error(exc, "ClawHub 技能下载失败") from exc
    skill = detail.get("skill") or {}
    imported = repo.upsert_download(
        owner=owner, slug=slug, display_name=str(skill.get("displayName") or slug), summary=str(skill.get("summary") or ""),
        version=chosen, files=parsed.files, content_hash=parsed.content_hash,
        security=security or {}, auto_publish=repo.get_setting(),
        source_url=f"{client.base_url}/{owner}/skills/{slug}",
    )
    return Envelope(data=PlatformSkillImportOut(
        **imported, skipped=_skipped(parsed),
        security=SkillSecurityOut.model_validate(security) if security else None,
    ))


@router.post("/custom/preview", summary="检查自建技能", description="从上传的文件夹 / 压缩包 / .md、粘贴的 SKILL.md、公开 https 网址或在线编辑的文件读取技能，校验后返回将保存的文件、跳过的文件与同名情况；不写库。", operation_id="operation_skill_market_custom_preview", openapi_extra=_CUSTOM_BODY, response_model_exclude_none=True)
async def preview_custom(request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[CustomSkillCheckOut]:
    req = await _read_custom(request)
    data = await run_in_threadpool(_custom_service(request).preview, req)
    return Envelope(data=CustomSkillCheckOut.model_validate(data))


@router.post("/custom", summary="保存自建技能", description="把检查过的技能存入平台目录：新名称新建平台技能；同名内容不同成为新版本（企业端显示可更新）；内容相同记为重复。是否自动开放跟随「自动开放」开关。", operation_id="operation_skill_market_custom_save", openapi_extra=_CUSTOM_BODY, response_model_exclude_none=True)
async def save_custom(request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[CustomSkillSaveOut]:
    req = await _read_custom(request)
    data = await run_in_threadpool(_custom_service(request).save, req)
    return Envelope(data=CustomSkillSaveOut.model_validate(data))


@router.get("/internal/{skill_id}/files", summary="读取平台技能文件", description="返回平台技能当前版本的全部文件，用于查看或编辑（只有自建技能可以编辑）。", operation_id="operation_skill_market_internal_files")
def internal_files(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformSkillFilesOut]:
    return Envelope(data=PlatformSkillFilesOut.model_validate(_repo(request).get_latest_files(skill_id=skill_id)))


@router.post("/internal/{skill_id}/publish", summary="发布平台技能", description="发布指定版本的平台技能，使 Manager 可以拉取。", operation_id="operation_skill_market_internal_publish")
def publish_internal(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformSkillOut]:
    return Envelope(data=_repo(request).set_status(skill_id=skill_id, status="published"))


@router.post("/internal/{skill_id}/unpublish", summary="下架平台技能", description="下架指定平台技能，阻止新的 Manager 拉取。", operation_id="operation_skill_market_internal_unpublish")
def unpublish_internal(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[PlatformSkillOut]:
    return Envelope(data=_repo(request).set_status(skill_id=skill_id, status="unpublished"))


@router.get("/pull/skills", summary="拉取已发布技能目录", description="供 Manager 服务间调用，返回已发布的平台技能摘要。", operation_id="operation_skill_market_pull_list")
def pull_published_skills(request: Request) -> ListEnvelope[PlatformSkillOut]:
    _service_token(request)
    return ListEnvelope(data=[PlatformSkillOut(**item) for item in _repo(request).list_internal(status="published")])


@router.get("/pull/skills/{skill_id}/versions/{version}", summary="拉取固定版本技能包", description="供 Manager 服务间调用，返回已发布技能的固定版本和签名材料。", operation_id="operation_skill_market_pull_package")
def pull_published_skill_package(skill_id: str, version: str, request: Request) -> Envelope[PlatformSkillPackage]:
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
