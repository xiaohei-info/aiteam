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
    routes      北向 /api/agent/* 路由（含 SSE/WS）

铁律：展示态（streaming/waiting_reply/resolved）只在内存/流，**不写持久化主状态**（D6）。
"""
