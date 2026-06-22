# Agent Gateway 生产装配真实 Driver/Executor 实施计划（#173）

**Goal:** 让 agent 按配置装配并运行**真实 runtime**（替换默认 Fake），并落地 §13 子进程隔离硬约束（工作目录隔离 + 环境脱敏 + 凭据最小注入接缝）与 loop 调度生产自启动。

**Architecture:** gateway 已有完整 Executor 协议族 + Driver + `get_driver` 注册表，但缺：① driver↔executor 配对装配；② 子进程沙箱（`_spawn` 现在裸 exec，无 cwd/env）；③ 按配置接进 agent app。本卡补齐这三块，不改冻结契约（复用 `AgentRunRequest.runtime_selection` / `workspace_policy` / `RunSpec.timeout_seconds`）。

**Tech Stack:** 标准库 asyncio.subprocess（已用）；新增沙箱用 pathlib/os；零新依赖。

---

## 关键约束
- 不改 Executor/Driver/RunSpec 冻结契约签名；沙箱为 Executor 可选构造参数（默认 None=现行为，保证既有测试绿）。
- §13 硬约束：工作目录隔离、环境脱敏（allowlist）、凭据最小注入接缝、超时/取消（已实现）、工具调用审计（tool_call 事件已入 timeline）。
- 不静默切换 runtime：未知 selection 显式报错（复用 `get_driver`）。
- 真实 runtime CLI（hermes 等）不在 CI 环境；用**可控 stub 子进程**（python 吐 JSONL）做真实 spawn 集成验证，不依赖外部二进制。
- 默认（未配 AGENT_RUNTIME）仍用 Fake，dev/测试行为不变。

## 任务

### Task 1: 沙箱 `agent_gateway/sandbox.py`（新）
- `SandboxPolicy(runs_root, env_allowlist=DEFAULT, extra_env={})`（frozen dataclass）。
- `prepare_run_dir(policy, run_id) -> str`：建 `runs_root/run_id` 隔离工作目录。
- `build_env(policy) -> dict`：仅放行 allowlist 命中的 os.environ + extra_env（脱敏 + 最小注入接缝）。
- `DEFAULT_ENV_ALLOWLIST = ("PATH","HOME","LANG","LC_ALL","LC_CTYPE","TMPDIR","USER","SHELL")`。

### Task 2: `_SubprocessExecutor` 接沙箱
- `__init__(self, *, sandbox: SandboxPolicy | None = None)`（子类继承，无需各自改）。
- `_spawn` 计算 `cwd`/`env`：有 sandbox → `cwd=prepare_run_dir(...)`, `env=build_env(...)`；无 → 现行为（None/None）。
- `create_subprocess_exec(*command, cwd=cwd, env=env, ...)`。

### Task 3: driver↔executor 配对 + 生产装配 `agent_gateway/factory.py`（新）
- `_BaseDriver.executor_family: str`；各 driver 设：hermes→`acp`、codex→`json_rpc_stdio`、claude_code/opencode/openclaw→`json_stream_cli`。
- `EXECUTOR_FAMILIES = {family: ExecutorCls}`。
- `build_runner(runtime_selection, *, sandbox=None) -> GatewayRunner`：`get_driver` 选 driver，按 `executor_family` 取 executor 类，装配；未知 selection 由 `get_driver` 报错。

### Task 4: 接入 agent_service
- `shared/config.py`：`agent_runtime`(env AGENT_RUNTIME)、`agent_runs_root`(env AGENT_RUNS_ROOT)、`agent_loop_autostart`(env AGENT_LOOP_AUTOSTART)。
- `mainline/factory.build_mainline_service(..., runtime_selection=None, runs_root=None)`：显式 executor/driver→用之（测试）；否则 runtime_selection→`build_runner(sel, sandbox=SandboxPolicy(runs_root or 默认))`；否则 Fake。
- `app.py`：注入上述配置；`agent_loop_autostart` 为真时注册 startup/shutdown 启停 `_loop_scheduler`。

### Task 5: 测试
- `tests/gateway/test_sandbox.py`：prepare_run_dir 隔离、build_env 脱敏（不在 allowlist 的 os.environ 不泄漏）+ extra_env 注入。
- `tests/gateway/test_factory.py`：每个 runtime_selection→正确 (Executor, Driver) 配对；未知→ValueError；sandbox 透传到 executor。
- `tests/gateway/test_executors.py` 扩展：带 sandbox 的真实 stub 子进程（python 吐 JSONL）→ 事件归一正确 + cwd 落在隔离目录 + env 已脱敏（脚本回显 os.getcwd/os.environ 断言）。
- `tests/agent/...`：build_mainline_service(runtime_selection="hermes") 装出 Hermes+Acp（不实跑 hermes）；None→Fake；loop autostart 配置生效（app 起停 scheduler）。

## 验收
- 按 AGENT_RUNTIME 装配真实 runtime；stub 子进程端到端产出归一事件入 timeline。
- 未配置→Fake（行为不变）；未知 selection→显式报错。
- 子进程在隔离 cwd + 脱敏 env 下启动（测试断言）。
- loop 调度可配置自启动。
- `server` 全量 pytest 绿；边界/契约绿；独立盲审通过。
