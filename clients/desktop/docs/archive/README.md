# 归档

以下文档描述的是已废弃的架构，或是已完成的计划与排查记录。原文不再修改，只供追溯；当前做法见右列。

| 文档 | 为什么归档 | 现在看哪里 |
| --- | --- | --- |
| [API_DESIGN.txt](API_DESIGN.txt) | 2026-06 的早期接口设想（WebSocket、Hermes 风格 HTTP、前端 SQLite 双写），未落地 | [agent-sidecar.md](../agent-sidecar.md) |
| [api-hermes.md](api-hermes.md)、[AI-MSG-SEND-FIX.md](AI-MSG-SEND-FIX.md) | 旧 Hermes 运行时接口与踩坑记录，Hermes 已移除 | 同上 |
| [api-agent-migration.md](api-agent-migration.md) | Hermes → Agent 迁移记录，已完成；代码注释仍引用其中章节 | 同上 |
| [macos-three-service-integration.md](macos-three-service-integration.md) | 2026-09-10 的「后台 8783 + 本机 Agent」分流与 10-20 的网关转发说明，10-23 起已不转发 | [agent-sidecar.md](../agent-sidecar.md)「当前架构」「环境切换」「接口与登录」 |
| [AI-Team-Desktop-Plan.md](AI-Team-Desktop-Plan.md) | 项目初期两周实施方案 | — |
| [description.md](description.md) | 初期需求描述 | [design/new_design.md](../design/new_design.md) |
| [todo.md](todo.md) | 2026-09-08 核对的待办清单，之后未维护 | [design/design_gaps.md](../design/design_gaps.md) |
| [单聊功能核查与实施记录.md](单聊功能核查与实施记录.md)、[登录退出排查记录.md](登录退出排查记录.md) | 一次性核查与排查记录 | — |
| [plans/2026-10-19-local-directory-remote-session-gap.md](plans/2026-10-19-local-directory-remote-session-gap.md) | 网关模式方案（本机 Agent 转发到远端），10-23 已撤掉 | [plans/local-directory-knowledge-design.md](../plans/local-directory-knowledge-design.md) |
| [plans/local-directory-knowledge-implementation.md](plans/local-directory-knowledge-implementation.md)、[plans/local-directory-knowledge-pr.md](plans/local-directory-knowledge-pr.md) | 本地目录知识库的实施计划与 PR 说明，已合入 | 同上 |
| [plans/2026-10-07-conversation-knowledge-talent-automation.md](plans/2026-10-07-conversation-knowledge-talent-automation.md) | 已实施的阶段计划 | [workspace-functions.md](../workspace-functions.md) |
| [plans/2026-10-08-local-knowledge-integration.md](plans/2026-10-08-local-knowledge-integration.md) | 撤下本机副本知识库的调整记录，已实施 | [local-file-access.md](../local-file-access.md) |
| [plans/2026-10-28-employee-unavailable-notice.md](plans/2026-10-28-employee-unavailable-notice.md) | 员工不可用提示，已实施 | — |
| [reference/cc-haha-api-layer.md](reference/cc-haha-api-layer.md)、[reference/cc-haha-conversation-module.md](reference/cc-haha-conversation-module.md) | 第三方 cc-haha（Claude Code 开源实现）的源码阅读笔记，不是本项目代码 | — |
