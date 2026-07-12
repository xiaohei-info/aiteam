# Agent Astryx 全量迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将用户端 Agent 的所有页面直接迁移至 Astryx，并物理移除旧共享 UI、Tailwind 与迁移兼容样式，同时保证本地优先的聊天、群聊、Run、Loop 和同步语义不变。

**Architecture:** 保留现有 `use*Api`、DTO、路由、认证、i18n、TimelineStore 与本地状态所有权；仅替换表现层。页面直接组合 `@astryxdesign/core` primitives，不新增视觉兼容 wrapper。大页面按业务区块拆分，异步请求仍由原页面拥有并以 request id/cleanup 避免旧响应覆盖新状态。

**Tech Stack:** React 19、TypeScript、Astryx 0.1.4、Vitest、Testing Library、Playwright、axe。

## Global Constraints

- Agent 前端仅调用本端 `/api/agent/*` 和本地认证入口；不得跨端直调。
- 会话、群聊、Run、Task、Loop 与原始执行内容只留本机；展示态不写持久化主状态。
- 消息发送后仍必须依次走 message → run；群聊仍走 `group-dispatch`；本地同步仍只上报脱敏摘要。
- 所有失败保留用户输入；路由/会话切换时旧请求不可覆盖当前展示。
- 破坏性操作使用带名称的 `AlertDialog`；表格、表单和 Dialog 必须可访问；状态文本不可只由颜色表达。
- 新源码禁止 `@aiteam/shared/ui`、Tailwind utility `className`、`.glass`、`tailwindcss`、`@tailwindcss/vite`、`@source` 与旧 token CSS。
- 不修改 `server/`、`app/` 或 `.hermes/`。

---

### Task 1: 登录、应用壳与私聊核心交互

**Files:**
- Modify: `web/agent/src/pages/LoginPage.tsx`
- Modify: `web/agent/src/pages/LoginPage.test.tsx`
- Modify: `web/agent/src/app/providers.tsx`
- Modify: `web/agent/src/components/PageShell.tsx`
- Modify: `web/agent/src/features/chat/ChatPage.tsx`
- Modify: `web/agent/src/features/chat/ConversationList.tsx`
- Modify: `web/agent/src/features/chat/ConversationStateControl.tsx`
- Modify: `web/agent/src/features/chat/RosterPicker.tsx`
- Modify: `web/agent/src/features/chat/MessageComposer.tsx`
- Modify: `web/agent/src/features/chat/TimelineView.tsx`
- Modify: `web/agent/src/features/chat/chat.test.tsx`
- Modify: `web/agent/src/features/chat/ConversationList.test.tsx`
- Modify: `web/agent/src/features/chat/ConversationStateControl.test.tsx`
- Modify: `web/agent/src/features/chat/roster-picker.test.tsx`

**Interfaces:**
- Consumes: `useApp`, `AgentApiClient`, `createConversation`, `sendMessage`, `startRun`, `TimelineStore`。
- Produces: Astryx 登录表单、侧栏壳、私聊页、命名 Dialog 与可访问的 conversation/timeline/composer 控件。

- [ ] **Step 1: 补充失败测试**

为登录页增加 `form[name]`、错误 `alert` 与密码重置输入保留断言；为 chat 增加命名会话列表、状态 Badge、创建专家 `Dialog`、时间线 `log`、消息输入和发送后 `message → run` 调用顺序断言。现有 API mock 与 `data-testid` 不改名。

- [ ] **Step 2: 运行 RED 验证**

Run: `corepack pnpm@11.4.0 --dir web/agent exec vitest run src/pages/LoginPage.test.tsx src/features/chat --reporter=dot`

Expected: 新增 Astryx 语义断言失败，既有行为断言仍可识别原契约。

- [ ] **Step 3: 用直接 Astryx primitives 替换旧视图**

实现边界：

```tsx
// 视图层只替换组件，不改变 useChatApi / TimelineStore / message-to-run 链。
<Card>
  <Heading level={1}>私聊</Heading>
  <Table aria-label="会话列表" />
</Card>
<Dialog isOpen={createOpen} onClose={handleCancelCreate} title="选择专家开始私聊" />
<ChatComposerInput aria-label="消息内容" />
```

使用 `Card`、`Stack`、`Inline`、`Table`、`Badge`、`Banner`、`EmptyState`、`Dialog`、`FormLayout`、`TextInput`、`Button`、`Chat*` primitives。`RosterPicker` 的 Manager 同步失败提示与 readiness 禁用语义保持；状态迁移保留后端 409 反馈；时间线只消费 `BusinessTimelineEvent`。

- [ ] **Step 4: 验证并提交**

Run:

```bash
corepack pnpm@11.4.0 --dir web/agent exec vitest run src/pages/LoginPage.test.tsx src/features/chat --reporter=dot
corepack pnpm@11.4.0 --dir web/agent run typecheck
```

Expected: focused tests 与 typecheck 通过。

```bash
git add web/agent/src/pages web/agent/src/app/providers.tsx web/agent/src/components/PageShell.tsx web/agent/src/features/chat
git commit -m "feat(agent): migrate login and private chat to Astryx"
```

### Task 2: 群聊协作工作区

**Files:**
- Modify: `web/agent/src/features/group/GroupPage.tsx`
- Modify: `web/agent/src/features/group/GroupExpertRoster.tsx`
- Modify: `web/agent/src/features/group/MentionComposer.tsx`
- Modify: `web/agent/src/features/group/group.test.tsx`

**Interfaces:**
- Consumes: `ConversationList`、`TimelineView`、`listLoadedExperts`、`createFreeConversation`、`createConversationFromSolution`、`groupDispatch`。
- Produces: Astryx 群聊协作页、专家 roster、方案选择 Dialog 与 mention composer。

- [ ] **Step 1: 补充失败测试**

断言群聊页的命名主地标、专家 roster、`@提及` 按钮、方案创建 `Dialog`、触发结果 live region、群聊输入器和错误后的内容保留；保留 `parseMentions` 的纯函数回归用例。

- [ ] **Step 2: 运行 RED 验证**

Run: `corepack pnpm@11.4.0 --dir web/agent exec vitest run src/features/group/group.test.tsx --reporter=dot`

Expected: 新 Astryx 语义断言失败。

- [ ] **Step 3: 迁移**

用 `Card`、`Toolbar`、`Badge`、`Dialog`、`Selector`、`AlertDialog`、`EmptyState`、`Banner`、`Button` 与 `ChatComposer` 直接表达布局。保留 `window` CustomEvent 的 mention 解耦、solution 固定编排入口、free conversation 默认路径、`group-dispatch` 请求体与 `triggered_handles` 展示态。

- [ ] **Step 4: 验证并提交**

Run:

```bash
corepack pnpm@11.4.0 --dir web/agent exec vitest run src/features/group --reporter=dot
corepack pnpm@11.4.0 --dir web/agent run typecheck
```

```bash
git add web/agent/src/features/group
git commit -m "feat(agent): migrate group collaboration to Astryx"
```

### Task 3: 工作台、Run、Loop 与本地终端

**Files:**
- Modify: `web/agent/src/features/workspace/WorkspacePage.tsx`
- Modify: `web/agent/src/features/runs/LoopPanel.tsx`
- Modify: `web/agent/src/features/runs/RunsPanel.tsx`
- Modify: `web/agent/src/features/terminal/TerminalPanel.tsx`
- Modify: `web/agent/src/features/workspace/workspace.test.tsx`
- Modify: `web/agent/src/features/runs/loop.test.tsx`
- Modify: `web/agent/src/features/runs/runs-provenance.test.tsx`
- Modify: `web/agent/src/features/terminal/terminal.test.tsx`

**Interfaces:**
- Consumes: `listConversations`、`listLoops`、`createLoop`、`enableLoop`、`disableLoop`、`fireLoopNow`、`listRuns`、`listTasks`、`cancelRun`、`retryRun`、`getRunProvenance`、`executeCommand`。
- Produces: 本地概览、Loop 表单、Run/Task 表格和 command event 输出面板。

- [ ] **Step 1: 补充失败测试**

覆盖工作台加载/error/empty、Loop 失效 cron 与失败保留输入、启停/立即触发、Run 取消/重试/追溯展开、终端 stdout/stderr/system 状态与取消按钮。所有破坏性 Run/Loop 动作应断言 `AlertDialog`。

- [ ] **Step 2: 运行 RED 验证**

Run: `corepack pnpm@11.4.0 --dir web/agent exec vitest run src/features/workspace src/features/runs src/features/terminal --reporter=dot`

Expected: 新的结构和确认语义断言失败。

- [ ] **Step 3: 迁移**

使用 `Grid`、`Card`、`Table`、`FormLayout`、`TextInput`、`CodeBlock`、`Collapsible`、`Badge`、`Banner`、`AlertDialog`、`EmptyState`。终端继续只消费归一 command 事件，严格保留 `AbortController`、输出滚动、会话切换清理和本机凭据最小注入边界。

- [ ] **Step 4: 验证并提交**

Run:

```bash
corepack pnpm@11.4.0 --dir web/agent exec vitest run src/features/workspace src/features/runs src/features/terminal --reporter=dot
corepack pnpm@11.4.0 --dir web/agent run typecheck
```

```bash
git add web/agent/src/features/workspace web/agent/src/features/runs web/agent/src/features/terminal
git commit -m "feat(agent): migrate local workspace and execution panels to Astryx"
```

### Task 4: 本地能力、快照与设置页

**Files:**
- Modify: `web/agent/src/features/marketplace/MarketplacePage.tsx`
- Modify: `web/agent/src/features/knowledge/KnowledgePage.tsx`
- Modify: `web/agent/src/features/office/OfficePage.tsx`
- Modify: `web/agent/src/features/office/ScheduledJobs.tsx`
- Modify: `web/agent/src/features/org/OrgPage.tsx`
- Modify: `web/agent/src/features/sync/SyncPage.tsx`
- Modify: `web/agent/src/features/settings/SettingsPage.tsx`
- Modify: `web/agent/src/features/marketplace/marketplace.test.tsx`
- Modify: `web/agent/src/features/knowledge/knowledge.test.tsx`
- Modify: `web/agent/src/features/office/office.test.tsx`
- Modify: `web/agent/src/features/org/org.test.tsx`
- Modify: `web/agent/src/features/settings/settings.test.tsx`

**Interfaces:**
- Consumes: marketplace/knowledge/office/org/sync/settings hooks and local preference state.
- Produces: 直接 Astryx 的本地能力页面；不改变 payload、上传、导出、同步与本地 localStorage 的所有权。

- [ ] **Step 1: 补充失败测试**

覆盖市场分类/招募、知识库上传/URL 导入/重试/检索、办公室任务卡、组织 PNG 导出、同步快照与 outbox、设置 tab、偏好本地保存、退出和重新同步。新增状态文字与 Badge 的语义断言，禁止仅颜色传达状态。

- [ ] **Step 2: 运行 RED 验证**

Run: `corepack pnpm@11.4.0 --dir web/agent exec vitest run src/features/marketplace src/features/knowledge src/features/office src/features/org src/features/settings --reporter=dot`

Expected: 新的 Astryx 地标、表单、表格、Tabs/Dialogs 断言失败。

- [ ] **Step 3: 迁移**

使用 `PageHeader`、`Grid`、`Card`、`Table`、`SearchInput`、`TabList`、`FormLayout`、`FileInput`、`Dialog`、`AlertDialog`、`MetadataList`、`Banner`、`EmptyState` 与 `Button`。保留上传 API、PNG canvas 导出、快照和 outbox 脱敏展示、设置只本机持久化。

- [ ] **Step 4: 验证并提交**

Run:

```bash
corepack pnpm@11.4.0 --dir web/agent exec vitest run src/features/marketplace src/features/knowledge src/features/office src/features/org src/features/settings --reporter=dot
corepack pnpm@11.4.0 --dir web/agent run typecheck
```

```bash
git add web/agent/src/features/marketplace web/agent/src/features/knowledge web/agent/src/features/office web/agent/src/features/org web/agent/src/features/sync web/agent/src/features/settings
git commit -m "feat(agent): migrate local capability pages to Astryx"
```

### Task 5: 删除旧 UI、补齐 E2E 与 Agent GO

**Files:**
- Modify: `web/agent/package.json`
- Modify: `web/agent/vite.config.ts`
- Modify: `web/agent/src/styles/app.css`
- Delete: `web/agent/src/styles/integration.test.tsx`
- Create: `web/agent/src/astryx/no-legacy-ui.test.ts`
- Modify: `web/e2e/agent/astryx-chat.spec.ts`
- Create: `web/e2e/agent/astryx-rollout.spec.ts`
- Modify: `web/pnpm-lock.yaml`
- Create: `docs/superpowers/specs/2026-07-12-agent-astryx全量迁移验收.md`

**Interfaces:**
- Consumes: 全部迁移后页面与 Agent E2E storage state。
- Produces: 不含旧 UI 构建链的 Agent 产物，零遗留自动门禁、视觉/可访问性证据和 GO/NO-GO 记录。

- [ ] **Step 1: 先写零遗留失败门禁**

递归扫描 `src` 并拒绝：`@aiteam/shared/ui`、`className=`、`glass`、`text-gold`、`bg-surface`、`border-gold`、`text-text-`、`rounded-window`；扫描配置并拒绝 `tailwindcss`、`@tailwindcss/vite`、`@source` 与 `@aiteam/shared/design-system/tokens.css`。

Run: `corepack pnpm@11.4.0 --dir web/agent exec vitest run src/astryx/no-legacy-ui.test.ts --reporter=dot`

Expected: 当前遗留命中，测试失败。

- [ ] **Step 2: 物理删除旧链**

删除 Tailwind Vite 插件/devDependencies、Tailwind 与旧 token CSS imports、兼容变量和 `.glass` 规则；CSS 入口仅留 Astryx reset/core/Stone 与文档基础布局。用 `corepack pnpm@11.4.0 --dir web install --lockfile-only` 更新 lockfile。

- [ ] **Step 3: 补齐浏览器上线验证**

E2E 覆盖登录、工作台、私聊发送→Run、群聊、知识库或设置、Loop 确认。每个关键页面断言 heading/main、无 console/page error、可见键盘焦点、axe critical/serious 为零；为私聊/工作台或群聊采集 light/dark snapshots。真实主链继续由既有 `astryx-chat.spec.ts` 验证。

- [ ] **Step 4: 独立门禁**

Run:

```bash
corepack pnpm@11.4.0 --dir web/agent test
corepack pnpm@11.4.0 --dir web/agent run typecheck
corepack pnpm@11.4.0 --dir web/agent run build
corepack pnpm@11.4.0 --dir web install --frozen-lockfile --offline
DB_URL='postgresql://app_rw:aiteam_dev@127.0.0.1:5433/manager_control_db' ADMIN_DB_URL='postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db' E2E_PYTHON=/Volumes/SSD1T/code/ai/aiteam/.venv/bin/python corepack pnpm@11.4.0 --dir web exec playwright test --project=agent-smoke
rg -n '@aiteam/shared/ui|className=|glass|text-gold|bg-surface|border-gold|text-text-|rounded-window|tailwindcss|@source|@aiteam/shared/design-system/tokens.css' web/agent
```

Expected: 全绿；静态扫描不含门禁文件本身时无命中。

- [ ] **Step 5: 记录并提交**

验收文档记录测试总数、E2E 总数、浏览器/axe、快照、gzip 体积、警告、零 legacy 结果与 Agent GO。

```bash
git add web/agent web/e2e/agent web/pnpm-lock.yaml docs/superpowers/specs/2026-07-12-agent-astryx全量迁移验收.md
git commit -m "refactor(agent): complete Astryx rollout and remove legacy UI"
```

## 三端最终验收

Agent GO 后，不再仅凭局部通过宣布完成。必须重新运行 Manager、Operation、Agent 各端的 unit/typecheck/build/Playwright，以及用户端精简产物排除控制面代码的测试；结果记录为三端上线裁决。
