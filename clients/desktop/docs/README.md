# 桌面客户端文档

这里只放桌面客户端（`clients/desktop`）自己的实现说明。三端架构、接口契约和部署以仓库根的文档为准：

- 架构裁决：`docs/v1正式版本/技术设计/概要设计/`（入口 `00-架构总纲与裁决索引.md`）
- 接口：本机 Agent 的 `/openapi.json`（源码 `server/agent_service`）
- 客户端接入 Agent：`deploy/agent/CLIENT-INTEGRATION.md`、`docs/客户端接入/`

文档和代码不一致时以代码为准，并顺手修正文档。

这些文档 2026-10-30 随代码从 gitee AITeam 仓库（`mwj424/ty-aiteam`，已弃用、只读）迁入，按现行实现重新整理过。旧仓库里的同名文档不再更新，以这里为准；旧路径到新路径的对应关系见 [archive/README.md](archive/README.md)，以及旧仓库的 `MIGRATION.md`。

## 现行文档

| 文档 | 内容 |
| --- | --- |
| [agent-sidecar.md](agent-sidecar.md) | 本机 Agent：当前架构、从源码构建、环境配置与切换、生命周期、接口与登录、排查 |
| [workspace-functions.md](workspace-functions.md) | 对话时间、群聊委派目标、三类知识来源、人才详情 |
| [knowledge-base-provider.md](knowledge-base-provider.md) | 个人知识库服务需要实现的接口 |
| [local-file-access.md](local-file-access.md) | 本机文件访问授权 |
| [work-reply-grouping.md](work-reply-grouping.md) | 员工回复归并 |
| [workbench-agent-solutions.md](workbench-agent-solutions.md) | 工作台：汇总员工生成的方案文件 |
| [automation-tasks-api.md](automation-tasks-api.md) | 自动化任务页面对应的 API 契约 |
| [2026-09-27-application-logging-plan.md](2026-09-27-application-logging-plan.md) | 应用日志：范围、隐私边界与排查指南 |
| [api-audit.md](api-audit.md)、[api.json](api.json) | `pnpm check:api-contract` 的契约副本与生成的核对表；`api.json` 已过期，见 agent-sidecar.md「接口与登录」 |

## 设计基准 `design/`

| 文档 | 内容 |
| --- | --- |
| [new_design.md](design/new_design.md) | 交互说明书：页面结构与产品流程 |
| [设计系统视觉规范.md](design/设计系统视觉规范.md) | 视觉规范，落地以 `src/styles/globals.css` 变量为准 |
| [设计视觉系统参考.html](design/设计视觉系统参考.html) | 视觉样板页 |
| [design_gaps.md](design/design_gaps.md) | 设计已画、实现未就绪的差距清单 |

## 办公室场景 `office/`

| 文档 | 内容 |
| --- | --- |
| [office-map-integration.md](office/office-map-integration.md) | 办公室地图渲染与接入（入口） |
| [office-workstation-design.md](office/office-workstation-design.md) | 工位画法与坐标规范 |
| [adjustment-guide.md](office/adjustment-guide.md) | 场景显示区域等参数的调整位置 |
| [activity-log.md](office/activity-log.md) | 办公室动态日志 |
| [computer-assets.md](office/computer-assets.md) | 电脑图层素材与待办 |

素材裁切样板在 `output/office-elements/v1/`。地图编辑器在单仓的 `clients/office-map-edit-tool/`（说明见其 `README.md` 与 `docs/`），桌面端通过 `link:../office-map-edit-tool` 引用，打包时拷进 `dist/office-editor/`。

## 方案 `plans/`

方案写于实施前，每份开头标明状态；对照实现时先看状态说明。

| 文档 | 状态 |
| --- | --- |
| [2026-10-29-product-design-proposals/](plans/2026-10-29-product-design-proposals/README.md) | 9 项议题：1–7 已实施，8 暂缓，9 未开始 |
| [local-directory-knowledge-design.md](plans/local-directory-knowledge-design.md) | 本地目录检索设计，已实施；开头有 2026-10-30 现状说明 |
| [group-creation-backend-plan.md](plans/group-creation-backend-plan.md) | 创建群聊后端方案，已实施 |
| [automation-tab-feature-plan.md](plans/automation-tab-feature-plan.md) | 自动化 Tab 产品与实现方案 |

## 归档 `archive/`

已废弃或已完成的历史记录，不再作为开发依据，清单和取代关系见 [archive/README.md](archive/README.md)。
