"""能力缓存/投影装配（M2）。

构成本地 SkillCache / SkillsService / SkillProjector 三件套：
- SkillCache：本地只读投影持久缓存；
- SkillsService：sync 按 version/hash 写入缓存 + revoke 清理；
- SkillProjector：按 runtime 投影到 per-run workDir 并生成 env 覆盖。

注意：装配仅涉及本地文件系统；Manager 通信统一经 GrantsService 的 pull_authorized_config
的 response.skill_packages 透传；本 factory 不持有 Manager 通道。
"""

from __future__ import annotations

from .skill_cache import DEFAULT_SKILL_CACHE_ROOT, SkillCache
from .skill_projector import SkillProjector
from .skills_service import SkillsService


def build_skill_cache(cache_root=None) -> SkillCache:
    return SkillCache(cache_root=cache_root)


def build_skills_service(cache_root=None) -> SkillsService:
    return SkillsService(build_skill_cache(cache_root=cache_root))


def build_skill_projector(cache_root=None) -> SkillProjector:
    return SkillProjector(build_skill_cache(cache_root=cache_root))
