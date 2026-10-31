# 对话时间、知识上传、人才详情与自动化 UI

## 已确认范围
- 后端允许新增 `last_message_at`：来自真实可见消息，空会话为 null，不使用 updated_at 冒充。
- 知识库保留 NAS 与 FredServer Manager 两种方式，明确来源与认证，不进行跨来源写入重试。
- 人才详情对话必须使用真实授权员工实例，不能用模板 ID 或名称猜测；知识关联只写真实实例。
- 自动化沿用本地调度与现有 API，不改执行语义。

## 实施顺序与文件
1. FredServer `server/agent_service/src/services/conversation-reads.ts` / `http/server.ts`：补齐消息时间摘要和 schema；AITeam `src/lib/conversationSummary.ts` / `stores/chat.ts`：可靠格式化；测试空会话、工具事件、私聊/群聊、已读不改变时间。
2. AITeam `src/pages/KnowledgeBase/`：独立 Manager/NAS 适配，按来源上传，校验文件与反馈，保留批量部分成功；使用 Manager 已存在的知识空间、multipart intake、绑定契约，不创建新存储或 RAG 内核。
3. `src/pages/TalentMarket/`：加载真实招募实例，选择员工后检查本地 readiness、创建会话，提供知识关联和错误反馈，防重复提交与过期异步结果。
4. `src/pages/AutoTasks/`：改善列表/详情层次、筛选空态、加载和窄屏布局，保留调度行为。

## 验证
- 同步新增前端纯逻辑与 API 回归测试、后端真实 HTTP 时间测试。
- LSP、TypeScript、针对性测试、前端构建；运行全量前端测试并区分基线失败。
- 不部署、不修改用户数据、不重打包 sidecar；明确需要导入新版 Agent 才能获得新增时间字段。
- Manager/NAS 真服务联调若无可用凭据，报告未验证，绝不用模拟成功替代。
