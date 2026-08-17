"""技能包契约（M2，04 §6.6 / 06 §7.5.4）。

中立技能分发契约：
- SkillPackage：Manager 投送给 Agent 的完整技能真相（skill_id/version/content_hash/
  display_name/description + 文件列表）。Manager 是技能真相源（D5），Agent 本地只缓存授权投影。
- SkillFile：单个技能文件（相对路径 + 内容 + 内容哈希），供本地 Pi ResourceLoader
  按 version/hash 判断更新。

架构边界（M2）：
- 技能真相在 Manager（capability_catalog.skill_catalog）；用户端 Agent 只缓存「被授权专家引用的」
  技能包的本地副本（~/.aiteam-agent/capabilities/skills/{skill_id}/{version}/）。
- 技能包只加载到受控 Pi ResourceLoader，不发现用户全局配置（D16）。
- Agent 负责授权、版本和 hash 校验；技能内容不携带执行器参数。
"""

from __future__ import annotations

import hashlib
import json

from pydantic import BaseModel, ConfigDict, Field


class SkillFile(BaseModel):
    """单个技能文件（M2：相对路径 + 内容 + 内容哈希）。

    path 是技能目录内的相对路径（posix 风格，例 "SKILL.md"、"references/foo.md"），
    永不含前导 "/" 或 "../"；projector 据此写进 workDir 原生 skill 目录。
    """

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="技能目录内相对路径（posix，例 SKILL.md / references/foo.md）")
    content: str = Field(description="文件文本内容（utf-8）")
    content_hash: str = Field(description="内容 sha256 前 16 hex，供 cache 判断更新")


def _sha16(text: str) -> str:
    """sha256(text)[:16]；cache 用前 16 hex 当作内容指纹，避免全量比对。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def normalize_skill_file_path(path: str) -> str:
    """把任意路径归一为安全的 posix 相对路径；拒绝逃逸到外部。

    抛 ValueError 当路径含 `..`、绝对路径、空段——projector/cache 只接受
    skill 目录内的本分路径，绝不许穿越到缓存/workDir 之外（D6/§13）。
    """
    if not path or not isinstance(path, str):
        raise ValueError("skill file path 不能为空")
    raw = path.strip()
    if raw.startswith("/"):
        raise ValueError(f"非法技能文件路径（绝对路径）：{path!r}")
    p = raw.replace("\\", "/")
    if p.startswith("/") or p.startswith("./"):
        p = p.lstrip("/").lstrip(".")
        p = p.lstrip("/")
    parts = [seg for seg in p.split("/") if seg and seg != "."]
    for seg in parts:
        if seg == "..":
            raise ValueError(f"非法技能文件路径（逃逸）：{path!r}")
    if not parts:
        raise ValueError(f"非法技能文件路径（空）：{path!r}")
    return "/".join(parts)


class SkillPackage(BaseModel):
    """完整技能真相快照（M2：Manager 投送给 Agent 的授权投影真相）。

    一旦取得即与 Manager 解耦：Agent 本地只缓存此包的副本；run 期间引用缓存版本，
    不随 Manager 离线失效（D14）。按 (skill_id + version) 唯一；同 key 重复 store 按
    内容 hash 决定覆盖（真更新）或跳过（幂等）（M2 #2）。
    """

    model_config = ConfigDict(extra="forbid")

    skill_id: str = Field(description="租户内技能标识（中立引用，与 capability_catalog.skill_catalog.skill_id 对齐）")
    version: str = Field(description="技能版本（语义版本或自定标识；与 catalog.version 对齐）")
    content_hash: str = Field(description="包级内容指纹：normalize 后所有文件的 sha256 前 16 hex")
    display_name: str = Field(default="", description="技能显示名")
    description: str = Field(default="", description="技能描述/摘要")
    files: list[SkillFile] = Field(default_factory=list, description="技能文件列表（含 SKILL.md）")

    def compute_content_hash(self) -> str:
        """由文件列表确定性派生包级内容指纹（path 排序规范化，避免顺序影响）。"""
        normalized = sorted(
            (normalize_skill_file_path(f.path), f.content) for f in self.files
        )
        canonical = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]

    def with_computed_hash(self) -> "SkillPackage":
        """返回 content_hash 由 files 重算的副本（入站校验/M2 #2）。"""
        return self.model_copy(update={"content_hash": self.compute_content_hash()})


def derive_file_hash(content: str) -> str:
    """单个文件内容指纹：sha256(content)[:16]。"""
    return _sha16(content)
