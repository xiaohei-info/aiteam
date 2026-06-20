"""用户端本地主链（A1，07 / 05 §5.2，D6）。

conversation / message / run / task + timeline store + 事件归一 + SSE/WS 推送，全部
**本地执行与落库**，会话/执行内容绝不上传控制面（CLAUDE/AGENTS §3.3）。

分层（业界成熟实践，不沿用旧 app/ 单文件/全局态写法）：
    models      领域模型（Pydantic，主状态固定枚举）
    store       仓储接口 + 内存实现（agent 本地库；真实 PG 由后续接入，接口不变）
    event_mapper  AgentRuntimeEvent -> BusinessTimelineEvent（纯映射，runtime 原生名不外泄）
    timeline    TimelineStore：单调 numeric cursor 追加 + 增量拉取
    stream      内存 pub/sub broker（仅流式承载，展示态不落主状态库）
    service     MainlineService：编排 conv/msg/run/task + Gateway run + timeline + 推流
    mentions    @提及解析（纯函数）：文本 -> roster 内专家集合（A2 群聊编排第一步）
    group       GroupChatService：群聊单机多专家 @提及编排，多 run 并入同一 timeline（A2，06 §7.6）
    routes      北向 /api/agent/* 路由（含 SSE/WS、群聊 group-dispatch）

铁律：展示态（streaming/waiting_reply/resolved）只在内存/流，**不写持久化主状态**（D6）。
"""
