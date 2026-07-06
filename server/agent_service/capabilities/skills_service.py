"""技能缓存 + per-run 投影编排（M2 #4/#5）。

GrantsService.sync 完成落投影 + 冻结快照后，由本服务：
  - 把 Manager 下发的 authorized 技能包（AuthorizedConfigPullResponse.skill_packages）写入本地
    SkillCache（按 version/hash 判定更新/跳过）；
  - 撤销授权（revoked_ids）后，移除本 member 不再引用的技能包（D5：缓存只保留授权投影）。

架构边界（M2）：
- 技能真相在 Manager；本服务只管缓存写入 + 撤销清理 + per-run 投影编排。
- 缓存只保留本 member 当前可见专家引用的技能包（revoke 后清理）；快照/投影对缓存的引用只走
  SkillPackage，Manager 离线时按缓存版本继续（D14）。
- 投影由 SkillProjector 执行；本服务不做 I/O（只编排）。
"""

from __future__ import annotations

import logging

from shared.contracts.skill import SkillPackage

from .skill_cache import SkillCache, StoreResult

logger = logging.getLogger(__name__)


class SkillsService:
    """技能缓存 + per-run 投影编排（M2 #4/#5）。"""

    def __init__(self, cache: SkillCache) -> None:
        self._cache = cache

    @property
    def cache(self) -> SkillCache:
        return self._cache

    def store_packages(self, packages: list[SkillPackage] | list[dict]) -> "SyncResult":
        """持久 cache authorized 技能包（M2 #2）。

        返回 store / kept / updated 的计数；包内容/路径异常（ValueError）按 D14 跳过不抛。
        """
        counts = {"stored": 0, "kept": 0, "updated": 0, "skipped": 0}
        for raw in packages or []:
            if raw is None:
                continue
            try:
                pkg = self._coerce_package(raw)
            except (ValueError, TypeError) as exc:
                logger.warning("skill_package 解释失败（跳过）：%r → %s", raw, exc)
                counts["skipped"] += 1
                continue
            try:
                res = self._cache.store(pkg)
            except (ValueError, OSError) as exc:
                logger.warning("skill_package cache 写入失败（跳过）：%s %s → %s", pkg.skill_id, pkg.version, exc)
                counts["skipped"] += 1
                continue
            counts["stored" if res.status == "added" else res.status] += 1
        return SyncResult(**counts)

    def store_from_sync(self, sync_packages: list[object]) -> "SyncResult":
        """store_packages 的别名（语义：来自 sync 的 authorized 技能包）。"""
        return self.store_packages(sync_packages)

    def apply_revocation(self, revoked_skill_ids: list[str]) -> int:
        """移除本 member 不再引用的 revoked 技能（整 skill_id，M2 #4 revoke 清理）。"""
        removed = 0
        for sid in revoked_skill_ids or []:
            if not sid:
                continue
            try:
                self._cache.remove(skill_id=sid, version=None)
            except (ValueError, OSError) as exc:
                logger.warning("revoke 清理 skill %s 失败（跳过）：%s", sid, exc)
                continue
            removed += 1
        return removed

    def clear_all(self) -> int:
        """移除全部缓存（兜底/鉴权失效时）。"""
        n = 0
        for sid in self._cache.list_skill_ids():
            try:
                self._cache.remove(skill_id=sid, version=None)
            except (ValueError, OSError) as exc:
                logger.warning("skill cache 清理 %s 失败：%s", sid, exc)
                continue
            n += 1
        return n

    @staticmethod
    def _coerce_package(raw: SkillPackage | dict) -> SkillPackage:
        if isinstance(raw, SkillPackage):
            return raw
        if not isinstance(raw, dict):
            raise TypeError(f"unsupported skill package type: {type(raw)!r}")
        files_raw = raw.get("files", [])
        files = []
        for f in files_raw or []:
            if isinstance(f, dict):
                files.append({
                    "path": str(f.get("path", "")),
                    "content": str(f.get("content", "")),
                    "content_hash": str(f.get("content_hash", "")),
                })
            else:
                files.append(f)
        return SkillPackage(
            skill_id=str(raw.get("skill_id", "")),
            version=str(raw.get("version", "")),
            content_hash=str(raw.get("content_hash", "")),
            display_name=str(raw.get("display_name", "")),
            description=str(raw.get("description", "")),
            files=files,
        )


class SyncResult:
    """一次 store_packages 的结果摘要。"""

    def __init__(self, *, stored: int = 0, kept: int = 0, updated: int = 0, skipped: int = 0) -> None:
        self.stored = stored
        self.kept = kept
        self.updated = updated
        self.skipped = skipped

    def __repr__(self) -> str:  # pragma: no cover
        return f"SyncResult(+{self.stored}, kept={self.kept}, ~{self.updated}, skip={self.skipped})"
