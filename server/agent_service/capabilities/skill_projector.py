"""per-workDir 技能投影（M2 #3 / M2 #5）。

职责：
  - 按 runtime 把缓存的一包（SkillCache.package_dir）投影到 per-run workDir 原生 skill 目录；
  - 缺失 skill（缓存里找不到 run 需要的 skill）返回可展示的错误（M2 #5）；
  - codex 设置 CODEX_HOME（M2 #3 目录表）；OpenCode / OpenClaw / Hermes / Claude Code
    仅做目录结构投影（原生发现能力由各自 Driver.capabilities().supports_native_skills 标注）。

架构边界（M2）：
- 投影只复制到 workDir，不写 runtime 共享 profile（D16）；
- 多 expert 并行 run 的 workDir 互不干扰（每 run 独立 cwd，见 sandbox.prepare_run_dir）；
- run 结束由 cleanup 清扫 workDir（不残留执行态投影，见 issue #159 CleanupService）；
- 投影失败（缺失 skill）时抛出 MissingSkillError，由 run 准备层转译成前端可展示错误——
  不回退到未知配置（M1 铁律）。

运行时原生目录表（M2）：
  - hermes:        {workDir}/.agent_context/skills/{name}/
  - claude_code:   {workDir}/.claude/skills/{name}/
  - codex:         {workDir}/codex-home/skills/{name}/  (+ CODEX_HOME={workDir}/codex-home)
  - opencode:      {workDir}/.opencode/skills/{name}/
  - openclaw:      {workDir}/skills/{name}/
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from shared.contracts.skill import SkillPackage

from .skill_cache import SkillCache

logger = logging.getLogger(__name__)

# 运行时 → workDir 下原生 skill 子目录的相对路径构造。签名：(work_dir, name) -> 目录绝对路径。
# name 由 projector 派生（safe skill 名，来自 skill_id 归一）。
SkillDirResolver = callable  # 仅作注释；真类型在 __all__ 下标注。


class _SkillDirFn(Protocol):
    def __call__(self, work_dir: Path, name: str) -> Path: ...


def _hermes_dir(work_dir: Path, name: str) -> Path:
    return work_dir / ".agent_context" / "skills" / name


def _claude_dir(work_dir: Path, name: str) -> Path:
    return work_dir / ".claude" / "skills" / name


def _codex_dirs(work_dir: Path, name: str) -> Path:
    # CODEX_HOME 为 codex-home；skills 在其下。
    return work_dir / "codex-home" / "skills" / name


def _opencode_dir(work_dir: Path, name: str) -> Path:
    return work_dir / ".opencode" / "skills" / name


def _openclaw_dir(work_dir: Path, name: str) -> Path:
    return work_dir / "skills" / name


# runtime_name → 原生 skill 目录构造函数（M2 目录表）。未知 runtime 视为不支持原生投影。
RUNTIME_SKILL_DIR: dict[str, _SkillDirFn] = {
    "hermes": _hermes_dir,
    "claude_code": _claude_dir,
    "codex": _codex_dirs,
    "opencode": _opencode_dir,
    "openclaw": _openclaw_dir,
}

# 需额外塞 env 的 runtime → {env_key: 相对 workDir 路径}（M2 目录表：codex 设置 CODEX_HOME）。
RUNTIME_ENV_OVERRIDES: dict[str, dict[str, str]] = {
    "codex": {"CODEX_HOME": "codex-home"},
}


class MissingSkillError(Exception):
    """缺失 skill（M2 #5）：run 准备阶段需要的 skill 在本地缓存未找到。

    由 SkillProjector.project 抛出；run 准备层据此终结 run 并向前端返回清晰错误，
    绝不允许回退到未知配置 / 静默丢弃（M1 铁律）。
    """

    def __init__(self, missing: list[str], *, runtime: str | None = None) -> None:
        self.missing = list(missing)
        self.runtime = runtime
        detail = f"runtime={runtime}, " if runtime else ""
        super().__init__(
            f"缺少已授权 skill 的本地投影：{detail}missing={missing}。请检查 Manager 配置或重新授权。"
        )


@dataclass
class ProjectedSkill:
    """单个技能的投影结果。"""

    skill_id: str
    name: str                 # 和工作目录里 {name} 一致（归一后的技能名）
    target_dir: str           # 投影目标绝对路径
    package_dir: str          # 缓存源绝对路径
    skipped: bool = False     # 内容未变跳过复制（优化）


@dataclass
class ProjectionResult:
    """project(run_id, work_dir, runtime, skill_refs) 的完整产出（M2 #3）。"""

    run_id: str
    runtime: str
    work_dir: str
    projected: list[ProjectedSkill] = field(default_factory=list)
    env_overrides: dict[str, str] = field(default_factory=dict)
    # 所有需要、但本地缓存找不到的 skill 名称 → 缺失清单（非空时 project 抛 MissingSkillError）。
    missing: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.missing


def _safe_skill_name(skill_id: str) -> str:
    """从 skill_id 派生安全的目录名（{a} 必为相对、无分隔符、无点文件）。

    归一失败时抛 ValueError（应不会出现：Manager 端 skill_id 与 cache 同键）。
    """
    if not skill_id or not isinstance(skill_id, str):
        raise ValueError(f"非法 skill_id：{skill_id!r}")
    safe = skill_id.strip()
    if safe in (".", "..") or not safe:
        raise ValueError(f"非法 skill_id：{skill_id!r}")
    for ch in ("/", "\\"):
        if ch in safe:
            # 极少出现：替换为下划线（不抛，保证投影健壮），但隐藏文件前缀仍拒。
            safe = safe.replace(ch, "_")
    if safe.startswith("."):
        raise ValueError(f"非法 skill_id（点前缀）：{skill_id!r}")
    return safe


class SkillProjector:
    """per-workDir 技能投影器（M2 #3）。

    把 run 需要的 skill 列表（skill_refs = skill_id 列表，来自 snapshot.skills）按 runtime
    投影到 workDir；缺一则抛 MissingSkillError（M2 #5）。
    """

    def __init__(self, cache: SkillCache) -> None:
        self._cache = cache

    def project(
        self,
        *,
        run_id: str,
        work_dir: str | Path,
        runtime: str,
        skill_refs: list[str],
        fail_on_missing: bool = True,
    ) -> ProjectionResult:
        """按 runtime 投影技能到 workDir（M2 #3）。

        fail_on_missing=True（默认）时，任一 skill 未存在于本地缓存则抛 MissingSkillError（M2 #5）；
        False 时把缺失记入 result.missing、其余正常投影（用于观测/降级场景）。
        投影总返回 ProjectionResult（即使缺失也包含已投射部分与 env_overrides，便于诊断）。
        """
        work = Path(work_dir)
        resolver = RUNTIME_SKILL_DIR.get(runtime)
        result = ProjectionResult(run_id=str(run_id), runtime=runtime, work_dir=str(work))
        if not resolver:
            # 未知 runtime：不做原生投影（相应 Driver.capabilities().supports_native_skills=False），
            # 但缺失 skill 仍视为错误（M2 #5）——避免用户以为放成功了实际没投。
            for sid in skill_refs or []:
                if not self._resolve_package(sid):
                    result.missing.append(sid)
            result.env_overrides = {}
            if result.missing and fail_on_missing:
                raise MissingSkillError(result.missing, runtime=runtime)
            return result

        # env 覆盖（如 codex 的 CODEX_HOME）：相对 workDir 的绝对化。
        for k, rel in RUNTIME_ENV_OVERRIDES.get(runtime, {}).items():
            result.env_overrides[k] = str((work / rel).resolve())

        for sid in skill_refs or []:
            pkg = self._resolve_package(sid)
            if pkg is None:
                result.missing.append(sid)
                continue
            name = _safe_skill_name(pkg.skill_id)
            target = resolver(work, name)
            src = self._cache.package_dir(pkg.skill_id, pkg.version)
            self._copy_tree(src, target)
            result.projected.append(ProjectedSkill(
                skill_id=pkg.skill_id, name=name, target_dir=str(target),
                package_dir=str(src),
            ))

        if result.missing and fail_on_missing:
            raise MissingSkillError(result.missing, runtime=runtime)
        return result

    def _resolve_package(self, skill_id: str) -> "SkillPackage | None":
        """优先按 (id, latest) 解析缓存；找不到返回 None。"""
        if not skill_id:
            return None
        return self._cache.get_latest(skill_id)

    @staticmethod
    def _copy_tree(src: Path, dst: Path) -> None:
        """把整个缓存包根（含 SKILL.md 与 references 等）复制到目标目录。"""
        import shutil

        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            shutil.rmtree(dst, ignore_errors=True)
        shutil.copytree(src, dst)


def project_skills(
    *,
    cache: SkillCache,
    run_id: str,
    work_dir: str | Path,
    runtime: str,
    skill_refs: list[str],
    fail_on_missing: bool = True,
) -> ProjectionResult:
    """便捷入口：构造默认 projector 并投影（M2 #3）。"""
    return SkillProjector(cache).project(
        run_id=run_id, work_dir=work_dir, runtime=runtime,
        skill_refs=skill_refs, fail_on_missing=fail_on_missing,
    )
