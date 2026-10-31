# AI Team Desktop — 实施方案（最终版）

> 文档版本：v1.0  
> 日期：2026-05-31  
> 作者：AI 辅助生成，基于 PRD v1.0 需求澄清结果

---

## 一、需求澄清结论

### 架构定位

- 桌面端 = **Tauri 壳 + React 全量 UI + 对接云端 API**
- 核心业务逻辑跑在云端服务（另一个团队负责）
- 桌面端不含本地服务器，不需要 Node.js sidecar
- 离线不可用，给出无网络提示

### MVP 范围（2 周 Demo）

**必须功能：**
- 智能体创建与配置
- 私聊对话（SSE 流式）
- 群聊协作（@提及多智能体）
- 龙虾编排协议（自主委托可视化）
- 长期记忆系统
- 技能市场（ClawHub）
- 组织架构管理
- MCP 服务配置

**必须桌面原生能力：**
- 原生菜单 + 快捷键
- 系统通知
- API Key 安全存储（Keychain）
- 文件拖拽上传

**可后续：**
- OpenClaw Loop 模式
- 图像生成（CogView）
- 系统托盘
- 自动更新
- 暗色/亮色主题切换
- 本地模型（Ollama）
- 国际化
- 埋点统计

### 其他确认项

| 项目 | 决策 |
|---|---|
| AI 模型 | 先支持 DeepSeek |
| API Key | 代理服务提供 |
| 前端框架 | React + TypeScript |
| 设计稿 | 无，参照 PRD 线框图 + 自行设计 |
| 主题 | 暂不做切换，后续支持跟随系统 |
| macOS 窗口 | 系统默认 titlebar |
| 语言 | 仅中文 |
| 账号体系 | 需要登录注册 |
| 数据存储 | 本地 + 云端（具体划分后续定）|
| 多设备同步 | 仅云端数据同步 |
| 分发渠道 | 官网下载 |
| 签名证书 | 暂无，后续申请 |
| 错误上报 | 开发阶段本地日志，上线后集成 |
| 团队 | 2 人，无 Rust 经验 |
| 包管理器 | pnpm |
| 仓库 | 新建独立仓库 |

---

## 二、整体架构

```
┌────────────────────────────────────────┐
│          Tauri 桌面应用                  │
│                                        │
│  ┌──────────────┐  IPC  ┌───────────┐  │
│  │  WebView     │◄─────►│ Rust Core │  │
│  │  React SPA   │       │ (轻量)    │  │
│  │              │       │ • 窗口    │  │
│  │  所有业务 UI  │       │ • 菜单    │  │
│  │              │       │ • 通知    │  │
│  │              │       │ • 文件    │  │
│  └──────┬───────┘       │ • 密钥存储│  │
│         │               └───────────┘  │
│         │ HTTP + SSE                    │
│         ▼                              │
│  ☁️ 云端服务（另一个团队负责）            │
│  • AI 模型调用（DeepSeek 代理）         │
│  • 龙虾编排引擎                         │
│  • Loop 调度                           │
│  • 记忆系统                            │
│  • 用户认证                            │
│  • 数据持久化                          │
└────────────────────────────────────────┘
```

---

## 三、技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 桌面框架 | Tauri 2.x | 窗口/菜单/通知/安全存储 |
| 前端 | React 18 + TypeScript | 业务 UI 全部 |
| 状态管理 | Zustand | 轻量、React 生态主流 |
| 样式 | Tailwind CSS | 快速开发，与 PRD 设计变量契合 |
| HTTP 请求 | Axios | 拦截器统一处理 auth / error |
| SSE | EventSource 原生 + 封装 | 流式消息 |
| 路由 | React Router 6 | SPA 内部路由 |
| 构建工具 | Vite | Tauri 官方推荐，HMR 极快 |
| 包管理器 | pnpm | Tauri 生态主流 |
| Rust 层 | 最少代码，仅原生能力 | 降低无 Rust 经验的风险 |

---

## 四、项目结构

```
ai-team-desktop/
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── icons/
│   └── src/
│       ├── lib.rs              ← Tauri 初始化 + IPC commands
│       └── main.rs             ← 入口（几行代码）
├── src/                        ← React 前端
│   ├── main.tsx                ← 入口
│   ├── App.tsx                 ← 路由 + 布局
│   ├── api/                    ← API 层
│   │   ├── client.ts           ← Axios 实例（auth 拦截器）
│   │   ├── agents.ts           ← 智能体 CRUD
│   │   ├── chat.ts             ← 消息发送 / 历史
│   │   ├── sse.ts              ← SSE 连接管理
│   │   ├── skills.ts           ← 技能市场
│   │   ├── org.ts              ← 组织架构
│   │   ├── memory.ts           ← 记忆系统
│   │   └── mcp.ts              ← MCP 配置
│   ├── stores/                 ← Zustand stores
│   │   ├── auth.ts
│   │   ├── agents.ts
│   │   ├── chat.ts
│   │   ├── ui.ts
│   │   └── ...
│   ├── pages/                  ← 页面组件
│   │   ├── Login/
│   │   ├── Chat/               ← 私聊 + 群聊
│   │   ├── AgentConfig/        ← 智能体配置
│   │   ├── SkillMarket/        ← 技能市场
│   │   ├── OrgChart/           ← 组织架构
│   │   ├── McpConfig/          ← MCP 服务配置
│   │   └── Settings/
│   ├── components/             ← 通用组件
│   │   ├── Layout/             ← 侧边栏 + 主内容区
│   │   ├── MessageBubble/
│   │   ├── AgentAvatar/
│   │   ├── LobsterFlow/       ← 龙虾编排进度卡片
│   │   ├── SkillToggle/
│   │   ├── MemoryPanel/
│   │   └── ...
│   ├── hooks/                  ← 自定义 hooks
│   │   ├── useSSE.ts
│   │   ├── useNetwork.ts      ← 网络状态检测
│   │   └── ...
│   ├── utils/
│   └── styles/
│       └── globals.css         ← Tailwind + CSS 变量
├── index.html
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
└── .github/
    └── workflows/
        └── build.yml
```

---

## 五、分阶段计划（2 周 / 10 个工作日）

### Phase 1：工程搭建（Day 1）

**产出：** 空壳应用能打开窗口、显示 React 页面

| 任务 | 内容 |
|---|---|
| 1.1 | 初始化仓库，`pnpm create tauri-app`（React + TypeScript + Vite）|
| 1.2 | 配置 `tauri.conf.json`：窗口 1280×800、identifier、图标占位 |
| 1.3 | 安装前端基础依赖：`tailwind`、`zustand`、`axios`、`react-router-dom` |
| 1.4 | 搭建 Layout 骨架：左侧 icon 导航 + 中间列表面板 + 右侧主内容区（参照 PRD 原型图三栏布局）|
| 1.5 | 配置 Tailwind + CSS 变量（PRD 色板：brand #2563EB、gray 系列）|
| 1.6 | 验收：`pnpm tauri dev` 显示三栏布局骨架 |

---

### Phase 2：登录 + 网络层（Day 2）

**产出：** 可登录，API 请求链路通

| 任务 | 内容 |
|---|---|
| 2.1 | 登录/注册页面 UI |
| 2.2 | Axios 实例封装：baseURL 配置、token 拦截器（自动附加 Authorization）|
| 2.3 | 登录接口对接，token 存入 Tauri secure storage（`tauri-plugin-store` 或 `stronghold`）|
| 2.4 | 路由守卫：未登录跳转登录页 |
| 2.5 | 全局网络状态检测 hook：`navigator.onLine` + `offline`/`online` 事件 → 断网时全屏遮罩提示"无网络连接" |
| 2.6 | 验收：登录后进入主界面，断网有提示 |

---

### Phase 3：智能体管理（Day 3）

**产出：** 智能体 CRUD + 侧边栏列表

| 任务 | 内容 |
|---|---|
| 3.1 | 智能体列表（左侧面板）：按部门分组展示、头像 emoji、名称、岗位 |
| 3.2 | 创建智能体弹窗：名称、emoji 头像选择、岗位、模型选择（DeepSeek 系列）、System Prompt 编辑器 |
| 3.3 | 智能体详情/编辑面板（右侧抽屉或独立页面）|
| 3.4 | 删除智能体（确认弹窗）|
| 3.5 | Zustand store：agents 列表、当前选中智能体、CRUD actions |
| 3.6 | 验收：可创建/编辑/删除智能体，侧边栏实时更新 |

---

### Phase 4：私聊对话（Day 4-5）

**产出：** 完整的私聊对话体验（SSE 流式输出）

| 任务 | 内容 |
|---|---|
| 4.1 | 聊天界面布局：消息列表 + 底部输入框 + 顶部智能体信息栏 |
| 4.2 | 消息气泡组件：用户消息（右侧蓝色）、AI 消息（左侧灰色）、时间戳 |
| 4.3 | SSE 流式接收：逐 token 渲染、打字光标闪烁、三点等待动画 |
| 4.4 | 推理链（thinking）折叠面板：默认折叠，点击展开 |
| 4.5 | 消息发送：Enter 发送、Shift+Enter 换行 |
| 4.6 | 图片/文件上传（拖拽 + 粘贴 + 按钮选择）|
| 4.7 | 聊天历史加载（分页或滚动加载）|
| 4.8 | 自动滚动到底部（新消息时）|
| 4.9 | 验收：与智能体完整对话，流式输出流畅，文件可发送 |

---

### Phase 5：群聊协作 + 龙虾编排（Day 6-7）

**产出：** 群聊多智能体协作 + 编排流程可视化

| 任务 | 内容 |
|---|---|
| 5.1 | 群聊创建：选择成员智能体、设置群名 |
| 5.2 | 群聊列表（侧边栏独立区域）|
| 5.3 | 群聊对话界面：多智能体消息区分（不同头像/名称标注）|
| 5.4 | @提及交互：输入 `@` 弹出成员下拉列表，选择后高亮显示 |
| 5.5 | 多智能体并发响应展示 |
| 5.6 | **龙虾编排卡片**：检测到 `<delegate>` 后渲染编排进度卡片，每个子任务一行（智能体名 + 任务描述 + 状态），进行中脉冲动画，完成绿色勾 |
| 5.7 | 编排卡片折叠/展开详情 |
| 5.8 | 汇总回复：所有子任务完成后主持者输出总结 |
| 5.9 | 验收：群聊中 @全员 触发龙虾编排，看到逐步执行过程 |

---

### Phase 6：长期记忆 + MCP 配置（Day 8）

**产出：** 记忆面板 + MCP 服务器管理

| 任务 | 内容 |
|---|---|
| 6.1 | 记忆面板（智能体详情右侧）：按类型筛选（fact/experience/reflection/plan）|
| 6.2 | 记忆条目卡片：类型标签 + 内容摘要 + 重要性指示 + 时间 |
| 6.3 | 手动添加/删除记忆 |
| 6.4 | **MCP 配置页面**：MCP 服务器列表（名称 + URL + 状态）、添加/编辑/删除 MCP 服务器、为每个智能体勾选可用的 MCP 服务、连接状态测试（ping）|
| 6.5 | 验收：记忆可查看管理，MCP 服务可增删配置 |

---

### Phase 7：技能市场 + 组织架构（Day 9）

**产出：** 技能安装管理 + 部门/岗位树

| 任务 | 内容 |
|---|---|
| 7.1 | **技能市场页面**：技能卡片网格（图标 + 名称 + 简介 + 安装按钮）、分类 Tab 筛选、搜索框 |
| 7.2 | 技能详情弹窗：完整说明 + 安装/卸载 |
| 7.3 | 智能体技能配置：Toggle 开关列表，即时生效 |
| 7.4 | **组织架构页面**：部门树形结构展示、创建/编辑/删除部门、岗位管理（职级 1-5 + 颜色）、智能体分配到部门/岗位 |
| 7.5 | 统计看板：部门总数 / 岗位总数 / 智能体总数 / 分配覆盖率 |
| 7.6 | 验收：技能可浏览安装，组织架构可配置 |

---

### Phase 8：原生能力 + 体验打磨（Day 10）

**产出：** 桌面原生体验完整 + 整体打磨

| 任务 | 内容 |
|---|---|
| 8.1 | **原生菜单**：文件（新建智能体 ⌘N / 搜索 ⌘K）、对话（清空 ⌘L / 切换 ⌘↑↓）|
| 8.2 | **系统通知**：群聊新消息 / 编排任务完成 / 异常告警（窗口非前台时触发）|
| 8.3 | **文件拖拽**：窗口内拖入文件 → 预览 → 确认上传 |
| 8.4 | **API Key 安全存储**：设置页中输入 Key → 存入 Tauri Stronghold → 展示时脱敏 |
| 8.5 | **断网处理**：全局网络监听，断网时所有操作给出统一提示 |
| 8.6 | **动效补齐**：消息气泡 fadeUp、编排卡片 slideIn、侧边栏切换过渡 |
| 8.7 | **整体 UI 走查**：对照 PRD 线框图逐页面核对 |
| 8.8 | 验收：完整可演示 Demo |

---

## 六、两人分工建议

| 开发者 | 负责范围 | 原因 |
|---|---|---|
| **Dev A（偏前端）** | Phase 2-5：登录、智能体管理、私聊、群聊、龙虾编排 | 核心对话体验，需要精打磨 SSE 和动效 |
| **Dev B（偏全栈）** | Phase 1 + 6-8：工程搭建、记忆、MCP、技能市场、组织架构、Tauri 原生能力 | Tauri 配置和原生能力涉及少量 Rust |

两人 Day 1 一起搭建工程，Day 2 开始并行开发。

---

## 七、与服务端团队对接需求

桌面端需要云端提供以下 API（建议尽早对齐）：

| 模块 | 需要的 API |
|---|---|
| 认证 | POST `/auth/login`、`/auth/register`、`/auth/refresh` |
| 智能体 | CRUD `/agents`、`/agents/:id` |
| 对话 | POST `/chat/send`、GET `/chat/history/:conversationId`、**SSE** `/chat/stream` |
| 群聊 | CRUD `/groups`、POST `/groups/:id/send`、SSE `/groups/:id/stream` |
| 龙虾编排 | SSE `/orchestration/stream`（子任务状态实时推送）|
| 记忆 | CRUD `/agents/:id/memories` |
| 技能 | GET `/skills/market`、POST `/agents/:id/skills/install`、DELETE `uninstall` |
| 组织架构 | CRUD `/departments`、`/positions`、PATCH `/agents/:id/assign` |
| MCP | CRUD `/mcp/servers`、POST `/mcp/servers/:id/test`、GET `/agents/:id/mcp` |
| 文件 | POST `/files/upload`（multipart） |

---

## 八、风险与应对

| 风险 | 应对 |
|---|---|
| 服务端 API 未就绪 | 前端用 Mock 数据开发（推荐 MSW），API 就绪后替换 |
| Rust 经验不足导致 Tauri 配置踩坑 | Rust 层保持最小化（<200 行），大部分用官方插件解决 |
| 2 周时间紧张 | 先保证核心链路（登录→创建智能体→对话），其他页面允许功能简化 |
| SSE 在不同网络环境下不稳定 | 封装自动重连机制（指数退避）|

---

## 九、Tauri 插件清单

| 需求 | 插件 |
|---|---|
| 密钥存储 | `tauri-plugin-stronghold` |
| 系统通知 | `tauri-plugin-notification` |
| 文件对话框 | `tauri-plugin-dialog` |
| 外部链接 | `tauri-plugin-shell` |
| 窗口状态持久化 | `tauri-plugin-window-state` |
| 本地持久存储 | `tauri-plugin-store` |

---

## 十、后续演进路径

| 阶段 | 内容 |
|---|---|
| v0.4 | OpenClaw Loop 模式、系统托盘、自动更新 |
| v0.5 | 暗色/亮色主题切换（跟随系统）、图像生成 |
| v0.6 | 本地模型支持（Ollama）、触发器可视化 |
| v1.0 | 应用商店上架、错误上报、企业版功能 |
