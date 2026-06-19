"""用户端运行时接入网关（随 agent_service 部署，06）。

Executor 按协议族复用、Driver 收口 runtime 差异；事件先归一为 AgentRuntimeEvent。
真实 Executor/Driver（Acp/JsonRpcStdio/JsonStreamCli + Hermes/Codex/ClaudeCode/...）由
Track G 工单（11 §4）落地；本包先提供 fake runtime 供 Track A 在真 runtime 前开发主链。
"""
