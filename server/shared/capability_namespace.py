"""Who made a skill / MCP and where it came from (design 2026-11-20「技能MCP命名空间出处与更新提示」§4.1).

Every catalog entry carries two display-only fields next to its unchanged identifiers (SKILL.md ``name``,
MCP ``ref``, tenant ``skill_id``):

* ``namespace`` — ``taiyim`` for what the platform makes, the enterprise's name for what an enterprise makes,
  and ``""`` for content taken unchanged from another platform (ClawHub, a GitHub address).
* ``provenance`` — only for content from another platform: ``{kind, label, url, version, edited}``.
  ``edited=False`` reads「来自 …」, ``edited=True`` reads「改自 …」 and the entry then takes our namespace.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

PLATFORM_NAMESPACE = "taiyim"
CLAWHUB_BASE = "https://clawhub.ai"
PROVENANCE_KINDS = ("clawhub", "url", "platform")


def clawhub_provenance(owner: str, slug: str, *, version: str = "", edited: bool = False, base: str = CLAWHUB_BASE) -> dict[str, Any]:
    return _provenance("clawhub", f"ClawHub {owner}/{slug}", f"{base.rstrip('/')}/{owner}/skills/{slug}", version, edited)


def url_provenance(url: str, *, version: str = "", edited: bool = False) -> dict[str, Any]:
    """A public address (GitHub and the like): the label is the host plus the first two path segments."""
    parts = urlsplit(url)
    segments = [segment for segment in parts.path.split("/") if segment][:2]
    label = "/".join([parts.hostname or url, *segments])
    return _provenance("url", label, url, version, edited)


def platform_provenance(label: str, *, version: str = "") -> dict[str, Any]:
    """An enterprise's edited copy of a skill it installed from the platform market."""
    return _provenance("platform", label, "", version, True)


def as_edited(provenance: dict[str, Any] | None, *, version: str = "") -> dict[str, Any] | None:
    """The same origin after we change the content; the first upstream version we edited is kept."""
    current = normalize_provenance(provenance)
    if current is None:
        return None
    return {**current, "edited": True, "version": current.get("version") or version}


def namespace_for(own: str, provenance: dict[str, Any] | None) -> str:
    """Our namespace, unless the content is another platform's and we have not changed it."""
    current = normalize_provenance(provenance)
    return "" if current is not None and not current["edited"] else own


def qualified_label(namespace: str, name: str) -> str:
    return f"{namespace}/{name}" if namespace else name


def origin_provenance(origin: Any) -> dict[str, Any] | None:
    """Provenance of an import recorded as ``config.origin`` ({kind,label,url}) before this field existed."""
    if not isinstance(origin, dict):
        return None
    kind, url = str(origin.get("kind") or ""), str(origin.get("url") or "")
    if kind == "clawhub" and url:
        path = [segment for segment in urlsplit(url).path.split("/") if segment]
        if len(path) >= 3 and path[1] == "skills":
            return clawhub_provenance(path[0], path[2], base=f"{urlsplit(url).scheme}://{urlsplit(url).netloc}")
        return _provenance("clawhub", "ClawHub", url, "", False)
    if kind == "url" and url:
        return url_provenance(url)
    return None


def normalize_provenance(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or raw.get("kind") not in PROVENANCE_KINDS or not str(raw.get("label") or ""):
        return None
    return _provenance(str(raw["kind"]), str(raw["label"]), str(raw.get("url") or ""), str(raw.get("version") or ""), bool(raw.get("edited")))


def _provenance(kind: str, label: str, url: str, version: str, edited: bool) -> dict[str, Any]:
    return {"kind": kind, "label": label[:200], "url": url[:2048] if url.startswith("https://") else "", "version": version[:64], "edited": edited}
