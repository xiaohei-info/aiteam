# AI Team

**AI Team 是「云侧双控制面 + 用户本地数据面」的多 Agent 数字员工平台。** Operator 与 Manager 是平台方云侧控制面，Manager 是多租户企业管理 SaaS；Agent 是每用户本机数据面。会话与执行全部在用户本机本地化，**内容不上传 Manager/Operator**。

正式架构地基见 `docs/v1正式版本/技术设计/概要设计/`（下称「v1 概要设计」，已按模块拆为 00–11 共 11 篇（01 已并入 CLAUDE/AGENTS），入口 `00-架构总纲与裁决索引.md`，含「原 § → 新文档」映射与 D1–D24 裁决表）。任何冲突一律以该拆分集为准。

## 当前阶段

项目正从 **MVP 单体**（`app/`）演进到 **v1 三端微服务**（`server/` + `web/`）。v1 是**全新重建**——不与旧端点交互、不迁移旧库数据。

- `app/`：冻结的 MVP 单体基座，仅作**契约/实现参考**，**只读不写、不再扩写**，v1 重建稳定后删除。
- `server/`、`web/`：v1 新架构落点，按端分目录，由 v1 开发逐步建立（**当前尚未创建**）。

新开发一律落在 `server/` + `web/`，按 v1 概要设计的三端边界推进。

## 目标态仓库结构（v1，单仓·层优先）

```text
aiteam/
├── server/                # 后端（Python / FastAPI）
│   ├── operation_service/ # 运营端：企业开通 / 目录治理 / 跨企业汇总
│   ├── manager_service/   # 企业端：配置 / 授权 / 成员认证
│   ├── agent_service/     # 用户端：本地会话与执行
│   ├── agent_gateway/     # 用户端运行时接入网关（Executor + Driver）
│   ├── shared/            # service_client / auth / 错误模型 / db / schema base
│   └── run.py             # 统一启动器 --tier=operation|manager|agent
├── web/                   # 前端（JS/TS），按端独立工程/独立构建
│   ├── operation/         # 运营端前端
│   ├── manager/           # 企业端前端
│   ├── agent/             # 用户端前端
│   └── shared/            # page-shell / api-client 基类 / timeline-client / i18n / 设计系统
├── deploy/                # 三端 docker-compose / 各端 Dockerfile / 安装包 / ctl.sh
├── docs/                  # 需求、业务方案、技术设计、部署运维
├── scripts/               # 项目级脚本
├── app/                   # 🔒 冻结的 MVP 单体基座——只读契约参考，v1 重建完成后删除
├── .hermes/
│   └── hermes-agent/      # 外部 Hermes Agent 源码仓（独立 Git，不归 aiteam 主仓管理）
├── .gitignore
└── README.md
```

> `server/`（后端）与 `web/`（前端）层优先对称，各端目录一一对应；按端独立构建、按端产物精简。**无中心 Edge Gateway**——认证下沉为 `server/shared/auth` + 各端服务自带入口中间件。

## 三端边界

| 端 | 部署位置 | 职责 | 库 |
|----|----------|------|----|
| **运营端 Operator** | 平台方中心化 SaaS | 企业开通、负责人凭据、人才市场/行业方案目录、跨企业治理汇总 | oper（中心） |
| **企业端 Manager** | 平台托管多租户 SaaS | tenant 管理、成员账号与认证、专家/方案配置、成员级授权、企业 RAG、企业治理与计量汇总 | manager_control_db + tenant data space（中心，按 tenant 隔离） |
| **用户端 Agent** | 每用户本机自部署 | 工作台/私聊/群聊/Run/Task/Loop——全本地执行不上传；Agent Gateway 接入多 runtime | agent（本机） |

**跨端通信只有两类窄通道**：

- Agent → Manager：成员登录认证、拉取已授权专家/方案与执行快照、上报脱敏计量/审计摘要
- Operator ↔ Manager：云侧服务间调用，用于企业开通/负责人 bootstrap 同步/目录发布、招募专家或方案包拉取、企业级汇总上报

用户机器**无入站连接**；Operator/Manager 绝不向用户机器推送。Manager 短暂不可用只影响"拉新配置/新登录/摘要上报"，已登录用户凭本地 token + 本地投影 + 已冻结快照继续工作。

## 各目录职责

### `server/`（后端，目标态）
三端 FastAPI 服务 + 用户端 Agent Gateway + 共享后端包。统一启动器 `run.py --tier=operation|manager|agent` 只挂载对应端的 router / DB / migrations；CI 按端产出三个精简产物，**用户端交付物绝不打包控制面代码**。

### `web/`（前端，目标态）
三套独立前端工程，按端分离、按端独立构建；公共能力（设计系统、i18n、timeline-client、api-client 基类）抽到 `web/shared` 复用。每端前端只调本端服务 `/api/<tier>/*`（同 origin），跨系统访问只能由本端服务端或本机 Agent Service 通过 `service_client` 发起，由各端服务自身静态托管。

### `app/`（冻结，只读参考）
MVP 单体基座，仅作**契约/实现参考**（状态机、角色、cursor、timeline 等口径对照基线），**只读不写、不再扩写**，v1 重建稳定后删除。v1 是**全新重建**：新架构**不与任何旧 `app/` 端点交互**（无反代、无桥接、无双写），**不迁移旧库数据**（新架构全新建库）。

**无运行期例外**：v1 **不读取 `app/.env`、不使用 `HERMES_WEBUI_PYTHON`/`HERMES_HOME`/`HERMES_CONFIG_PATH`/`HERMES_WEBUI_AGENT_DIR` 等旧 WebUI loopback 环境变量**（该执行链已废弃）。runtime（含 Hermes）经 Agent Gateway 的 Executor/Driver 接入，启动配置由各 Driver 在用户端自身配置声明（见 v1 概要设计 §7.3）。`app/` 仅作只读契约参照，不参与 v1 运行链。

### `docs/`
AI Team 的正式文档目录，包含需求、业务方案、技术设计、部署运维与架构图。详见下文「文档导航」。

### `scripts/` / `deploy/`
`scripts/` 存放项目级脚本（开发环境初始化、本地启动、集成检查）；`deploy/` 为 v1 目标态，承载三端 docker-compose、各端 Dockerfile、安装包与 `ctl.sh`。

### `./.hermes/hermes-agent/`
外部 Hermes Agent 源码仓——**独立 Git 仓库**，不归 aiteam 主仓管理（根 `.gitignore` 已忽略 `.hermes/`）。拉取/切分支/同步上游应在其目录内单独操作。v1 中 Hermes 经用户端 Agent Gateway 的 `HermesAcpDriver`（ACP）接入，CLI 路径/参数由该 Driver 配置声明（见 v1 概要设计 §7.3），**不再依赖旧 `app/.env` 的 `HERMES_WEBUI_*` 运行入口**。

治理原则：AI Team 业务逻辑不写进 `./.hermes/hermes-agent/`；必须改 Hermes 时只做最小补丁或可复用增强。Hermes 经 `AcpExecutor` + `HermesAcpDriver` 作为多 runtime 之一接入，不作默认特例写进上层业务。

## 文档导航

### 必读（开发前）

| 文档 | 用途 |
|------|------|
| `README.md` | 仓库结构与边界 |
| `docs/v1正式版本/技术设计/概要设计/`（00–11 共 11 篇（01 已并入 CLAUDE/AGENTS），入口 `00-架构总纲与裁决索引.md`） | **v1 架构地基，唯一裁决口径**（三端边界、Manager 多租户隔离、认证、Agent Gateway、D1–D24 裁决；总纲含「原 § → 新文档」映射与导航） |
| `docs/部署运维/2026-06-15-AI Team-当前单机部署SOP.md` | 当前单机部署/运行 SOP |
| `CLAUDE.md` / `AGENTS.md` | Agent 开发全局指导与边界约束 |

### 需求与产品输入：`docs/需求文档/`
业务输入和页面参考材料（BPD、PRD、Demo、页面描述等），回答"业务目标是什么、页面交互想表达什么、演示口径是什么"。

### 历史参照（不再作为开发口径）：`docs/mvp版本/`
MVP 阶段的业务解决方案设计、技术概要设计与历史详细设计文档，以及 `docs/mvp版本/resources/` 下的架构图产物。仅作演进历史参照，**v1 开发以 v1 概要设计为准**。

## 当前设计口径（v1）

- **运营端 Operation**：平台运营控制面，负责企业开通、目录治理、负责人 bootstrap、跨企业汇总。
- **企业端 Manager**：平台托管多租户企业管理控制面，负责 tenant 数据隔离、成员账号/认证、专家/方案配置、成员级授权、企业 RAG、企业治理。
- **用户端 Agent**：本地数据面，负责会话/群聊/run/task/loop 全本地执行，pull 装载已授权专家/方案。
- **Agent Gateway（用户端内）**：通用运行时接入网关，把运行请求接入不同本地 runtime 并输出统一运行事件。
- **外部能力复用**：知识=LightRAG、记忆=mem0、技能=Hermes skills/SkillHub、连接器；统一经 MCP 注入、本地执行、内容不出本机（机制见 v1 概要设计 §6.6/§7.5）。

> 能力适配、事件协议、状态枚举、认证等详细契约一律以 v1 概要设计为准，本文只作仓库结构与边界导航。

核心原则：

> AI Team 不自建复杂任务编排内核，而是做业务任务与多 runtime 既有运行机制之间的转换、翻译和包装。
>
> 系统所有权分库、单写者、Manager tenant 隔离、本地优先内容不上传控制面是硬约束。runtime（含 Hermes）经 Agent Gateway 的 Executor/Driver 接入，启动配置由各 Driver 在用户端自身配置声明；v1 **不复用旧 `app/.env` 与 `HERMES_WEBUI_*` 运行入口**（旧 WebUI loopback 链已废弃）。

## 第一次进入本仓库的阅读顺序

1. 先看本 README，理解三端边界与"MVP→v1 重建"现状
2. 再读 v1 概要设计，理解三端架构地基与 D1–D24 裁决
3. 读 `CLAUDE.md` / `AGENTS.md`，掌握开发边界与流程约束
4. 开发时把新能力落在 `server/` + `web/` 的对应端目录，不扩写冻结的 `app/`
5. 不要把 AI Team 业务逻辑写入 `./.hermes/hermes-agent/`

# e2e test marker (will be reverted after pipeline validated)

# e2e test marker 2 (will be reverted after pipeline validated)

# DEPLOY_PIPELINE_TEST_3 20260702T021150Z

# E2E_PIPELINE_TEST_4 20260702T021922Z

# E2E_PIPELINE_TEST_5_SCRIPT_AND_SCRIPT_LINK_FIX 20260702T022809Z

# E2E_PIPELINE_TEST_6_FINAL_VALIDATION 20260702T023524Z
