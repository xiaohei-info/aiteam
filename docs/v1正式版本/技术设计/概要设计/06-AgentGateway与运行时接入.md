---
created: 2026-06-15
updated: 2026-06-18
status: frozen-baseline
canonical: true
part_of: v1 概要设计（拆分集）
tags: [project, aiteam, technical-design, gateway, runtime, executor, driver, runspec]
---

# AI Team v1 概要设计 · 06 Agent Gateway 与运行时接入

> **本篇定位**：用户端通用运行时接入网关——运行请求/事件模型、Executor 协议族分层、Driver runtime 差异收口、Runtime Worker 形态、中立 RunSpec + 能力 MCP 注入 + 每 runtime 映射、本地编排与 Loop。
> **对应落点**：`server/agent_gateway`（Executor + Driver），随 `agent_service` 部署在用户端；编排/Loop 在 `server/agent_service`。
> **关联裁决**：D7（Worker 形态）、D16（能力适配/RunSpec）、D17（记忆 mem0）、D18（provider 凭据）、D19（编排/Loop 归属）。
> **配套阅读**：[00 总纲](00-架构总纲与裁决索引.md)、[07 事件流](07-事件流与对话页.md)（AgentRuntimeEvent→Timeline 映射）、[04 §6.6/§6.7](04-数据架构与多租户隔离.md)（外部能力 / provider 凭据）、仓库根 `CLAUDE.md`/`AGENTS.md` §13（Worker 安全隔离）。
> 本篇为 v1 地基级裁决口径，与其它篇冲突时以 [00 §20 裁决表](00-架构总纲与裁决索引.md) 为最终仲裁。

---

## 7. Agent Gateway 通用运行时设计

> **部署位置**：Agent Gateway 与本地 runtime 都运行在**用户端**进程内/同机，与本地 Agent Service 共址。运行请求与运行事件**全程不跨端**；下文抽象（Executor/Driver/事件归一）与部署边界变更无关，沿用。

### 7.1 运行请求与运行事件

Agent Gateway 接收标准运行请求：

```text
AgentRunRequest
  run_id / tenant_id / enterprise_id
  conversation_id / task_id / loop_id
  employee_snapshot / runtime_selection
  input_messages / attachments / workspace_policy
  tools / mcp / skills / knowledge refs
  resume_session_id / timeout / cancellation policy
```

输出统一运行事件：

```text
AgentRuntimeEvent
  event_id / run_id / seq / type / source / timestamp / payload
```

事件类型最小集合：`status` / `text_delta` / `reasoning_delta` / `tool_call_started` / `tool_call_completed` / `command_started` / `command_output` / `file_operation` / `usage` / `artifact` / `error` / `completed` / `cancelled`。

Gateway 职责是把不同 runtime 原始事件归一到该集合，**不负责渲染前端 UI**。

### 7.2 Executor 分层（按协议族）

| Executor | 协议形态 | 适用 runtime |
|---|---|---|
| `AcpExecutor` | ACP / JSON-RPC over stdio | Hermes，及任何兼容 ACP 的 agent |
| `JsonRpcStdioExecutor` | 自定义 JSON-RPC over stdio | Codex app-server，及未来类似 runtime |
| `JsonStreamCliExecutor` | JSONL / stream-json stdout | Claude Code、OpenCode、OpenClaw JSON 模式，及兼容 JSON stream 的 CLI |
| `PlainCliExecutor` | 普通 stdout/stderr（非首批重点） | 仅降级能力，不作生产首选 |

Executor 负责通用机制：进程启动/退出；stdin/stdout/stderr 管理；超时、取消、idle watchdog；session resume 生命周期；原始日志采集；原始事件读取；backpressure 与批量 flush；脱敏前置钩子。

### 7.3 Driver 分层（按 runtime 差异）

Driver 负责：CLI 路径与默认参数；runtime capability 声明；初始化握手；prompt/message/tool/MCP 配置注入方式；原始事件 schema 解析；session_id/thread_id 提取；usage 提取；错误归类。

> **runtime 启动配置的唯一归属**：runtime（含 Hermes）的可执行路径、参数、运行环境一律由对应 Driver 在用户端自身配置中声明，是 v1 runtime 接入配置的唯一来源。`HermesAcpDriver` 经 ACP 启动/连接 Hermes，**取代旧 WebUI loopback 执行链**；旧 `HERMES_WEBUI_PYTHON`/`HERMES_HOME`/`HERMES_CONFIG_PATH`/`HERMES_WEBUI_AGENT_DIR` 与 `app/.env` 在 v1 一概不再使用。

首批 driver：

| Driver | Executor |
|---|---|
| `HermesAcpDriver` | `AcpExecutor` |
| `CodexJsonRpcDriver` | `JsonRpcStdioExecutor` |
| `ClaudeCodeJsonStreamDriver` | `JsonStreamCliExecutor` |
| `OpenCodeJsonStreamDriver` | `JsonStreamCliExecutor` |
| `OpenClawJsonStreamDriver` | `JsonStreamCliExecutor` |

该结构避免"每个 runtime 一整套 executor"的重复，也避免把 JSON stream / JSON-RPC / ACP 混成一个模糊抽象。

### 7.4 Runtime Worker 与部署形态

1. **Local Worker**：用户端本机直接运行 runtime CLI。**这是本架构的默认与主形态**——会话/执行本地化、内容不上传，天然落在 Local Worker。
2. **Daemon Worker**：用户本机运行 runtime daemon，向同机 Gateway 上报可用 CLI、版本、模型能力与心跳；适合一机多 runtime 的管理，仍是本地范畴。
3. **Cloud Worker**：平台托管 runtime worker（隔离容器、弹性调度）。**与"本地优先/不上传"取向相悖，仅作为企业显式选择的可选项**，非默认。

**裁决（D7）**：首期实现 **Local Worker + 清晰 Worker 接口**，Daemon Worker **接口同步设计、实现后置**，Cloud Worker 列入后续且默认关闭。不一开始把调度系统做复杂。

### 7.5 能力适配：中立 RunSpec + 能力 MCP 注入 + 每 runtime 映射（借鉴 multica）

> **设计借鉴**：本节抽象参考开源项目 **multica**（`github.com/multica-ai/multica`，`server/pkg/agent/`）的运行时适配机制——单一 `Backend.Execute(ctx, prompt, opts)` 接口 + runtime 中立入参 + 归一事件流 + 每 runtime 一个适配文件。我们以 Python 重实现其**设计**（非拷贝代码），落为 Executor/Driver 契约。

**核心裁决（D16）**：员工的 persona / 模型 / 技能 / 知识 / 记忆 / 连接器配置，**不再像旧架构那样写进 runtime 原生 profile 文件**（旧 `SOUL.md` / `MEMORY.md` / `skills/` 目录 / `config.yaml` 直写一律废弃）。改为：业务层只产出**中立 `RunSpec`**，由 Driver 翻译注入，**优先级 协议/flag > 文件**，文件 materialize 仅作个别 runtime 的最后兜底（run 作用域临时产物，不碰共享 profile）。

#### 7.5.1 中立 RunSpec（runtime 无关，由 EmployeeExecutionSnapshot 派生）

```text
RunSpec
  system_prompt        # ← persona（中立文本，不写 SOUL.md）
  model                # ← Operator 发布的中立 model id；Manager 只能从 tenant 可见平台目录选择
  provider_ref         # ← Operator 平台 Provider 引用（内部 NewAPI Relay，见 04 §6.7；不内联明文凭据）
  provider_version / model_version / pricing_version
  pricing_snapshot     # ← 非敏感 Decimal rate card；一次 Run 冻结，用于 Agent 本地计费
  thinking_level       # ← 中立 reasoning/effort 档位
  mcp_config           # ← 能力统一注入通道（见 7.5.2）
  resume_session_id    # ← 续接上次 session
  custom_args          # ← 透传参数（必须过 Driver 的 denylist 安全过滤）
  timeout / cancellation
```

#### 7.5.2 A 类能力：统一经 `mcp_config` 注入（runtime 无关）

知识 / 记忆 / 连接器 / 技能（无原生机制时）本质都是"运行时按需访问的工具"，**一律打包进 `RunSpec.mcp_config`**，对任何支持 MCP 的 runtime 同构注入：

| 能力 | 本地 MCP 提供者 | 说明 |
|---|---|---|
| 知识 | LightRAG 本地检索 MCP | 已授权知识集索引产物，本地检索 |
| 记忆 | **mem0 / OpenMemory** 本地 MCP | 本机记忆库读写，跨 runtime 可移植 |
| 连接器 | 连接器 MCP/tool | 调用时最小权限注入凭据 |
| 技能（降级） | 技能包装为 MCP tool | 仅当 runtime 无原生技能机制 |

#### 7.5.3 B 类能力：中立字段 → Driver 按 runtime 翻译（优先 flag/协议）

| 中立字段 | Claude Code | Hermes(ACP) | Codex/其它 | 兜底 |
|---|---|---|---|---|
| `system_prompt` | `--append-system-prompt` | ACP session 参数 | 各自 inline/flag | 仅个别 runtime 需文件时临时生成 |
| `model` | `--model <id>` | ACP `session/set_model` RPC | flag / `--agent` by id / 空则 CLI 默认 | —— |
| `thinking_level` | `--effort` | 协议字段 | 各自 | —— |
| `mcp_config` | 写临时文件 → `--mcp-config` | 经 ACP 注入 | 各自 MCP 入口 | —— |
| `resume_session_id` | `--resume <sid>` | ACP session | 各自 | 落地校验失败则清空回退 |
| 技能（原生） | 原生 skill 机制 | profile skills（Driver 内封装） | 各自 | 降级见 7.5.2 |

模型目录：Operator 统一维护**发布目录 + 动态发现 + 人工价格覆盖**；Manager/Agent 只消费 tenant 可见投影。Driver 可报告 runtime capability，但不得建立绕过 Operator 的第二套业务模型目录。

#### 7.5.4 规则与兼容

1. **配置真相 runtime 中立、存企业端 Manager**；snapshot/RunSpec 不含任何 runtime 原生格式。
2. **Driver 是唯一翻译点**；网关核心与业务层不碰 runtime 原生文件/参数。
3. **能力声明 + 优雅降级**：Driver 声明支持的 materialization（原生技能?原生记忆?persona 注入方式?）；不支持的回落到 7.5.2 的 MCP 投影或明确标 unsupported，**绝不静默丢弃**。
4. **安全**：`custom_args` 必须过 Driver 的参数 denylist（防止破坏协议/越权 flag）。
5. **向后兼容 Hermes**：旧 `profile_capability.py` 的 SOUL/MEMORY/skills/config 写入逻辑**不再需要**（persona 走协议、记忆/知识走 MCP）；如个别能力仍需 Hermes profile 文件，封装在 `HermesAcpDriver` 内、run 作用域临时生成，**不手改 `.hermes/hermes-agent/`**。

### 7.6 本地编排、Loop 与 runtime 选择（用户端 Agent Service 侧）

run 的**触发与编排**是用户端 Agent Service 的职责，统一收敛为"构造 `RunSpec` → 提交 Agent Gateway"，runtime 无关：

- **runtime 选择**：每个 employee 实例在配置中声明默认 runtime（`runtime_binding`）；Agent Service 提交 run 时按 `runtime_selection` 选 Driver，能力不匹配（如所选 runtime 无某协议）则按 §7.5.4 的能力声明降级或明确报错，**不静默切换**。用户可否手动切 runtime 留详设。
- **本地多专家协作编排（群聊 @提及）**：群聊只是**单用户本机多专家协作**（[00 §19 非目标](00-架构总纲与裁决索引.md) 已排除跨机器会话同步）。@提及路由由 Agent Service 解析，被提及的每个专家**各自以其快照构造独立 RunSpec、各起一个 run**，多 run 事件并入**同一会话时间线**（按 run_id 区分来源）；编排为串行/并行的调度策略与防回环（避免互相 @ 触发死循环）留详设。
- **Loop/周期任务**：由用户端**本地调度器**（runtime 无关，**不依赖 `hermes cron`**）持有 cron/触发配置，到点构造 RunSpec 经 Gateway 执行；**仅在用户端运行期执行**（`CLAUDE.md`/`AGENTS.md` §8 风险边界·工程取舍），关机即不跑，不做服务端常驻代跑。调度器实现与持久化留详设。

> 以上三者都不引入新的 runtime 耦合：编排/Loop 只负责"何时、以哪个专家快照"发起 run，真正的 runtime 差异仍只活在 Driver（§7.5）。
