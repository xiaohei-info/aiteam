"""B02 技能市场 — 外部技能市场（SkillHub/ClawHub）目录客户端。

PRD B02 要求：市场数据调用 ClawHub API 拉取技能列表（定时缓存，每 10min 刷新）。

实现口径：
- 主源用腾讯 SkillHub（``https://api.skillhub.cn``，等价于 api.skillhub.tencent.com），
  ClawHub 的国内高速镜像。公开搜索端点 ``GET /api/v1/search?q=<query>``（无需认证），
  空 query 返回默认目录。
- 失败回退到 ClawHub 官方源（``https://clawhub.ai/api/v1/skills``）。
- 两者都失败时调用方自行降级到内置 builtin 目录（不抛异常）。

仅做"市场浏览入口"，技能执行/安装落地由 Hermes profile + skills runtime 承接，
本模块不触碰运行时（见 业务解决方案设计 §5.2-G）。
"""
from __future__ import annotations

import json
import logging
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

logger = logging.getLogger(__name__)

# 主源 = 腾讯 SkillHub 国内镜像（公开搜索端点）；备源 = ClawHub 官方。可用环境变量覆盖。
SKILLHUB_BASE = os.getenv("AITEAM_SKILLHUB_BASE", "https://api.skillhub.cn").rstrip("/")
CLAWHUB_BASE = os.getenv("AITEAM_CLAWHUB_BASE", "https://clawhub.ai/api/v1").rstrip("/")
SKILL_MARKET_SOURCE = os.getenv("AITEAM_SKILL_MARKET_SOURCE", "skillhub").strip() or "skillhub"

_HTTP_TIMEOUT = int(os.getenv("AITEAM_SKILL_MARKET_TIMEOUT", "10"))
_CACHE_TTL = int(os.getenv("AITEAM_SKILL_MARKET_CACHE_TTL", "600"))  # 10min per PRD
_FETCH_LIMIT = int(os.getenv("AITEAM_SKILL_MARKET_LIMIT", "60"))

# key -> (expires_at_epoch, payload). Module-level, process-scoped — good enough
# for a single-process demo server; no cross-process coherence needed.
_cache: dict[str, tuple[float, list[dict]]] = {}


def _cache_get(key: str) -> list[dict] | None:
    entry = _cache.get(key)
    if entry is None:
        return None
    expires_at, payload = entry
    if time.time() >= expires_at:
        _cache.pop(key, None)
        return None
    return payload


def _cache_set(key: str, payload: list[dict]) -> None:
    _cache[key] = (time.time() + _CACHE_TTL, payload)


def _normalize_tags(tags) -> list[str]:
    if isinstance(tags, list):
        return [str(t) for t in tags]
    if isinstance(tags, dict):
        return [str(k) for k in tags if str(k) != "latest"]
    return []


def _resolve_latest_version(item: dict) -> str:
    latest = item.get("latestVersion")
    if isinstance(latest, dict):
        v = latest.get("version")
        if isinstance(v, str) and v:
            return v
    if isinstance(latest, str) and latest:
        return latest
    tags = item.get("tags")
    if isinstance(tags, dict):
        tag = tags.get("latest")
        if isinstance(tag, str) and tag:
            return tag
    return str(item.get("version") or "1.0.0")


def _item_to_entry(item: dict, source: str) -> dict | None:
    """Map an external skill payload into AI Team's catalog entry shape.

    Handles both SkillHub search results (rich fields incl. description_zh,
    installs, category) and ClawHub listing items (slug/displayName/summary).
    """
    slug = item.get("slug") or item.get("name")
    if not isinstance(slug, str) or not slug.strip():
        return None
    slug = slug.strip()
    version = _resolve_latest_version(item)
    # Prefer Chinese description when SkillHub provides it (localized mirror).
    description = (
        item.get("description_zh")
        or item.get("summary")
        or item.get("description")
        or ""
    )
    tags = _normalize_tags(item.get("tags", [])) or _normalize_tags(item.get("labels", []))
    return {
        "skill_code": slug,
        "display_name": item.get("displayName") or item.get("name") or slug,
        "description": description,
        "source_marketplace": source,
        "version": version,
        "latest_version": version,
        "tags": tags,
        "is_free": bool(item.get("isFree", item.get("is_free", True))),
        "category": str(item.get("category") or ""),
        "install_count": int(item.get("installs") or item.get("downloads") or 0),
        "icon_url": str(item.get("icon_url") or ""),
    }


def _http_get_json(url: str):
    req = Request(url, headers={"Accept": "application/json", "User-Agent": "ai-team-skill-market/1.0"})
    with urlopen(req, timeout=_HTTP_TIMEOUT) as resp:  # noqa: S310 — fixed https hosts
        if resp.status != 200:
            return None
        return json.loads(resp.read().decode("utf-8"))


def _fetch_skillhub(query: str) -> list[dict]:
    """SkillHub public search endpoint: GET /api/v1/search?q=<query>.

    Empty query returns a default catalog page. Response is {"results": [...]}.
    """
    url = f"{SKILLHUB_BASE}/api/v1/search?{urlencode({'q': query, 'limit': _FETCH_LIMIT})}"
    data = _http_get_json(url)
    items = data.get("results", []) if isinstance(data, dict) else []
    if not isinstance(items, list):
        return []
    entries: list[dict] = []
    for item in items:
        if isinstance(item, dict):
            entry = _item_to_entry(item, "skillhub")
            if entry is not None:
                entries.append(entry)
    return entries


def _fetch_clawhub(query: str) -> list[dict]:
    """ClawHub listing endpoint: GET /api/v1/skills?search=<query>."""
    params = {"limit": _FETCH_LIMIT}
    if query:
        params["search"] = query
    url = f"{CLAWHUB_BASE}/skills?{urlencode(params)}"
    data = _http_get_json(url)
    if isinstance(data, dict):
        items = data.get("items", [])
    elif isinstance(data, list):
        items = data
    else:
        items = []
    if not isinstance(items, list):
        return []
    entries: list[dict] = []
    for item in items:
        if isinstance(item, dict):
            entry = _item_to_entry(item, "clawhub")
            if entry is not None:
                entries.append(entry)
    return entries


def fetch_remote_catalog(query: str = "") -> list[dict]:
    """Return external-market skill entries, cached for ``_CACHE_TTL`` seconds.

    Tries SkillHub (国内镜像) first, then ClawHub. Returns ``[]`` on total
    failure so the caller can degrade to the builtin catalog without surfacing
    an error.
    """
    cache_key = f"catalog::{query.strip().lower()}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    for fetcher, label in ((_fetch_skillhub, "skillhub"), (_fetch_clawhub, "clawhub")):
        try:
            entries = fetcher(query)
        except (HTTPError, URLError, TimeoutError, ValueError, OSError) as exc:
            logger.warning("skill market fetch failed (%s): %s", label, exc)
            continue
        if entries:
            _cache_set(cache_key, entries)
            return entries
    # Cache the empty result briefly so a flapping upstream isn't hammered on
    # every page load.
    _cache[cache_key] = (time.time() + 60, [])
    return []
