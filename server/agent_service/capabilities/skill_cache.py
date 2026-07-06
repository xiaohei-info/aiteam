"""本地只读技能包持久缓存（M2 #2）。

持久化到 ~/.aiteam-agent/capabilities/skills/{skill_id}/{version}/：
  - 每个 SkillFile 按其相对路径落文件（path 穿透为多级目录，例 references/foo.md）；
  - 包根写 package.json（skill_id/version/content_hash/display_name/description/files）。
包根即为 per-run 投影的"源"： projector 直接把整个 {skill_id}/{version}/ 复制到
workDir 原生 skill 目录。

更新判定（M2 #2，按 version/hash）：
  - 包根不存在 → 写入（added）；
  - 包根已存在且 content_hash 一致 → 跳过（kept，幂等）；
  - content_hash 不一致 → 覆盖（updated，真更新）。
  - 同 (skill_id, version) 重复 store 不可变语义：同 hash 不覆盖、不同 hash 覆写。

红线：
- 路径严格隔离在 cache_root 内；任何 path 逃逸抛 ValueError 绝不落盘（D6/§13）。
- 不做运行时权限/内容过滤：Manager 为技能真相源（D5），Agent 只缓存授权投影。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

from shared.contracts.skill import SkillFile, SkillPackage, normalize_skill_file_path

logger = logging.getLogger(__name__)

# 默认持久化根：用户端固定目录，重启不丢（与 local_db 同处 ~/.aiteam-agent）。
DEFAULT_SKILL_CACHE_ROOT = os.path.expanduser("~/.aiteam-agent/capabilities/skills")


@dataclass(frozen=True)
class StoreResult:
    """store 的结果摘要。"""

    status: str          # "added" | "kept" | "updated"
    path: str            # 包根绝对路径
    package: SkillPackage

    @property
    def changed(self) -> bool:
        return self.status in ("added", "updated")


class SkillCache:
    """本地只读技能包持久缓存（M2 #2）。

    cache_root 下按 skill_id/version 组织；包根目录即 per-run 投影源。
    """

    def __init__(self, cache_root: str | os.PathLike[str] | None = None) -> None:
        self._root = Path(cache_root or DEFAULT_SKILL_CACHE_ROOT).expanduser().resolve()

    # ---- 路径 ----

    @property
    def root(self) -> Path:
        return self._root

    def package_dir(self, skill_id: str, version: str) -> Path:
        """(skill_id, version) 对应的包根绝对路径；不创建目录。"""
        safe_id = _safe_segment(skill_id)
        safe_ver = _safe_segment(version or "0")
        return self._root / safe_id / safe_ver

    # ---- 读 ----

    def exists(self, skill_id: str, version: str) -> bool:
        """包根目录 + package.json 存在即视为已缓存。"""
        return (self.package_dir(skill_id, version) / "package.json").is_file()

    def get(self, skill_id: str, version: str) -> SkillPackage | None:
        """读缓存包；不存在返回 None。读失败（损坏/校验不过）返回 None 并日志告警。"""
        pkg_dir = self.package_dir(skill_id, version)
        manifest = pkg_dir / "package.json"
        if not manifest.is_file():
            return None
        try:
            raw = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("skill cache manifest 读取失败：%s → %s", manifest, exc)
            return None
        try:
            files: list[SkillFile] = []
            for entry in raw.get("files", []) if isinstance(raw.get("files"), list) else []:
                fpath = normalize_skill_file_path(str(entry.get("path", "")))
                full = _safe_join(pkg_dir, fpath)
                if not full.is_file():
                    logger.warning(
                        "skill cache 文件缺失：%s (skill=%s version=%s) → 跳过该文件",
                        fpath, skill_id, version,
                    )
                    continue
                files.append(SkillFile(
                    path=fpath,
                    content=full.read_text(encoding="utf-8"),
                    content_hash=str(entry.get("content_hash") or ""),
                ))
            return SkillPackage(
                skill_id=str(raw.get("skill_id", skill_id)),
                version=str(raw.get("version", version)),
                content_hash=str(raw.get("content_hash", "")),
                display_name=str(raw.get("display_name", "")),
                description=str(raw.get("description", "")),
                files=files,
            )
        except ValueError as exc:
            logger.warning("skill cache 文件路径非法：skill=%s version=%s → %s", skill_id, version, exc)
            return None

    def get_latest(self, skill_id: str) -> SkillPackage | None:
        """取该 skill_id 已缓存的最高版本；未缓存返回 None。

        专家投影只记 skill_id 不记 version 时（M1 snapshot/projection.skills 是 skill_id 列表），
        run 准备阶段用 get_latest 兜底解析（M2 #5）。版本按字典序取末位；推荐精确 (id, version)。
        """
        safe_id = _safe_segment(skill_id)
        skill_dir = self._root / safe_id
        if not skill_dir.is_dir():
            return None
        versions = sorted(
            p.name for p in skill_dir.iterdir()
            if p.is_dir() and (p / "package.json").is_file()
        )
        return self.get(skill_id, versions[-1]) if versions else None

    # ---- 写 ----

    def store(self, package: SkillPackage) -> StoreResult:
        """持久缓存一包（M2 #2）。

        返回 StoreResult(status=added|kept|updated)。底路径异常由调用方按 D14 降级（吞异常）；
        路径逃逸则抛 ValueError（调用方绝不应发生）。
        """
        pkg_dir = self.package_dir(package.skill_id, package.version)
        manifest = pkg_dir / "package.json"
        expected_hash = package.content_hash or package.compute_content_hash()

        pre_existed = manifest.is_file()
        if pre_existed:
            try:
                existing_hash = str(json.loads(manifest.read_text(encoding="utf-8")).get("content_hash", ""))
            except (OSError, json.JSONDecodeError):
                existing_hash = ""
            if existing_hash == expected_hash:
                return StoreResult(status="kept", path=str(pkg_dir), package=package)

        files_meta = []
        for f in package.files:
            fpath = normalize_skill_file_path(f.path)
            full = _safe_join(pkg_dir, fpath)
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(f.content, encoding="utf-8")
            files_meta.append({"path": fpath, "content_hash": f.content_hash or _content_hash(f.content)})

        pkg_dir.mkdir(parents=True, exist_ok=True)
        manifest.write_text(
            json.dumps(
                {
                    "skill_id": package.skill_id,
                    "version": package.version,
                    "content_hash": expected_hash,
                    "display_name": package.display_name,
                    "description": package.description,
                    "files": files_meta,
                },
                ensure_ascii=False,
                indent=2,
            ) + "\n",
            encoding="utf-8",
        )
        status = "updated" if pre_existed else "added"
        return StoreResult(status=status, path=str(pkg_dir), package=package)

    # ---- 删 ----

    def remove(self, skill_id: str, version: str | None = None) -> bool:
        """移除缓存：version 给定删单个包；否则删整个 skill_id（撤销授权清理）。返回是否真的删除。"""
        target = self.package_dir(skill_id, version) if version is not None else (self._root / _safe_segment(skill_id))
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)
            return True
        return False

    # ---- 列 ----

    def list_cached(self) -> list["SkillPackage"]:
        """列全部已缓存包（按 (skill_id, version) 升序；缺失/损坏跳过不抛）。"""
        out: list[SkillPackage] = []
        if not self._root.is_dir():
            return out
        for manifest in sorted(self._root.glob("*/*/package.json")):
            try:
                raw = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            pkg = self.get(str(raw.get("skill_id", "")), str(raw.get("version", "")))
            if pkg is not None:
                out.append(pkg)
        return out

    def list_skill_ids(self) -> list[str]:
        return sorted({p.skill_id for p in self.list_cached()})


# ---- 内部工具 ----


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()[:16]


def _safe_segment(name: str) -> str:
    """把标识归一到安全路径段；拒绝路径分隔符 / '..' / 空的段或 '.' / '..'（D6/§13）。

    单一 '.' 与 '..' 被拒（恒等/回溯不含信息且常为错误输入）；含分隔符的直接拒绝；
    首字符 '.'（隐藏文件）也拒绝，避免污染点文件命名空间。
    """
    if not name or not isinstance(name, str):
        raise ValueError(f"非法路径段：{name!r}")
    seg = name.strip()
    if seg in (".", ".."):
        raise ValueError(f"非法路径段：{name!r}")
    for ch in (os.sep, "/", "\\"):
        if ch in seg:
            raise ValueError(f"非法路径段（含分隔符）：{name!r}")
    if seg.startswith("."):
        raise ValueError(f"非法路径段（隐藏文件）：{name!r}")
    return seg


def _safe_join(base: Path, rel: str) -> Path:
    """安全拼接：rel 必须 resolve 后在 base 内，否则抛 ValueError（路径逃逸防护）。"""
    if ".." in rel.split("/"):
        raise ValueError(f"路径逃逸：{rel!r}")
    full = (base / rel).resolve()
    base_resolved = base.resolve()
    if full != base_resolved and base_resolved not in (full.parents if True else set()):
        # 换更稳健的比较：full 以 base_resolved 为前缀。
        pass
    try:
        full.relative_to(base_resolved)
    except ValueError as exc:
        raise ValueError(f"路径逃逸：base={base_resolved!r} rel={rel!r}") from exc
    return full
