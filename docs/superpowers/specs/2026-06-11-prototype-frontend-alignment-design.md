# 前端对齐产品原型迭代 — 设计文档

- 日期：2026-06-11
- 基准原型：`docs/需求文档/AI-Team-Demo.html`
- 目标前端：`app/static/aiteam/`（vanilla-JS，page-shell.js 路由 + pages/*.js 模块 + styles.css）

---

## 1. 目标与边界

**目标**：以产品原型 Demo.html 为视觉/布局/交互基准，迭代现有 5 个前台页面，交付与原型一致的页面、布局与交互。

**总体原则（已与用户确认）**：
- 原型作**视觉/布局/交互基准**，**保留**现有真实后端联调（Hermes/LightRAG/Team Panel API）与 SSE/timeline 流式能力。
- **保留**原型未覆盖的模块：workbench（工作台）、admin（企业后台）、system（系统后台）。这些不在本次范围。
- Chat 左栏改为**智能体列表（原型式）**，底层保留真实多会话能力（每个智能体映射其会话）。
- 推进方式 **A**：只重写各页面模块 `render*()` 输出的 DOM 结构 + 在 styles.css 增补原型缺失的组件样式。数据层/路由/API/SSE **不动**。

**非目标**：
- 不改路由表、不改 API 契约、不改后端。
- 不改 admin/system/workbench 页面。
- 不引入前端框架或构建工具（保持 vanilla-JS + 动态 script 加载现状）。
- 不删除现有真实数据绑定能力（引用/附件/重试/停止/分页/SSE）。

**关键事实**：现有 `styles.css` 已使用与原型完全相同的 GitHub-dark token（`#0d1117` / `#161b22` / `#2f81f7` / `#3fb950` 等）。配色无需重做，差异在结构/布局/交互/组件样式。

---

## 2. 涉及模块与文件

| 页面 | 模块文件 | 差距 |
|------|----------|------|
| Chat | `app/static/aiteam/pages/app-chat.js` | MAJOR |
| 人才市场 | `app/static/aiteam/pages/app-marketplace.js` | MINOR |
| 组织架构 | `app/static/aiteam/pages/app-org.js` | MAJOR |
| 知识库 | `app/static/aiteam/pages/knowledge.js` | MINOR |
| 办公室动态 | `app/static/aiteam/pages/office.js` (+ `office-scene.js`) | MAJOR |
| 样式 | `app/static/aiteam/styles.css` | 增补组件样式 |

不改：`page-shell.js`、`api-client.js`、`timeline-client.js`、`role-state.js`、`state-helpers.js`、`index.html` shell。

---

## 3. 逐页设计

### 3.1 Chat（MAJOR）

**布局**：三栏 — 左「智能体列表」/ 中「聊天线程」/ 右「智能体详情」。

**左栏（最大改动）**：从"会话历史列表"改为原型式智能体列表。
- 分组：📌 置顶 / 💼 工作群组 / 🤖 其他智能体。
- 每项：渐变底+emoji 头像、状态点（online/busy/offline）、名称、角色副标题、时间、未读气泡。
- 顶部搜索框（复用现有过滤逻辑）。
- 数据源：现有会话/员工列表 API；每个智能体映射其会话。点击切换 = 加载该会话（复用现有 `init`/会话加载逻辑）。
- **降级**：若员工无会话，点击时按现有逻辑创建/进入会话；分组信息（置顶/群组）若后端无字段，则按"全部归入其他智能体"降级，不阻塞。

**中栏（聊天线程）**：气泡与事件卡片对齐原型。
- 用户气泡右对齐 + brand 描边圆角；助手气泡左对齐。
- 新增「思考中」气泡（三点跳动动画）。
- 新增「工具调用卡」（紫色左边框、等宽字体）— 映射 timeline 中 tool_call 类事件。
- 新增「龙虾编排卡」（橙色左边框、步骤 done/running/pending）— 映射编排/Loop 步骤事件。
- **降级**：timeline 无对应事件类型时，工具卡/编排卡不渲染（不显示空壳）。保留现有 transcript/streaming 渲染兜底。
- 输入区保留现有能力（引用最新/登记附件/重试/停止），工具栏视觉对齐原型（📎 @ / 📷 + 模型标签 + 圆形发送键）。

**右栏（详情）**：对齐原型。
- 头像卡 + 运行统计（完成任务/成功率/平均响应）+ 技能标签 + 记忆片段 + 使用模型。
- 数据用现有 `employee_summary`；缺字段（统计/记忆）按占位/隐藏降级，不造假。

### 3.2 人才市场（MINOR）

现有结构已接近（搜索 + 分类 chips + 排序 + 卡片网格 + 分页）。仅视觉打磨：
- 专家卡：顶部 hover 渐变条、头像渐变底、评分/热度行、分类标签 chip、底部「查看详情 + 立即招募」。
- 对齐原型卡片留白、圆角、hover 抬升效果。
- 保留现有招募交互（确认/招募中/已招募 + 成功后导航按钮）。

### 3.3 组织架构（MAJOR）

从嵌套列表改为**可视化树形图**。
- 根节点（CEO/企业）→ 部门/负责人层 → 成员层，节点间用连线（CSS 连接线，参考原型 `.org-tree`/`.org-line-v`/`.org-line-h`）。
- 节点卡：头像 + 名称 + 角色/状态。
- 数据源：现有 `getOrgTree()` 返回的 departments/members。将现有 `renderDepartment`/`renderMember` 的列表输出改为树形节点 + 连线布局。
- 保留现有等价归属调整（PATCH）能力，作为节点点击后的次级交互或下方控件。
- **降级**：层级过深/过宽时容器可横向滚动（原型 `.org-page` 为 `overflow:auto`）。

### 3.4 知识库（MINOR）

现有结构接近（KB 卡片网格 + 上传/搜索/绑定表单）。补齐：
- 顶部 4 项统计条：知识库数量 / 文档总数 / 向量分片 / 存储占用（数据用现有 KB 列表聚合；无字段则降级为可得项，如知识库数量、文档总数）。
- KB 卡视觉对齐原型：图标、名称、`N 文档 · 更新于…`、底部进度条。
- 保留现有创建/上传/搜索/绑定/重试交互。

### 3.5 办公室动态（MAJOR）

引入**等距 canvas 场景**，移植原型自包含 canvas 渲染逻辑并适配现有数据源。
- Canvas：等距地砖、办公桌、显示器（带状态文字/进度条）、座椅、agent 形象、落地窗、绿植、氛围粒子。
- 交互：拖拽平移、滚轮缩放、hover tooltip（名称/任务数/成功率/响应/当前任务）、点击跳转到该 agent 的 Chat。
- 数据源：现有 office 聚合接口（`sceneData.seats` / `summary` / `feedData.items`）。将原型硬编码的 `LOBBY_AGENTS` 替换为 seats 映射。
- 底部三栏：🦞 任务队列 / 📊 今日统计 / 📡 实时日志（用现有 feedData/summary，原型的随机动画退化为真实数据 + 轻量动画）。
- **降级**：无 seats 数据时显示"暂无工位数据"占位；canvas 不可用时回退到现有 CSS 座位网格（保底，不强制移除）。
- 现有的视口 pan/zoom 按钮、全屏、轮询保留，绑定到 canvas 视图状态。

### 3.6 styles.css 增补组件

新增/调整（沿用现有 `aiteam-*` 命名）：
- Chat：`aiteam-chat__agent-list`、状态点、未读气泡、思考中气泡（三点动画）、工具卡（紫边）、编排卡（橙边 + 步骤状态）。
- 人才市场：卡片 hover 渐变条、评分/热度、标签 chip。
- 组织架构：树形节点 + 连线（v/h line）。
- 知识库：统计条、卡片进度条。
- 办公室：canvas 容器、tooltip、底部三栏（任务/统计/日志）。

---

## 4. 分步骤实施顺序

按"先 MINOR 打磨建立样式底座，再啃 MAJOR"的顺序，便于逐页独立验证：

1. **styles.css 组件样式底座** — 先补齐各页要用的组件类（气泡/卡片/树/canvas 容器等），为后续页面提供样式支撑。
2. **人才市场（MINOR）** — 卡片视觉对齐。
3. **知识库（MINOR）** — 统计条 + 卡片进度条。
4. **组织架构（MAJOR）** — 树形图布局。
5. **Chat（MAJOR）** — 左栏智能体列表 + 中部事件卡片 + 右栏详情。
6. **办公室动态（MAJOR）** — 等距 canvas 移植 + 数据适配 + 底部三栏。

每步内：改 `render*()` → 改 styles.css → 验证该页。

---

## 5. 验证方式与完成标准

**验证手段**（依据项目记忆 `demo-server-separate-checkout`）：
- 8787 端口跑的是另一份 checkout，本 checkout 的改动不会出现在那里。
- 验证用：从 SSD1T checkout 起独立端口服务 `set -a; . app/.env; set +a; HERMES_WEBUI_PORT=8790 app/.venv/bin/python app/server.py`，或渲染自包含 `file://` 预览并用 chrome-devtools MCP 截图。
- 现有页面有 `*.test.js`（如 `app-marketplace.test.js`、`admin-*.test.js`）；改动后跑相关测试防回归。

**完成标准（每页）**：
- 页面结构/布局/交互与原型对应页一致（截图比对）。
- 现有真实数据绑定与交互能力不丢失（发送/引用/附件/重试/分页/招募/上传/搜索/PATCH/pan-zoom）。
- 相关 `*.test.js` 通过（或同步更新断言以匹配新结构，不降低覆盖）。
- 无 console error。

**整体完成标准**：
- 5 个前台页面均与原型视觉/布局/交互一致。
- admin/system/workbench 未受影响。
- 后端联调链路（Hermes/LightRAG/Team Panel）未破坏。

---

## 6. 风险与降级原则

- **数据字段缺失**：原型是纯 mock，部分展示字段（运行统计、记忆片段、向量分片数、存储占用）后端可能无对应数据。一律**降级为占位或隐藏，不造假**。
- **Office canvas 工作量最大**：原型 canvas 代码自包含、纯前端，可直接移植；风险在数据适配。保留 CSS 网格作为回退，不强制删除。
- **测试断言绑定旧结构**：改 DOM 结构会触发 `*.test.js` 失败。需同步更新断言以匹配新结构，覆盖不降低。
- **不破坏 SSE/timeline**：Chat 中部改的是渲染层，事件订阅/游标逻辑不动。
