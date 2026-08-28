# AI Team

[![Server CI](https://github.com/xiaohei-info/aiteam/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/xiaohei-info/aiteam/actions/workflows/ci.yml)
[![Web CI](https://github.com/xiaohei-info/aiteam/actions/workflows/web-ci.yml/badge.svg?branch=main)](https://github.com/xiaohei-info/aiteam/actions/workflows/web-ci.yml)
[![Deployment checks](https://github.com/xiaohei-info/aiteam/actions/workflows/deploy-ops.yml/badge.svg?branch=main)](https://github.com/xiaohei-info/aiteam/actions/workflows/deploy-ops.yml)

**AI Team 是一个本地优先（local-first）的多 Agent 数字员工平台。**
它把平台运营、企业管理和用户执行拆成三个独立部署单元：Operator、Manager、Agent。
会话、执行过程和本地运行时数据留在用户设备；控制面只接收认证、授权配置、执行快照和脱敏汇总。

> 当前项目处于 v1 重建阶段。`app/` 是冻结的 MVP 参考实现，新的功能统一落在 `server/` 与 `web/`。

## 目录

- [核心能力](#核心能力)
- [架构](#架构)
- [仓库结构](#仓库结构)
- [快速开始](#快速开始)
- [运行服务](#运行服务)
- [测试与质量门禁](#测试与质量门禁)
- [部署](#部署)
- [文档](#文档)
- [贡献](#贡献)
- [安全与隐私](#安全与隐私)
- [许可证](#许可证)

## 核心能力

- **本地优先执行**：私聊、群聊、Run、Task、Loop 和运行时会话在 Agent 本机执行与落库。
- **三端职责清晰**：Operator 管理平台目录，Manager 管理单个企业，Agent 负责用户本地执行。
- **多 Agent 协作**：通过专家实例、授权快照和本地 Pi Session 组合完成私聊与群聊协作。
- **企业知识与记忆**：Manager 管理企业共享 RAG；员工个人记忆通过受控 Hindsight facade 管理。
- **统一运行时边界**：Codex、Claude Code、OpenCode、Hermes 等 runtime 通过 Executor/Driver 接入。
- **可审计、可治理**：只上报脱敏的 usage、审计和治理摘要，不上传会话正文或 runtime 原始事件。
- **可验证 API 契约**：三端提供 FastAPI/Node OpenAPI 文档、统一错误模型和 CI schema 门禁。

## 架构

```text
                         云侧控制面
  ┌──────────────────────┐       service call       ┌────────────────────────┐
  │ Operator              │ ◀────────────────────▶ │ Manager（每企业一套）  │
  │ 平台目录 / 企业开通   │                         │ 成员 / 专家 / 授权 / RAG │
  │ Provider / 价格 / 汇总 │                         │ 企业治理与计量汇总      │
  └──────────────────────┘                         └──────────────┬─────────┘
                                                                    │ Agent 主动 pull
                                                                    ▼
                         用户本地数据面                 ┌────────────────────────┐
                                                        │ Agent                  │
                                                        │ 会话 / Run / Task / Loop│
                                                        │ Pi Session / 本地 SQLite │
                                                        └──────────────┬─────────┘
                                                                       │
                                                        ┌──────────────▼─────────┐
                                                        │ 本机 runtime / MCP / RAG │
                                                        └────────────────────────┘
```

### 三端边界

| 端 | 部署方式 | 主要职责 | 数据边界 |
| --- | --- | --- | --- |
| **Operator** | 平台方部署 | 企业开通、人才市场与方案目录、Provider/模型/价格、跨企业治理 | `oper` 控制库；不执行 Agent、不持会话 |
| **Manager** | 每个企业独立部署 | 企业成员认证、专家/方案配置、成员授权、共享 RAG、员工记忆与企业治理 | 当前企业控制库和数据空间；不持会话、不提交执行 |
| **Agent** | 每个用户本机部署 | 工作台、私聊、群聊、Run/Task/Loop、本地 runtime 执行 | 本机 `agent` 库；会话和执行内容不上传 |

跨端通信遵循最小原则：Agent 主动访问 Manager；Operator 与 Manager 通过受控服务调用；云端不向用户机器建立入站连接。

## 仓库结构

```text
.
├── server/
│   ├── operation_service/     # Operator FastAPI 服务
│   ├── manager_service/       # Manager FastAPI 服务
│   ├── agent_service/         # 用户端 Node Agent（Pi Session + SQLite）
│   ├── shared/                # auth、DB、错误模型、跨端契约与 service client
│   └── run.py                 # 控制面启动器：--tier=operation|manager
├── web/
│   ├── operation/             # Operator 前端
│   ├── manager/               # Manager 前端
│   ├── agent/                 # Agent 前端
│   └── shared/                # 共享 API 基础设施、主题和页面壳
├── deploy/
│   ├── docker/                # Dockerfile 与 Compose
│   └── ci/                    # self-hosted 自动部署脚本与 systemd unit
├── scripts/                   # OpenAPI、部署和本地检查脚本
├── docs/                      # v1 设计、产品、部署运维文档
├── app/                       # 冻结的 MVP，只读参考，不参与 v1 运行
└── .hermes/hermes-agent/      # 外部 Hermes 仓库，独立维护
```

`app/`、旧 `app/.env` 和 `HERMES_WEBUI_*` 运行入口不属于 v1 运行链；不要向冻结目录写入业务逻辑。

## 快速开始

### 环境要求

- Git
- Python **3.12+**
- Node.js **22+**
- pnpm **11.4+**（仓库通过 `packageManager` 固定版本）
- Docker Engine 与 Docker Compose v2（集成测试和本地 Compose 部署需要）

### 安装依赖

```bash
git clone https://github.com/xiaohei-info/aiteam.git
cd aiteam

git checkout main

# Python：仓库根目录共享虚拟环境
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r server/requirements.txt
.venv/bin/pip install pytest pytest-asyncio pytest-timeout pytest-cov diff-cover

# Node/pnpm
corepack enable
corepack prepare pnpm@11.4.0 --activate
cd web
pnpm install --frozen-lockfile
cd ..
```

### 运行最小验证

不需要数据库即可先运行控制面非集成测试和前端检查：

```bash
.venv/bin/pytest -q -m "not integration" server

cd web
pnpm --filter @aiteam/shared run build
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

需要完整环境、PostgreSQL、Playwright 和服务启动细节时，请参阅 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 运行服务

### 控制面服务

控制面服务使用 FastAPI，用户端 Agent 使用独立 Node 进程：

```bash
# Operation
.venv/bin/python server/run.py --tier operation --host 127.0.0.1 --port 8000

# Manager（另开终端）
DB_URL=... ADMIN_DB_URL=... OPERATOR_URL=http://127.0.0.1:8000 \
  .venv/bin/python server/run.py --tier manager --host 127.0.0.1 --port 8001

# Agent（另开终端）
pnpm --dir server/agent_service install --frozen-lockfile
pnpm --dir server/agent_service start
```

每个服务提供：

- `/healthz`：存活检查
- `/readyz`：本端依赖就绪检查
- `/docs`：Swagger UI
- `/redoc`：ReDoc
- `/openapi.json`：运行时 OpenAPI 文档

### 本地 Compose

复制环境模板并按本机修改密码、端口和可选组件配置：

```bash
cp .env.example .env.dev
# 编辑 .env.dev
bash scripts/ctl.sh start --env dev --deploy docker
bash scripts/ctl.sh status --env dev
```

直接调用 Compose 时必须显式指定环境，避免 optional signing/JWT 配置触发环境保护门：

```bash
AITEAM_ENV=test docker compose -f deploy/docker/docker-compose.yml --profile newapi up -d --build
AITEAM_ENV=test docker compose -f deploy/docker/docker-compose.yml ps
```

停止服务：

```bash
bash scripts/ctl.sh stop --env dev
```

## 测试与质量门禁

### 后端

```bash
# 非集成测试（无需 PostgreSQL）
.venv/bin/pytest -q -m "not integration" server

# 集成测试（需要 ADMIN_DB_URL、DB_URL、APP_RW_PASSWORD 和真实 PostgreSQL）
.venv/bin/pytest -q -m integration server
```

### 前端

```bash
cd web
pnpm --filter @aiteam/shared run build
pnpm -r typecheck
pnpm -r test
pnpm -r build
pnpm e2e
```

Playwright 会启动三端服务并检查真实路由、API 契约、Axe 无障碍、键盘焦点、light/dark/reduced-motion 和视觉快照。Linux 与 macOS 使用独立的 `*-linux.png` / `*-darwin.png` 基线。

### OpenAPI 与部署检查

```bash
bash scripts/check-openapi.sh
AITEAM_ENV=test bash scripts/check-deploy.sh
```

前一条命令从 Operation、Manager 和 Agent 真实应用生成临时 OpenAPI 并检查 summary/description、参数、字段、响应、认证和错误模型；生成的 JSON 不是手工维护的契约副本。

GitHub Actions 在 `main`/`feature/**` 和相关 Pull Request 上运行：

- `v1-server-ci`：契约边界、真实 PostgreSQL + RLS、Node Agent、OpenAPI 与覆盖率门禁
- `v1-web-ci`：TypeScript、Vitest、构建、Playwright 三端真实装配
- `deployment-ops-checks`：shell/Compose/凭据边界与部署 dry-run

## 部署

### 测试环境自动部署

合并 Pull Request 到 `main` 后，`deploy-main.yml` 会在带 `taiyi` 标签的 self-hosted runner 上执行：

1. 检查 `/root/app/aiteam` 持久化 Git 工作树、SSH origin、Node/pnpm、Python venv、Docker/Compose 和 systemd。
2. 从 GitHub Secret `ENV_CONTENTS_TEST` 写入 `/root/app/aiteam/.env.test`（不提交、不打印）。
3. 使用 SSH origin 拉取 `main`，重建三端前端产物。
4. 安装/更新 `aiteam-v1.service`，重启服务。
5. 检查三个 `/healthz`、内部 NewAPI 和三端 HTML 入口。

部署根首次初始化和故障排查见 [`deploy/ci/README.md`](deploy/ci/README.md)。该流程要求部署机已经 clone 仓库并把 `origin` 配为 GitHub SSH 地址；部署 workflow 不依赖 runner workspace 的额外 checkout。

### 交付边界

Agent 交付物不包含 Operation/Manager 控制面代码。对应产物由 `deploy/docker/Dockerfile.agent`、`Dockerfile.manager` 和 `Dockerfile.operation` 分别构建，禁止运行时通过一个胖镜像切换端。

## 文档

- **架构总纲与裁决索引**：[`docs/v1正式版本/技术设计/概要设计/00-架构总纲与裁决索引.md`](docs/v1正式版本/技术设计/概要设计/00-架构总纲与裁决索引.md)
- **v1 概要设计**：[`docs/v1正式版本/技术设计/概要设计/`](docs/v1正式版本/技术设计/概要设计/)
- **开发环境与贡献指南**：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- **后端开发说明**：[`server/README.md`](server/README.md)
- **前端工程规范**：[`web/README.md`](web/README.md)
- **部署与运维**：[`deploy/ci/README.md`](deploy/ci/README.md)、[`deploy/docker/README.md`](deploy/docker/README.md) 和 [`docs/部署运维/`](docs/部署运维/)
- **管理员操作指南**：[`docs/管理员操作说明/`](docs/管理员操作说明/)

## 贡献

1. 从 `main` 创建分支：`git checkout -b feat/short-description`。
2. 按约定式提交编写 commit：`feat(scope): ...`、`fix(scope): ...`、`docs(scope): ...`。
3. 新代码只进入对应的 `server/`、`web/` 或 `deploy/` 目录，不扩写冻结的 `app/` 和外部 Hermes 仓库。
4. 变更前端交互、API 或状态契约时同步补测试和文档。
5. 推送并创建 Pull Request；合并前等待相关 GitHub Actions 全部通过。

完整流程、架构边界和代码规范以 [`AGENTS.md`](AGENTS.md)、[`CLAUDE.md`](CLAUDE.md) 与 v1 概要设计为准。

## 安全与隐私

- 不要把 API key、密码、JWT/HMAC 签名密钥、LightRAG/Hindsight 凭据提交到 Git 或写入 issue/log。
- 会话正文、群聊内容、Run/Task 明细和 runtime 原始事件不得上传 Operator/Manager。
- Manager/Operator 只接收授权配置、执行快照和脱敏 usage/audit 摘要。
- 发现安全问题请不要公开提交 issue；请先联系仓库维护者并提供最小复现信息。

## 许可证

当前仓库未包含 `LICENSE` 文件。公开使用、再分发或商用前，请先向项目维护者确认许可证和授权范围。
