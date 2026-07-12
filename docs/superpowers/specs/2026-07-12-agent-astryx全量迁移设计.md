# Agent Astryx 全量迁移设计

日期：2026-07-12

## 背景与决策

用户已确认三端新前端以 Astryx 为唯一 UI 基础，并要求旧 UI 在新 UI 完成后物理清理、不保留兼容层。Manager 与 Operation 已达到 GO；本设计收口 Agent 用户端的最后一段迁移。

**核心判断：✅ 值得做。** Agent 仍有 19 个组件直接依赖旧 `@aiteam/shared/ui`，且保留 Tailwind、旧 token 与 `.glass` 兼容样式。这不是局部美化，而是完成三端零历史 UI 包袱的必要条件。

## 目标与边界

目标：将 Agent 的登录、壳层、私聊、群聊、工作台、Run/Loop、市场、知识库、办公室、组织、本地同步、设置和终端全部迁为直接使用 Astryx；删除旧 UI、Tailwind 构建链、旧 token CSS 和迁移期 `.glass` 映射；保持用户端本地优先链路与现有 API/路由/语义不变。

非目标：不改 `server/`、不改 `app/` 冻结 MVP、不中转或上传本地会话/执行内容、不改 Agent→Manager 的窄通信协议、不修改 runtime 原始事件模型。

## 方案选择

1. **只清理 CSS，保留旧组件：拒绝。** 表面上快，但 `@aiteam/shared/ui`、Tailwind 以及历史 DOM 仍是技术债。
2. **一次性重写 Agent 全部页面：拒绝。** 私聊、群聊、Run 和本地同步主链风险集中，难以定位回归。
3. **按业务边界分四批直接迁移：采用。** 每批保持 API hooks、DTO、i18n、路由和可访问语义不变；仅替换视图层。每批独立测试、类型检查和提交，最后删链并跑浏览器总门禁。

## 架构与数据流

`use*Api`、本地会话状态、SSE/时间线、认证与 i18n 继续拥有行为和数据；每个页面直接组合 Astryx primitives（`Card`、`Table`、`FormLayout`、`Dialog`、`AlertDialog`、`TabList`、`EmptyState`、`Banner` 等）。

```
路由 / 本地 API hooks / Timeline state
                 ↓
      Agent 页面（直接 Astryx 组件）
                 ↓
      AstryxProviders + AppShell + SideNav
```

不新增项目级视觉 wrapper；当单个文件超过职责边界时，只按业务区块拆成纯展示组件，状态与 API 调用仍归原页面拥有。

## 分批交付

1. **核心对话：** 登录、私聊、群聊及其选择器/输入器/时间线，保留消息→Run 主链、提及和展示态口径。
2. **工作台与执行：** Workspace、Run、Loop、终端，保留创建、取消、刷新与失败后输入保留。
3. **本地能力与配置：** 市场、知识库、办公室、组织、同步、设置，保留本地快照、脱敏摘要和本机配置语义。
4. **清理和上线：** 删除 Tailwind 与旧 UI 依赖，建立零 legacy 扫描；覆盖 light/dark、axe、键盘焦点、浏览器错误、真实私聊发送主链和关键本地页；三端总门禁。

## 关键约束

- Agent 前端只调用本端 `/api/agent/*` 与认证所需本地入口，禁止跨端直调。
- 会话/群聊/Run/Task/Loop 内容继续只在本机执行和落库；展示态不写持久化主状态。
- 失败不能清空用户输入；资源/路由切换时旧异步响应不得覆盖当前状态。
- 所有破坏性操作使用命名 `AlertDialog`；表格、表单和 Dialog 有可访问名称；状态不得只靠颜色表达。
- 新源码禁止 `@aiteam/shared/ui`、Tailwind utility class、`tailwindcss`、`@tailwindcss/vite`、`@source`、旧 token CSS 和 `.glass`。

## 验收标准

- Agent 单测、typecheck、生产构建与 Agent Playwright 全绿。
- 关键路径具有真实浏览器验证：登录、私聊发送→Run、群聊、工作台/Loop、知识库或设置。
- light/dark 快照、axe critical/serious、键盘焦点和 browser console/page error 均通过。
- 零 legacy 自动门禁和静态扫描无命中；`package.json`、Vite、CSS 和 lockfile 不再保留 Agent 的 Tailwind/旧 UI 构建链。
- 最后运行 Manager、Operation、Agent 三端总门禁；用户端构建产物不包含控制面代码。
