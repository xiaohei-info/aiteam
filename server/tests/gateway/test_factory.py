"""#173 验收：Gateway 生产装配（runtime_selection → 真实 Executor+Driver 配对）。"""

import pytest

from agent_gateway.drivers import (
    ClaudeCodeJsonStreamDriver,
    CodexJsonRpcDriver,
    HermesAcpDriver,
    OpenClawJsonStreamDriver,
    OpenCodeJsonStreamDriver,
)
from agent_gateway.acp_executor import AcpClientExecutor
from agent_gateway.codex_executor import CodexAppServerExecutor
from agent_gateway.executors import (
    JsonStreamCliExecutor,
    PlainCliExecutor,
)
from agent_gateway.factory import build_executor, build_runner
from agent_gateway.sandbox import SandboxPolicy

_CASES = [
    ("hermes", AcpClientExecutor, HermesAcpDriver),
    ("codex", CodexAppServerExecutor, CodexJsonRpcDriver),
    ("claude_code", JsonStreamCliExecutor, ClaudeCodeJsonStreamDriver),
    ("opencode", JsonStreamCliExecutor, OpenCodeJsonStreamDriver),
    ("openclaw", JsonStreamCliExecutor, OpenClawJsonStreamDriver),
]


@pytest.mark.parametrize("selection,executor_cls,driver_cls", _CASES)
def test_build_runner_pairs_correct_executor_and_driver(selection, executor_cls, driver_cls):
    runner = build_runner(selection)
    assert isinstance(runner._driver, driver_cls)
    assert isinstance(runner._executor, executor_cls)
    assert runner.capabilities().runtime == driver_cls.runtime_name


def test_build_runner_unknown_selection_raises():
    with pytest.raises(ValueError, match="unknown runtime_selection"):
        build_runner("does-not-exist")


def test_build_runner_injects_sandbox_into_executor(tmp_path):
    sandbox = SandboxPolicy(runs_root=str(tmp_path))
    runner = build_runner("hermes", sandbox=sandbox)
    assert runner._executor._sandbox is sandbox


def test_build_runner_without_sandbox_leaves_none():
    runner = build_runner("hermes")
    assert runner._executor._sandbox is None


def test_build_executor_unknown_family_raises():
    with pytest.raises(ValueError, match="unknown executor_family"):
        build_executor("nope")


def test_build_executor_plain_cli():
    assert isinstance(build_executor("plain_cli"), PlainCliExecutor)
