> 本文档为 Agent 提供全局指导，确保开发不偏离既定设计。
> 
> **🚀 新环境初始化？先看 [`CONTRIBUTING.md`](./CONTRIBUTING.md)**  
> 如果你是首次接触本仓库、或在新机器/新环境中工作，请先阅读 `CONTRIBUTING.md`——它提供从零开始的完整环境搭建步骤（Python venv、Node/pnpm、Playwright 浏览器、PostgreSQL 容器、环境变量设置），以及运行测试、启动服务的验证清单。本文档假设你已完成环境准备。
>
> **v1 正式架构地基**：`docs/v1正式版本/技术设计/概要设计/`（下称「v1 概要设计」，已按模块拆为 00–11 共 11 篇（01 已并入本文），入口 `00-架构总纲与裁决索引.md`，含「原 § → 新文档」映射与 D1–D24 裁决表）。任何冲突一律以该拆分集为准。
> 详细设计见 `docs/` 目录，Agent 应按需深入阅读。
>
> 本文（AGENTS.md / CLAUDE.md 内容一致）承载**通用工程约束与规范**（设计原则、技术选型、横切关注点、流程约束）——即原拆分集 01 的内容已并入本文，不再单独成篇。模块级设计仍在 v1 概要设计 00–10。

---

## 0. 当前阶段（必读）

AI Team 正从 **MVP 单体**演进到 **v1 三端微服务**架构——v1 是**全新重建**：新架构**不与任何旧端点交互**（无反代、无桥接、无双写），**不迁移旧库数据**（新架构全新建库，测试库数据无需迁移）。

- **正式口径**：v1 概要设计已冻结地基级裁决（D1–D24）。新开发一律按 v1 架构落地。
- **旧实现状态**：`app/` 是冻结的 MVP 单体基座，仅作**契约/实现参考**（状态机、角色、cursor、timeline 等口径对照），**只读不写、不再扩写**；v1 重建稳定后删除。
- **新代码落点**：`server/`（后端）+ `web/`（前端），按端分目录（见 §9）。当前尚未创建，由 v1 开发逐步建立。
- **历史文档**：MVP 阶段的业务方案、概要设计与历史详细设计已归档进 `docs/mvp版本/`，仅作历史参照，**不再作为开发口径**。

---

## 1. 项目定位

**AI Team 是「云侧双控制面 + 用户本地数据面」多 Agent 数字员工平台**，不是单一聊天工具，也不是纯中心化 SaaS。

三端（可独立部署的部署单元）：

- **运营端 Operator（平台运营 SaaS，平台方部署）**：企业开通、人才市场/行业方案目录、平台 Provider/模型/价格与内部 NewAPI Relay、负责人初始凭据、跨企业治理汇总。
- **企业端 Manager（按企业独立部署/绑定的企业管理服务）**：企业成员账号与认证、专家/方案配置、Operator 平台模型只读选择、成员级授权、企业共享 RAG、员工个人记忆与企业治理汇总。一个 Manager 实例只服务一个企业；跨企业目录与治理由 Operator 负责。
- **用户端 Agent（每用户本机自部署）**：工作台、私聊、群聊、Run、Task、Loop——**全部本地执行与落库，会话内容绝不上传**。

核心承诺：

- **本地优先、内容不上传控制面**：会话/群聊/run、usage 原始事件与明细全在用户本机；跨端只流转认证、授权配置、执行快照、脱敏计量/审计聚合摘要。
- **窄通信面**：Operator↔Manager 是云侧受控服务间调用；Agent→Manager 是用户端主动访问；用户机器无入站连接，无中心 Edge/Identity/消息总线。

**术语统一**：「员工」与「专家」指同一概念（数字员工 Agent）。运营端目录存放**模板**，企业端从模板**招募**得到**实例**（`employee` 表 + 企业配置 + 成员级授权），用户端 pull 已授权实例本地装载执行。

核心演示场景（保留 MVP 已验证业务闭环）：私聊+知识库、群聊多专家协作、Loop 自主执行、行业方案应用、治理闭环（摘要上报）。

---

## 2. 架构边界（核心约束）

```
运营端 Operator ⇄ service call ⇄ 企业端 Manager ◀──active access── 用户端 Agent
 (oper 库，多企业)                 (manager_control_db + 单企业数据空间)         (agent 库, 本地)
                                                    └─ Node Agent ─ Pi Session ─ local runtime
```

**三端 + 用户端内组件职责划分：**

| 层级 | 职责 | 禁止事项 |
|------|------|----------|
| **运营端 Operation Service** | 企业开通 / 负责人凭据·重置 / 人才市场·方案目录 / 平台 Provider·模型·价格 / 内部 NewAPI Relay 与 tenant access / 跨企业治理汇总 | 执行 Agent；持会话；调 runtime；持成员密码；向下端入站；向 Agent 下发全平台共享上游/管理 key |
| **企业端 Manager Service** | 单企业数据空间 / 成员账号·认证 / 专家·方案配置 / Operator 平台模型只读选择 / 企业 Relay access 加密投影 / 成员级授权 / 企业共享 RAG / 员工个人记忆治理 / 企业治理与计量汇总 | 承载多个企业；自建 Provider/模型/价格真相；持会话与 Run/Task；提交执行；消费 runtime 原始事件；接收普通会话内容；向用户机器入站 |
| **用户端 Agent Service** | 本地会话/群聊/run/task/loop / 事件流 / pull 装载已授权专家·方案 | 改企业端配置主数据；承担运营治理；直调 runtime CLI；暴露 runtime 原始事件；上传会话明细 |
| **Node Agent（用户端）** | 本地会话、Pi Session、事件流 | 上传会话内容；持控制面业务主数据 |
| **External Capability（用户端本地接入）** | 知识/技能/连接器/MCP 本地执行 | 内部协作编排语义 |

**主链路**：每端前端 → 本端服务（同 origin）；跨系统只走受控窄通道。禁止前端跨端直调、禁止跨端/跨库直写、禁止 Operator/Manager 向用户机器入站。

---

## 3. 核心设计原则

### 3.1 复用优先，不自造底层

- **Hermes 为执行底座之一**（经 `AcpExecutor` + `HermesAcpDriver` 接入），不自建任务编排内核
- **企业知识库**复用 Manager-owned LightRAG（每个 Manager 部署一个企业共享 workspace）、**员工个人记忆**复用 Manager Hindsight facade/受控 Pi Extension、**技能**复用 Hermes skills runtime + SkillHub、**AI Relay** 复用平台内部 NewAPI；Operator 统一维护 Provider/模型/价格并为每企业部署签发受限令牌
- **多 runtime**（Codex / Claude Code / OpenCode / Hermes / OpenClaw）经统一 Executor/Driver 抽象接入，不按品牌堆 adapter（设计借鉴 multica `server/pkg/agent`，Python 重实现）

### 3.2 系统所有权分库，单写者

- 三端按系统所有权分库：Operator 持 oper 库（含 platform_provider/platform_model/platform_model_rate/tenant Relay access 真相与跨企业治理）；Manager 每个部署持一个企业数据空间（含只读平台目录与企业 access 加密投影，可保留 PostgreSQL/RLS 作为防御层）；Agent 持本机 agent 库。
- 每张核心表只有一个写端；跨端读取走 pull API 或本地只读投影，**禁止跨端/跨库直写**
- Manager 内部所有业务数据、RAG workspace、对象存储、缓存、队列/outbox、审计日志都必须绑定当前企业身份；现有实现继续使用 `tenant_id` + TenantContext 作为兼容与认证边界，但不得据此在同一 Manager 实例承载多个企业。

### 3.3 本地优先、内容不上传控制面

- 会话/执行内容、usage 原始事件与逐 token 明细不上传 Manager/Operator；跨端只流转认证、授权配置、执行快照、脱敏摘要
- raw runtime event 仅用户端本地脱敏受控归档（设保留期），不跨端
- 展示态（streaming / waiting_reply / resolved）不写入持久化主状态；状态冲突以本地 Runtime 执行口径为准

### 3.4 窄通信面

- Operator↔Manager 允许云侧服务身份调用；Agent→Manager 只能由用户端主动访问；Operator/Manager **绝不**向用户机器入站/推送。
- 配置变更靠 Agent 周期/触发式 sync 感知；Manager 短暂离线只影响"拉新配置/新登录/摘要上报"，已登录用户凭本地 token + 本地投影 + 已冻结快照继续工作。

### 3.5 Gateway 只做运行时接入

- 不定义企业/员工/权限/账单等业务对象
- Executor 按协议族复用、Driver 收口 runtime 差异；事件先归一再映射为业务时间线，前端不消费 runtime-native event
- 能力适配走**中立 `RunSpec`**：B 类（persona/model/skill）由 Driver 按 runtime 翻译、优先 flag/协议、**不直写 profile 文件**；A 类（知识/记忆/连接器）统一经 MCP 注入。机制详见 v1 概要设计 06 §7.5

### 3.6 企业认证与部署绑定

- 凭据按端持有：负责人 bootstrap 来源归 Operator；负责人重置后凭据、成员凭据与当前企业绑定的签名私钥归 Manager；Agent 只持本会话 token 与公钥/JWKS。一个 Manager 部署不得接受其他企业的 tenant/enterprise 绑定。
- 验签/鉴权/签发为共享库 `shared/auth`，本地无状态验签，**无中心 Identity、无中心 Edge**；v1 直接采用非对称签名，禁止向用户端下发 HMAC 对称签名密钥。
- 登录方式多样性收敛到 `Authenticator` 一层，单一 token 出口（`user` + `auth_identity` 扩展模型）

### 3.7 运行时接入配置（不复用旧 `app/.env`）

runtime（含 Hermes）由用户端 Node Agent 的 Pi Session 管理。**v1 不读取 `app/.env`、不使用旧 `HERMES_WEBUI_*` 运行入口**（旧 WebUI loopback 已废弃）。

### 3.8 工程实现规范（业界成熟实践，不沿用旧代码风格）

- **不参考旧架构 `app/` 的代码风格与实现形态**：`app/` 仅作**业务功能点**参考（有哪些能力、业务口径如何对齐），其分层方式、命名、手写 `_match_prefix` router、巨型单文件、全局可变状态（`STREAMS`/`CANCEL_FLAGS` 等）等写法**一律不沿用**。
- 一律采用**业界成熟的工程架构、代码规范与设计模式**：清晰分层（router / service / repository）、依赖注入、Pydantic schema 作 API 边界、显式统一错误模型、单一职责、面向接口与可测试设计；遵循 FastAPI / Python 社区主流约定（含 `web/` 端对应前端社区约定）。
- 以**最小必要原则**实现目标功能：消除特殊情况优于堆 if 分支，不过度设计，函数短小专注，控制嵌套层级。

---

## 4. 命名映射（三处对齐）

后端模块 ↔ 前端目录 ↔ 接口前缀三处同名对齐：

| 端 | 后端（`server/`） | 前端（`web/`） | 接口前缀 |
|----|------------------|---------------|----------|
| 运营端 | `operation_service/` | `operation/` | `/api/operation/*` + `/api/auth/*` |
| 企业端 | `manager_service/` | `manager/` | `/api/manager/*` + `/api/auth/*` |
| 用户端 | `agent_service/` | `agent/` | `/api/agent/*` + `/api/auth/*` |

- **用户端运行时**：Node `server/agent_service` 内置 Pi Session；不再有独立 Python Gateway
- **Hermes Runtime**：`./.hermes/hermes-agent/`（外部独立仓，禁止写入业务逻辑）
- **历史命名映射**：旧设计文档中的 `Agent Service` ≈ 用户端 `agent_service`；旧 `Team Panel` 已解散按端重分（配置态→Manager、执行态→Agent、开通/治理→Operation）

**弃用旧路径** `/api/team/*`、`/api/system/*`、`/api/enterprise/*`，不留 alias、不做兼容。

---

## 5. 开发顺序（v1 阶段实施，见 v1 概要设计 10）

1. **Phase 0**：架构冻结（已完成）
2. **Phase 1**：三端骨架 + Manager 单企业部署绑定底座 + 入户链 + 企业认证（`shared/auth`）+ `shared` 底座 + Gateway skeleton
3. **Phase 2**：企业端租户配置授权 + 用户端本地主链（私聊/群聊/Loop）+ pull 装载与快照冻结 + streaming parity
4. **Phase 3**：多 runtime 接入（Executor + Driver）
5. **Phase 4**：运营端 + 治理摘要逐级上报闭环

> 各 Phase 的范围/验收口径见 v1 概要设计 10（重建验证与阶段实施），不在此展开。

---

## 6. 文档导航（按需深入）

### 必读（开发前）

| 文档 | 用途 |
|------|------|
| `README.md` | 仓库结构与边界 |
| `docs/v1正式版本/技术设计/概要设计/`（00–11 共 11 篇（01 已并入本文），入口 `00-架构总纲与裁决索引.md`） | **v1 架构地基，唯一裁决口径**（D1–D24 已冻结；总纲含「原 § → 新文档」映射与导航） |
| `docs/部署运维/2026-06-15-AI Team-当前单机部署SOP.md` | 当前单机部署/运行 SOP |

### 历史参照（不再作为开发口径）

- `docs/mvp版本/`：MVP 阶段业务解决方案设计、技术概要设计与历史详细设计文档

---

## 7. 开发检查点

每次提交前自查：

- ✅ 新能力是否落在正确端（Operation / Manager / Agent）与正确目录（`server/` / `web/`）？
- ✅ 是否复用而非自造底层能力？是否采用业界成熟工程实践、未沿用旧 `app/` 代码风格（§3.8）？
- ✅ 前端是否只调本端服务 + 必要窄通道，未跨端直调、未跨库直写？
- ✅ 会话/执行内容是否未上传（本地优先）？跨端是否只流转认证/授权/脱敏摘要？
- ✅ Manager 租户数据是否全部经 TenantContext 访问、绑定 `tenant_id`，未绕过 RLS/隔离底座？
- ✅ 展示态是否未写入持久化主状态？
- ✅ 是否未扩写、未调用、未桥接、未读取冻结的 `app/`（含不读 `app/.env`、不用 `HERMES_WEBUI_*`）？
- ✅ 是否未直接修改 `./.hermes/hermes-agent/` 核心文件？

---

## 8. 风险边界

**高风险操作需确认**：
- 修改 `./.hermes/hermes-agent/` 核心文件
- 修改共享口径（事件协议、游标、状态枚举、跨系统契约、脱敏摘要 schema、Executor/Driver contract）
- 新增/修改北向 API 路径契约
- 修改系统所有权分库的表所有权、Manager 租户隔离策略或主状态枚举

**禁止**：
- 前端跨端直调或绑定 runtime 原始对象
- 跨端/跨库直写；Operator/Manager 向用户机器入站/推送
- 会话内容/执行明细上传企业端/运营端
- Manager 持会话或提交执行；Agent 改企业端配置主数据；Gateway 定义业务对象或权限规则
- 绕过 TenantContext/RLS 访问 Manager 租户数据；业务模块手写 tenant 过滤字符串
- 扩写、平行维护、调用、桥接或读取冻结的 `app/`（含读 `app/.env`、用 `HERMES_WEBUI_*` 旧运行入口）；与旧系统双写；迁移旧库数据
- 重新引入中心 Edge / Identity / 消息总线
- 多文件各自维护 `STREAMS` / `CANCEL_FLAGS` 等全局口径
- 使用 `admin/manager/viewer` 等旧角色枚举
- 向用户端下发可签发 token 的 HMAC 对称密钥

---

## 9. 快速参考

目标态工程结构（单仓，层优先）：

```
server/   # 后端：FastAPI operation_service / manager_service + Node agent_service + shared / run.py
web/      # 前端：operation / manager / agent / shared（按端分离）
deploy/   # docker-compose / Dockerfile / 安装包 / ctl.sh
app/      # 🔒 冻结的 MVP 单体——只读契约参考，v1 重建完成后删除
./.hermes/hermes-agent/  # Hermes Runtime（外部仓，禁止写入业务逻辑）
```

权限角色：企业侧 `owner | enterprise_admin | finance_admin | member`；平台侧 `system_admin | system_operator`（禁用旧 `admin/manager/viewer`）。

**交付物按端精简（D15）**：单仓不拆双仓，控制面启动器 `server/run.py --tier=operation|manager` 仅供 dev；Node Agent 由 `pnpm --dir server/agent_service start` 独立启动。CI 按端产出精简产物，**用户端交付物绝不打包控制面（Operator/Manager）后端与前端代码**；禁止运行时胖产物 / 前端运行时切端。

**关键契约一律以 v1 概要设计为准，不在此复制**：事件协议/游标与状态枚举（07）、Executor/Driver（06 §7.2/§7.3）、能力适配 RunSpec/MCP（06 §7.5）、数据所有权与租户隔离（04）、认证（03）、北向 API 与错误模型（02）。

---

## 10. 规划与实施流程约束

为满足以下的流程规范，Agent 应优先使用自身平台中具备以下能力的 skill、workflow 或工具链，例如 **Superpowers Skills**。 

### 10.1 先规划，后实现

对于跨模块功能、非微小改动、涉及数据结构/API/状态流变化的任务，Agent 不得直接开始编码，必须先形成可执行计划。

计划至少应包含：
- 目标与边界
- 涉及模块与文件路径
- 关键约束与非目标
- 分步骤实施顺序
- 验证方式与完成标准

要求：
- 任务粒度应足够小，避免"大步提交、大块实现"
- 实现者在开始编码前，应先把计划收口到"可按步骤执行"的程度
- 如果需求仍有关键歧义，应先澄清或补设计，而不是边写边猜

### 10.2 按 spec / plan 驱动实施

实现必须受当前任务的计划、设计文档和共享口径约束，不得脱离 spec 自行扩展。

要求：
- 先对照任务 spec / plan 实施，再对照结果回看是否偏离
- 如果发现 plan 不足，应先更新 plan，再继续实现
- 不允许把"实现者自己的理解"替代为正式设计口径
- 不允许在未经收口的情况下擅自扩大范围

### 10.3 测试先行或至少测试同步

任何非一次性原型代码，都应有对应验证；对可测试逻辑，优先采用测试先行或测试同步的方式推进。

要求：
- 新行为应有新增验证
- 修改旧行为应有回归验证
- 不能仅靠手工目测判断"应该没问题"
- 至少应覆盖主路径、边界条件、已知风险点

如果当前环境不适合完整测试先行，也至少要做到：
- 实现前明确验证点
- 实现后立即补齐自动化验证或最小可重复验证脚本

### 10.4 完成前必须独立验证

Agent 不得仅以"代码写完"作为完成标准，必须提供可验证证据。

验证证据可包括但不限于：
- 测试结果
- 构建结果
- 接口调用结果
- 页面/交互验证结果
- 关键日志或状态输出
- before / after 对比

要求：
- 验证应尽量独立于实现过程，避免"写的时候顺手测过"就算完成
- 若无法验证，必须明确说明原因与风险，不能直接宣称完成
- "我认为可以""理论上没问题"不算完成证据

### 10.5 不确定先做小规模验证

当方案、依赖、接口、性能、集成方式存在明显不确定性时，应先做小规模验证，再进入正式实现。

适用场景包括：
- 新技术选型
- 陌生 SDK / API 接入
- 跨系统集成
- 关键状态流 / 事件流设计
- 有较高返工风险的实现路径

要求：
- 验证应尽量小、快、可丢弃
- 目标是回答"是否可行 / 风险在哪 / 哪条路径更稳妥"
- 验证结论应回流到正式计划或设计，而不是让试验代码直接演变成生产实现

### 10.6 调试必须先找根因

出现 bug、联调失败、状态异常、契约不一致时，应先定位根因，再决定修复方案。

禁止：
- 不理解问题就连续试错式改代码
- 同时改多个变量后再碰运气验证
- 用补丁掩盖状态/契约层问题

要求：
- 先确认问题出现在哪一层
- 先区分是设计问题、实现问题、数据问题还是环境问题
- 修复后应补回归验证，避免同类问题再次出现

---

## 11. 能力实现建议（非强制）

为满足 §10 的流程约束，Agent 应优先使用自身平台中具备以下能力的 skill、workflow 或工具链：

- **规划拆解能力**：能把需求转成可执行步骤与实施计划
- **spec / plan 对照执行能力**：能按计划逐步实施并检查偏差
- **测试驱动或测试同步能力**：能在实现过程中生成或维护验证
- **完成前验证能力**：能提供独立、可重复的完成证据
- **小规模验证能力**：能快速做试验性验证并给出结论
- **系统化调试能力**：能先定位根因，再实施修复

如果当前 Agent 环境缺少上述能力，可考虑安装或接入一套通用工程增强型 skill 包，例如 **Superpowers** 类能力集，用于补齐 planning、spec-driven implementation、verification、debugging 等流程能力。

---

## 12. 技术选型（v1 统一）

| 关注点 | 选型 |
|---|---|
| 后端框架 | **FastAPI**（三端各一服务）：原生 OpenAPI / Swagger / ReDoc、Pydantic 作 API 边界、APIRouter 模块化、异步 SSE/WebSocket 成熟；**弃用手写 router / `_match_prefix`** |
| 端入口与认证 | 各端自带 `shared/auth` 中间件；Manager 为当前企业身份源并绑定一个 tenant；无中心 Edge；Agent 本地验签；`tenant_id` 作为兼容企业 claim 贯穿鉴权 |
| 跨系统通信 | Operator↔Manager 云侧服务间调用；Agent→Manager 主动访问；共享 `service_client`（TLS + 服务身份签名） |
| 数据库 | PostgreSQL；Manager 每部署一个企业数据空间，现有 RLS 作为纵深防御；用户端轻量本地库 |
| 治理回流 | Agent→Manager→Operator 脱敏计量/审计摘要上报，替代跨端事件总线 |
| 可观测 | OpenTelemetry + 结构化日志 + Prometheus |
| 运行时 | Executor 协议族 + Driver（用户端，详见 v1 概要设计 06） |

不引入中心消息总线（云侧服务调用 + Agent 主动访问 + 摘要上报即可）。

---

## 13. 横切关注点（可观测 / 健康 / 安全 / 错误模型）

- **可观测性**：结构化日志强制带 `request_id` / `trace_id` / `tenant_id` / `service`；OpenTelemetry trace 端内贯穿 入口 → 服务 →（用户端）Gateway → Executor/Driver，运行事件带 `run_id`；跨端透传 `trace_id`（运行明细不跨端，跨端只见摘要）；各端暴露 `/metrics`。
- **健康检查**：每端提供 `/healthz`（存活）、`/readyz`（仅校验本端 DB；上端不可达按"可降级 pull"对待，不致本端 not-ready）、`/docs`。
- **安全与隔离**：Runtime Worker 必须工作目录隔离、凭据最小注入、环境变量脱敏、工具调用审计、输出脱敏、超时与取消（Agent CLI 可执行 bash/文件/网络/MCP，隔离是硬约束）。
- **统一错误模型**：所有端返回 `application/problem+json`（`type/title/status/code/detail/instance/request_id` + 字段级 `errors`），由入口中间件 / FastAPI exception handler / `service_client` 统一生成与解码；错误体不含密码、token、provider key、会话内容、runtime raw event。接口契约（envelope、分页、幂等、版本）规范详见 v1 概要设计 02。

---

**如有不确定，优先查阅 v1 概要设计（地基级裁决口径）。**
