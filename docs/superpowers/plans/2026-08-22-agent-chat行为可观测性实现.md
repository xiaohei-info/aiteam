# Agent 聊天行为实时可观测性实现计划

## 目标

让 Agent 私聊和群聊页面通过现有 Pi SSE + Pi entries 实时显示：

- 思考/推理内容（仅受 Pi 已提供的 bounded content，不能泄漏凭据、路径或隐藏运行时对象）
- 工具调用及结果
- Todo 列表
- Hindsight 记忆检索/写入
- Manager RAG knowledge_search/knowledge_get 及 bounded citation 摘要
- 群聊 coordinator/委托 child 的来源专家标识

## 边界与非目标

- 不建立 Run/Task/Timeline 产品执行模型；继续以 Pi event/entry 为事实源。
- 不把原始 provider 响应、完整记忆内容、凭据、文件路径或隐藏 chain-of-thought 上传到控制面。
- 不直连 LightRAG；RAG 仍只走 Manager MCP。
- Todo 作为 Pi custom tool 的结构化输入/结果，不新建持久化 Todo 表。
- 重用现有 SSE、TimelineView 和 GroupPage，不引入新 UI 依赖。

## 实施步骤

1. **冻结安全事件映射**
   - 扩展 Agent SSE 的 bounded event metadata：tool kind、memory/rag/todo 分类、来源 child/employee。
   - 对 tool args/results 做现有 redact + bounded serialization，禁止 secret/path。
   - 为 delegation child 事件附加可展示的 employee id/display name。

2. **Pi Todo custom tool**
   - 添加最小 `todo_update` custom tool，输入为有界 todo item 列表，结果可由 Pi event/entry 回放。
   - 只在 snapshot tool policy 显式允许时注册，保持授权边界。
   - 增加工具输入校验和 Agent 单元测试。

3. **前端 Timeline 扩展**
   - 扩展卡片模型和安全解析：思考增量、工具 args/结果摘要、Todo 列表、memory、RAG citation、来源专家。
   - 对 `hindsight_*`、`knowledge_*`、`todo_update` 渲染专用卡片；普通工具继续通用卡片。
   - 群聊显示 child/source employee，保留 coordinator/child 的事件顺序和实时状态。
   - 严格 bounded、脱敏，不显示完整原始响应。

4. **回放与实时一致性**
   - 复用 entries + SSE 去重；实时卡片和刷新/重开页面使用同一分类逻辑。
   - 对 tool start/update/end 按 toolCallId 合并或至少稳定显示状态，避免无限重复。

5. **验证**
   - Backend：event metadata、redaction、todo tool、child source tests。
   - Agent frontend：classification/card rendering、memory/RAG/todo/source tests。
   - 运行 Agent TypeScript、Node tests、前端 typecheck/tests/build、Python tests（若后端改动影响共享契约）、diff-check。

## 完成标准

- 私聊可实时看到 thinking、tool、memory、RAG、Todo 卡片。
- 群聊可实时看到 coordinator/child 行为，并标记来源专家。
- 页面刷新或重新打开会话仍能从 Pi entries 显示同类卡片。
- 未授权工具不会因为 UI 改动而注册；敏感信息不会进入 SSE/UI。
- 所有新增行为有自动化验证。
