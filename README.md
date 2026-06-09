# AI Team

## 当前项目结构

```text
aiteam/
├── app/            # AI Team 主项目代码
├── docs/           # 需求文档、业务方案、概要设计、详细设计、架构图
├── scripts/        # 项目级脚本
├── .hermes/
│   └── hermes-agent/ # 外部 Hermes Agent 源码仓库（独立 Git，不归 aiteam 主仓管理）
├── .gitignore
├── README.md
```

## 各目录职责

### `app/`
AI Team 当前的主开发目录。

承载：

- Team Panel 北向业务接口
- Agent Gateway 进程内适配层
- 页面、BFF、SSE、会话宿主与上传/工作区等可复用基座能力

注意：
- `app/` 已经归属 `aiteam` 主仓管理
- 后续主要开发工作默认都落在这里
- 项目原则上优先**新增业务模块 / 适配层**，避免继续把 AI Team 业务大量堆进上游巨型基座文件

### `docs/`
AI Team 的正式文档目录，包含需求、方案、设计和架构图。

这是当前项目最重要的非代码资产，已经形成一套可用于进入实施阶段的设计输入。

### `scripts/`
项目级脚本目录。

存放：

- 开发环境初始化脚本
- 本地启动脚本
- 集成检查脚本
- 发布/部署辅助脚本

### `./.hermes/hermes-agent/`
Hermes Agent 外部源码仓库。

说明：
- 它是一个**独立 Git 仓库**
- 当前默认放在仓库内的 `./.hermes/hermes-agent/`，主要是为了方便 `app` 近场引用 Hermes Runtime / Python SDK 能力
- **不归 `aiteam` 主仓 Git 管理**，根目录 `.gitignore` 已忽略 `.hermes/`
- 运行入口路径以 `app/.env` 中的 `HERMES_WEBUI_AGENT_DIR` 为准

治理原则：
- AI Team 产品逻辑不应写进 `./.hermes/hermes-agent/`
- 若未来必须改 Hermes，本仓应只承载最小补丁、可复用增强或通用能力改进
- 默认策略仍然是：**能外挂就外挂，能配置就配置，能 wrapper 就 wrapper**

## 代码与仓库边界

当前仓库采用的是：

- **aiteam 主仓**：承载产品代码与设计文档
- **hermes-agent 外部仓**：承载运行时源码，不纳入主仓提交

因此请注意：

1. `git -C /home/ubuntu/code/aiteam status` 不会纳管 `./.hermes/hermes-agent/`
2. `./.hermes/hermes-agent/` 的拉取、切分支、同步上游，应在其目录内单独操作
3. `app/` 是 AI Team 的正式代码主干，不再按“轻量 fork 保持长期紧跟上游”来治理

## 文档导航

`docs/` 目录当前分为两大块：

### 1. `docs/需求文档/`
包含业务输入和页面参考材料，例如：

- `需求文档.md`
- `AI Team — 商业产品文档（BPD）.pdf`
- `AI-Team-PRD.html`
- `AI-Team-PRD-v2.html`
- `AI-Team-Demo.html`
- `AI-Team-Office.html`
- `具体页面描述.docx`

这些文档回答的是：
- 业务目标是什么
- 页面和交互想表达什么
- 演示口径和产品诉求是什么

### 2. `docs/技术设计/`
包含当前 AI Team 的正式设计体系。

建议先读：

1. `技术设计.md`
   - 技术设计总导航
   - 说明当前有哪些正式设计产物、阅读顺序和开发建议

2. `2026-05-25-AI Team-业务解决方案设计.md`
   - 业务视角的方案正式稿

3. `2026-05-26-AI Team-技术概要设计.md`
   - 系统级概要设计
   - 说明分层、模块职责、边界与复用判断

4. `2026-05-27-AI Team-技术详细设计.md`
   - 详细设计主稿 / hub 文档
   - 说明 Team Panel、Agent Gateway、Hermes Runtime 的总体映射关系

5. `详细设计文档/2026-05-28-AI Team-共享运行口径定稿版.md`
   - 当前跨模块共享契约的唯一裁决口径
   - 重点冻结：事件协议、游标、主状态机、北向 API 最小固定契约、权限角色模型

6. `详细设计文档/` 下的 5 份模块级详细设计子文档
   - `2026-05-27-AI Team-Team Panel领域模型与数据架构详细设计.md`
   - `2026-05-28-AI Team-Team Panel内部服务与聚合视图详细设计.md`
   - `2026-05-27-AI Team-Agent Gateway运行时适配与事件流详细设计.md`
   - `2026-05-27-AI Team-会话群聊编排Loop核心流程详细设计.md`
   - `2026-05-27-AI Team-前端页面与接口契约详细设计.md`

### 3. `docs/resources/`
存放当前正式架构图产物：

- 业务解决方案架构图
- 系统架构图
- 功能架构图

同时保留 `.svg` 与 `.html` 版本，便于浏览和后续继续编辑。

## 当前设计口径

当前项目已经形成以下统一口径：

- **Team Panel**：业务控制面，负责企业、员工、模板、会话、任务、治理、审计等业务对象
- **Agent Gateway**：运行时适配层，负责把业务请求翻译成 Hermes Runtime 可执行对象，并统一承接事件回流
- **Hermes Runtime / Hermes Agent**：执行事实层，负责 Profile、Session、Task、Cron、Memory、Skills 等真实运行机制

一个重要原则是：

> AI Team 不自建复杂任务编排内核，而是做业务任务与 Hermes 既有运行机制之间的转换、翻译和包装。
>
> 凡涉及 Python 解释器、Hermes CLI、Hermes Home 或 config 的运行入口，必须优先复用 `app/.env` 中的 `HERMES_WEBUI_PYTHON`、`HERMES_HOME`、`HERMES_CONFIG_PATH`、`HERMES_WEBUI_AGENT_DIR`，禁止裸用其他 Python/Hermes 环境作为主路径。

## 历史命名与当前目录映射

当前设计文档中仍可能出现历史命名。为了避免阅读歧义，统一按下面的映射关系理解：

- **Agent Service** / `agent-service`
  - 对应当前仓库中的 **`app/`**
  - 含义：AI Team 主项目代码目录，也就是当前承载 Team Panel 与 Agent Gateway 二次开发的代码基座

- **Agent Runtime** / **Hermes Runtime**
  - 对应当前仓库中的 **`./.hermes/hermes-agent/`**
  - 含义：外部 Hermes Agent 运行时源码仓库，提供 Profile、Session、Task、Cron、Memory、Skills 等真实执行机制

因此，阅读设计文档时可以直接做如下替换理解：

- 文档里写 `Agent Service`，当前项目里看 `app/`
- 文档里写 `Agent Runtime`，当前项目里看 `./.hermes/hermes-agent/`

这两个名字反映的是**设计分层语义**，而 `app/`、`./.hermes/hermes-agent/` 反映的是**当前仓库物理目录结构**。两者并不冲突。

## 备注

当前部分设计文档正文中仍可能出现：

- `Agent Service`
- `agent-service`
- `Agent Runtime`
- 基于早期目录结构的路径示例

这些主要反映的是设计演进过程中的历史口径。**以当前仓库实际结构为准**：

- 主项目代码目录：`/home/ubuntu/code/aiteam/app`
- 外部运行时源码目录：`/home/ubuntu/code/aiteam/.hermes/hermes-agent`

如果你第一次进入这个仓库，建议按下面顺序理解项目：

1. 先看本 README，理解仓库结构和边界
2. 再看 `docs/技术设计/技术设计.md`，理解设计文档地图
3. 再看 `app/README.md`、`app/ARCHITECTURE.md`，理解当前代码基座
4. 开发时默认把 AI Team 新能力优先落在 `app/` 的新增模块中，而不是直接扩写旧的大文件
5. 不要把 AI Team 业务逻辑写入 `./.hermes/hermes-agent/`
