---
created: 2026-06-11
updated: 2026-06-11
status: final
tags: [project, aiteam, adr, gateway, runtime, design-deviation]
canonical_name: 2026-06-11-AI Team-Gateway执行链路实现口径与设计差异备案
---

# AI Team Gateway 执行链路实现口径与设计差异备案（ADR）

> 本文是实现口径对概要设计的差异备案，用于后续审查时有据可查。
> 裁决基准：`2026-05-25-AI Team-业务解决方案设计.md`、`2026-05-26-AI Team-技术概要设计.md`。

---

## 1. 差异一：Gateway 执行通道采用 WebUI loopback 复用，而非进程内 SDK 适配（好的差异，正式采纳）

### 1.1 文档原口径

- 概要设计 §2.2：「Agent Gateway 采用基于 Agent Python SDK 模块的进程内运行时适配层」。
- 概要设计 §6.2 工程约束：「V1 实现优先采用基于 Hermes Python 模块的进程内适配层」。

### 1.2 实际实现口径

`agent_gateway/webui_runtime_adapter.py` 通过 loopback HTTP 复用 Hermes WebUI **自己的对话链**：

```
POST /api/session/new   {profile, model, model_provider} -> session_id
POST /api/chat/start    {session_id, message, ...}       -> stream_id
GET  /api/chat/stream?stream_id=...                      -> SSE (token/tool/tool_complete/done)
```

Team Panel、Gateway、WebUI 基座运行在同一进程；执行请求经 loopback 进入 WebUI 已有聊天链，再由其驱动 Hermes Runtime。WebUI loopback 不可达时降级 `hermes -z` CLI 一次性执行。

### 1.3 采纳理由（为什么是好的差异）

1. **复用深度更高**：provider/OAuth 解析、session 持久化、流式 delta、tool-call 呈现、fallback 处理全部来自已验证的 WebUI 链路，无需用 SDK 重新拼装第二套等价实现。
2. **更贴合上位依据**：业务解决方案 §5.2-J 明确「Hermes WebUI 不只是前端参考样例，而是可直接复用的浏览器工作台与后端承载基座」。loopback 复用是该条款的最彻底执行。
3. **无侵入**：基座文件零修改（`api/streaming.py` 自 init commit 后无改动），消费的 SSE 契约与 WebUI 自带前端完全一致，基座升级不破坏适配层。
4. **会话承接天然成立**：WebUI `session_id` 持久化到 conversation 级 RuntimeBinding，跨 turn 上下文延续由基座原生保证。

### 1.4 已知代价与风险（接受并跟踪）

| 风险 | 说明 | 处置 |
|------|------|------|
| HTTP 自依赖 | 同进程多一跳 loopback，WebUI HTTP 层异常时执行链中断 | 已有 CLI 降级路径 |
| 鉴权边界 | adapter 不携带 cookie；若 WebUI auth 开启且 loopback 不豁免，`/api/chat/start` 可能 401 | 待验证项：部署口径需确认 loopback 豁免或注入服务凭证 |
| 原始事件耦合 | 依赖 WebUI SSE 事件名（token/tool/done） | 已隔离在 adapter 单文件内；北向只暴露 timeline 事件 |

### 1.5 结论

**正式采纳 loopback 实现口径**，视为对概要设计 §2.2/§6.2 的实现层修订；概要设计中「进程内 SDK 适配」表述应理解为「进程内复用基座执行链」，不再要求直接调用 Hermes Python SDK。

---

## 2. 差异二：RAG 注入位置上移至 Gateway（中性，阶段性妥协）

- 文档口径（概要设计 §2.2.1）：「Agent Runtime 在执行时完成检索增强注入」。
- 实现口径：`runtime_executor` 在提交前调用 LightRAG 检索，把知识块拼进 prompt 文本（`_compose_prompt`），引用信息随事件/消息回流。
- 评估：MVP 演示场景②（私聊知识问答 + 引用展示）功能等价；注入语义从 Runtime 上移到 Gateway，属阶段性妥协。
- 收口方向：若后续 Hermes 侧具备 profile 级知识源装配，再评估是否下沉，**不作为当前阻塞项**。

---

## 3. 差异三：群聊多智能体编排曾收敛为单 planner 路径（缺口，2026-06-11 起收口）

- 文档口径（业务解决方案 §5.2-C）：「业务协作语义自定义 + 执行 runtime 直接复用」，BRD §7.5 要求任务拆解、依赖排序、并行执行、共享上下文、主持 Agent 汇总。
- Phase 1 曾收敛：orchestration 路由的 run 由执行器按单 planner 单 turn 处理，`runtime_kind=kanban_task` 仅为口径占位，无真实多员工执行。
- **本次收口实现**：新增 `agent_gateway/orchestration_executor.py`，编排语义落在 Gateway（AI Team 自建协作语义），每个子任务仍通过 WebUI loopback 链以受派员工自身 profile/persona/知识执行（执行 runtime 直接复用）：
  1. planner 员工拆解任务（结构化 JSON，解析失败降级为按目标员工均分）；
  2. root/子任务以 `task_created/task_started/task_completed/task_failed` 事件回流，复用 `event_ingest_service` 既有 TeamTask 镜像构建任务树；
  3. 子任务按依赖分波执行，同波并行；失败任务不阻塞其他分支（失败后继续推进）；
  4. 每个子任务产出该员工署名的群聊消息（多智能体并发响应语义）；
  5. planner 汇总轮流式输出，发 `result_merged` 与终态事件。
- 仍开放的收口项：
  - 子任务尚未镜像为 Hermes kanban 真实卡片（`runtime_task_id` 为 Gateway 合成 id）；Phase 2 若需 Runtime 级任务真相，应接 `/api/kanban/*` bridge 或 Hermes delegate_task。
  - 跨子任务的 Hermes session 不做会话承接（每子任务独立 session），属当前有意简化。

---

## 4. 备案结论

| 差异 | 等级 | 状态 |
|------|------|------|
| Gateway loopback 复用 WebUI 执行链 | 好的差异 | 正式采纳，作为实现标准口径 |
| RAG 注入位置上移至 Gateway | 中性 | 接受，跟踪是否下沉 |
| 群聊编排单 planner 收敛 | 缺口 | 2026-06-11 起由 orchestration_executor 收口；kanban 镜像留 Phase 2 |
