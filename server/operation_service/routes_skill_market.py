"""Operator platform skill market: ClawHub discovery and internal imports."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, ConfigDict

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
    auto_publish_downloads: bool


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


@router.get("/external")
async def browse_external(
    request: Request,
    q: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=20, ge=1, le=100),
    claims: TokenClaims = Depends(_claims),
) -> dict:
    del claims
    client = _client(request)
    try:
        if q and q.strip():
            return {"data": [item.__dict__ for item in client.search(q.strip(), limit=limit)]}
        items, next_cursor = client.browse(cursor=cursor, limit=limit)
        return {"data": [item.__dict__ for item in items], "next_cursor": next_cursor}
    except AppError:
        raise
    except Exception as exc:
        raise _ClawHubUnavailable("ClawHub is unavailable") from exc


@router.get("/internal")
async def list_internal(
    request: Request,
    _claims: TokenClaims = Depends(_claims),
) -> ListEnvelope[dict]:
    return ListEnvelope(data=_repo(request).list_internal())


@router.get("/settings")
async def get_settings(
    request: Request,
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[dict]:
    return Envelope(data={"auto_publish_downloads": _repo(request).get_setting()})


@router.put("/settings")
async def set_settings(
    request: Request,
    body: SkillMarketSettingsIn,
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[dict]:
    return Envelope(data={"auto_publish_downloads": _repo(request).set_setting(body.auto_publish_downloads)})


@router.post("/external/{owner}/{slug}/download")
async def download_external(
    owner: str,
    slug: str,
    request: Request,
    version: str | None = Query(default=None),
    _claims: TokenClaims = Depends(_claims),
) -> Envelope[dict]:
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


@router.post("/internal/{skill_id}/publish")
async def publish_internal(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[dict]:
    return Envelope(data=_repo(request).set_status(skill_id=skill_id, status="published"))


@router.post("/internal/{skill_id}/unpublish")
async def unpublish_internal(skill_id: str, request: Request, _claims: TokenClaims = Depends(_claims)) -> Envelope[dict]:
    return Envelope(data=_repo(request).set_status(skill_id=skill_id, status="unpublished"))


@router.get("/pull/skills")
async def pull_published_skills(request: Request) -> ListEnvelope[dict]:
    _service_token(request)
    return ListEnvelope(data=_repo(request).list_internal(status="published"))


@router.get("/pull/skills/{skill_id}/versions/{version}")
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
