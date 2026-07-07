"""M2 验收：子进程执行器在 spawn 前按 runtime 投影 skill；缺失则生成前端可展示错误（AITEAM-691 #5）。"""

from __future__ import annotations

from agent_gateway.executors import JsonStreamCliExecutor, PlainCliExecutor
from agent_gateway.sandbox import SandboxPolicy
from agent_service.capabilities.skill_cache import SkillCache
from shared.contracts.runspec import AgentRunRequest, RunSpec
from shared.contracts.skill import SkillFile, SkillPackage


class _FakeDriver:
    runtime_name = "codex"
    def capabilities(self): raise NotImplementedError
    def build_command(self, run_spec): raise NotImplementedError
    def parse_event(self, raw): return None
    def extract_session_id(self, raw): return None
    def extract_usage(self, raw): return None
    def runtime_health(self): raise NotImplementedError


def _pkg(skill_id="sr", version="1", body="# sr helper") -> SkillPackage:
    return SkillPackage(
        skill_id=skill_id, version=version, content_hash="",
        display_name="sr", description="",
        files=[SkillFile(path="SKILL.md", content=body, content_hash="h")],
    ).with_computed_hash()


def test_project_skills_in_openclaw_writes_native_dir(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_pkg().with_computed_hash())
    executor = PlainCliExecutor(skill_cache=cache)
    work_root = tmp_path / "run_work"; work_root.mkdir()
    work = str(work_root)
    req = AgentRunRequest(run_id="run-1", tenant_id="t", run_spec=RunSpec(), runtime_selection="openclaw", skill_refs=["sr"])
    env = {}
    missing = executor._project_skills(work, req, env)
    assert missing == []
    target = work_root / "skills" / "sr"
    assert (target / "SKILL.md").is_file()


def test_project_skills_codex_sets_codex_home(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")
    cache.store(_pkg().with_computed_hash())
    executor = PlainCliExecutor(skill_cache=cache)
    work_root = tmp_path / "run_work"; work_root.mkdir()
    work = str(work_root)
    req = AgentRunRequest(run_id="run-2", tenant_id="t", run_spec=RunSpec(), runtime_selection="codex", skill_refs=["sr"])
    env = {}
    missing = executor._project_skills(work, req, env)
    assert missing == []
    assert "CODEX_HOME" in env
    assert env["CODEX_HOME"].endswith("codex-home")


def test_project_skills_missing(tmp_path):
    cache = SkillCache(cache_root=tmp_path / "cache")  # 空缓存
    executor = PlainCliExecutor(skill_cache=cache)
    work = str(tmp_path / "empty"); 
    import os; os.makedirs(work, exist_ok=True)
    req = AgentRunRequest(run_id="run-3", tenant_id="t", run_spec=RunSpec(), runtime_selection="openclaw", skill_refs=["missing-skill"])
    env = {}
    missing = executor._project_skills(work, req, env)
    assert missing == ["missing-skill"]


def test_project_skills_skipped_when_no_cache(tmp_path):
    """无 skill_cache 时执行器不做投影且返回 []（安全降级）。"""
    executor = PlainCliExecutor()
    work = tmp_path / "no_cache"; work.mkdir()
    req = AgentRunRequest(run_id="run-4", tenant_id="t", run_spec=RunSpec(), skill_refs=["sr"])
    missing = executor._project_skills(str(work), req, {})
    assert missing == []


if __name__ == "__main__":  # pragma: no cover
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
