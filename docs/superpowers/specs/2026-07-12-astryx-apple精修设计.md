# Astryx Apple 风格精修设计

**目标**：在不改变三端业务 API、路由、数据流或引入新动画依赖的前提下，收口 Astryx 控件使用、提升主题层级与图标一致性，并把前端工程边界写入 `web/README.md`。

## 背景与判断

三端 UI 已完成 Astryx 重构并通过 Linux Playwright、Axe、键盘焦点和 light/dark 视觉门禁。结构审计显示业务层没有自建通用按钮、对话框、表格、抽屉或动画系统；绝大多数页面直接组合 Astryx 组件。

仍存在三类可控缺口：

1. Agent 设置页把语言和流式打字偏好渲染为原生 `select` / `checkbox`，与 Astryx 控件收口目标不一致。
2. Agent 聊天输入器使用 emoji 作为工具图标，跨平台字形和基线不稳定。
3. `aiteamStone` 只覆盖基础色、字体和时长；标题层级、表面层级和交互状态仍可在主题层精修。

## 方案比较

### 方案 A：克制主题与组件组合精修（采用）

- 复用 Astryx `Selector`、`Switch`、`Icon`、`Theme` 和组件级 theme override。
- 以主题 token 和组件 override 调整排版、低层级阴影、卡片与聊天输入器的表面层级。
- 为聊天工具定义少量单色 SVG glyph，并通过 Astryx `Icon` 渲染；不增加第三方图标包。
- 不加入页面转场、拖拽、弹簧或全局 backdrop-filter。

优点：风险低、视觉一致、不会创建第二套设计系统，且不需要改变业务行为。缺点：不会提供可拖拽 sheet 一类的物理交互。

### 方案 B：加入全局玻璃材质与 CSS 动画

- 在所有页面叠加透明层、模糊和入场动画。

不采用：企业端高密度表格和浅色信息页会降低可读性；当前项目没有完整的 `prefers-reduced-transparency` 支持，收益不匹配风险。

### 方案 C：引入 Motion/手势库，全面 Apple 化

- 为抽屉、工作区、卡片和导航加入可中断弹簧与手势。

不采用：Astryx 的通用组件不需要此能力；当前没有真实的拖拽/滑动业务需求。提前引入会扩大依赖与测试矩阵。

## 设计决策

### 1. 单一主题仍是唯一视觉出口

`web/shared/src/theme/aiteam-stone.ts` 是三端共享的主题出口。新增的视觉规则只能通过 `defineTheme` 的 tokens、typography、radius、components 或图标资产表达；业务页面不得写新的全局 CSS、色值或阴影常量。

主题本轮只做以下调整：

- 强化 H1/H2 的字重、紧凑字距与 leading，保持正文系统字体与可缩放性。
- 让默认 Card 与 ChatComposer 使用克制的低层级阴影和边界对比；不使用全局透明玻璃。
- 保持当前 125ms / 250ms 动作尺度；不增加循环装饰动画或页面切换动画。

### 2. 可见控件一律使用 Astryx

Agent 设置页：

- 语言选择使用 `Selector`，label 保持“语言”，值继续写入现有 preferences store。
- 流式打字效果使用 `Switch`，label 与本地优先说明保持可访问。

原生 file input 仍允许作为浏览器文件选择能力的隐藏/受 `Field` 包装实现；它不是可替代的视觉控件。

### 3. 聊天工具使用 Astryx Icon 承载单色 glyph

在共享 theme 目录定义仅供 `Icon` 渲染的四个 SVG glyph：附件、召唤智能体、技能、截图。`MessageComposer` 继续使用 Astryx `Button`、`Popover` 和 `ChatComposer`，仅替换 emoji ReactNode。

图标必须满足：

- `currentColor`、24×24 viewBox、`aria-hidden`；
- 不携带颜色、文字或交互逻辑；
- tool button 的可访问名称继续由现有 `label` / `tooltip` 提供。

### 4. 前端 README 是长期约束，不是迁移记录

在 `web/README.md` 写入：

- 三端/共享包目录和责任边界；
- Astryx 是唯一通用 UI 基座，主题是唯一视觉 token 出口；
- 允许的业务组件与禁止的自建通用组件、散落 CSS、emoji 图标、跨端调用；
- Apple Design 的克制原则：即时反馈、少而明确的动效、系统偏好、无障碍、材料层级；
- Motion/手势只能在真实拖拽需求出现时以独立决策引入，禁止用 CSS keyframes 冒充物理交互；
- 本地验证与 CI 门禁命令。

## 影响范围与非目标

**修改范围**：

- `web/shared/src/theme/aiteam-stone.ts` 与测试；
- 新增共享图标模块并从 theme barrel 导出；
- `web/agent/src/features/settings/SettingsPage.tsx` 与测试；
- `web/agent/src/features/chat/MessageComposer.tsx` 与测试；
- 现有三端视觉快照基线；
- 新增 `web/README.md`。

**明确不做**：

- 不修改 `server/`、接口、持久化、路由和文案语义；
- 不引入 Motion、Framer Motion、手势库或图标库；
- 不修改 Astryx `node_modules`；
- 不做全站玻璃效果、页面转场、循环背景动效；
- 不恢复任何旧 UI、design-system 或 legacy dependency。

## 验证与完成标准

1. Settings 单测先证明 `Selector` 与 `Switch` 的语义、持久化行为；聊天单测先证明工具栏不再输出 emoji 且标签仍可访问。
2. shared theme 单测验证新增排版/组件 token 和图标导出。
3. `pnpm -r test`、`pnpm -r typecheck`、`pnpm -r build` 通过。
4. 更新 Agent light/dark、Manager light/dark、Operation light/dark 截图基线；完整 Playwright smoke 在干净测试库执行。
5. `web/README.md` 明确列出约束，且不与根 `AGENTS.md` 的三端边界冲突。

