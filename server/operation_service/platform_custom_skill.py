"""Operator custom platform skills (design 2026-11-20 §4.7).

The operator adds a skill that is not on ClawHub: upload a folder / zip / one .md, paste SKILL.md, give a
public https address, or write it in the console's SKILL.md editor. Same sources and the same SKILL.md rules
as the Manager enterprise import (`shared.skill_sources`); the result is an immutable platform skill version
that enterprises install from 「平台技能市场」 like any ClawHub one.

* `preview` reads every skill in the source and writes nothing;
* `save` stores the chosen skills: a new name is a new platform skill; changed content is a new version
  (enterprises see 「可更新」); identical content is reported as a duplicate;
* publishing follows the same 「自动开放」 switch as ClawHub imports;
* nothing is executed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from shared.errors import ValidationProblem
from shared.net_guard import Fetch
from shared.skill_import import skill_roots
from shared.skill_sources import Gathered, SkillRead, SourceGatherer, read_skill

from .platform_skill_market import CustomSkillState, plan_custom_version


class CustomSkillStore(Protocol):
    def find_custom(self, *, name: str) -> CustomSkillState | None: ...
    def save_custom(self, *, name: str, description: str, files: list[dict[str, str]], content_hash: str,
                    declared_version: str, auto_publish: bool, source_url: str) -> dict: ...
    def get_setting(self) -> bool: ...


@dataclass
class CustomSkillRequest:
    source: str
    entries: list[tuple[str, bytes]] = field(default_factory=list)
    text: str = ""
    url: str = ""
    roots: list[str] | None = None


class CustomSkillService:
    def __init__(self, repo: CustomSkillStore, *, fetch: Fetch | None = None):
        self._repo = repo
        self._sources = SourceGatherer(fetch)

    def preview(self, request: CustomSkillRequest) -> dict[str, Any]:
        gathered = self._gather(request)
        items = [self._summary(read) for read in self._reads(gathered, request)]
        out = {"origin": gathered.origin.as_dict()}
        return {**out, "preview": items[0]} if len(items) == 1 else {**out, "scan": items}

    def save(self, request: CustomSkillRequest) -> dict[str, Any]:
        gathered = self._gather(request)
        reads = self._reads(gathered, request)
        if request.roots is None:
            reads = [read for read in reads if read.ok]
            if not reads:
                raise ValidationProblem("这个来源里没有可导入的技能")
        auto_publish = self._repo.get_setting()
        results = []
        for read in reads:
            base = {"root": read.root, "name": read.name, "version": ""}
            if not read.ok:
                results.append({**base, "status": "failed", "reason": read.reason})
                continue
            saved = self._repo.save_custom(
                name=read.name, description=read.description, files=read.files, content_hash=read.content_hash,
                declared_version=read.declared_version, auto_publish=auto_publish, source_url=gathered.origin.url,
            )
            results.append({**base, "version": saved["version"], "status": saved["status"], "skill_id": saved["skill_id"],
                            **({"reason": "平台目录里已有内容相同的这个技能"} if saved["status"] == "duplicate" else {})})
        return {"origin": gathered.origin.as_dict(), "results": results, "auto_publish": auto_publish}

    def _gather(self, request: CustomSkillRequest) -> Gathered:
        return self._sources.gather(request.source, entries=request.entries, text=request.text, url=request.url)

    @staticmethod
    def _reads(gathered: Gathered, request: CustomSkillRequest) -> list[SkillRead]:
        roots = skill_roots(gathered.entries)
        if not roots:
            raise ValidationProblem("这个来源里找不到 SKILL.md")
        if request.roots is not None:
            unknown = sorted(set(request.roots) - set(roots))
            if unknown:
                raise ValidationProblem(f"包里没有这些技能目录：{'、'.join(unknown)}")
            roots = [root for root in roots if root in request.roots]
        return [read_skill(gathered.entries, root) for root in roots]

    def _summary(self, read: SkillRead) -> dict[str, Any]:
        sizes = [{"path": f["path"], "size": len(f["content"].encode("utf-8"))} for f in read.files]
        existing_state, version, existing_version = "none", "", None
        if read.ok:
            existing = self._repo.find_custom(name=read.name)
            existing_state, version = plan_custom_version(existing, content_hash=read.content_hash, declared=read.declared_version)
            existing_version = existing.latest_version if existing else None
        return {
            "root": read.root, "ok": read.ok, **({"reason": read.reason} if read.reason else {}),
            "name": read.name, "description": read.description, "version": version,
            "file_count": len(sizes), "total_bytes": sum(item["size"] for item in sizes), "files": sizes,
            "skipped": [{"path": item.path, "reason": item.reason} for item in read.skipped],
            "existing": existing_state, **({"existing_version": existing_version} if existing_version else {}),
        }
