# Astryx Apple 风格精修 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 设置页和聊天工具栏完全落在 Astryx 组件/图标体系内，以共享主题提升三端静态层级，并交付可执行的前端架构约束文档。

**Architecture:** 基础控件、布局、无障碍和主题仍由 Astryx 承担。共享包只提供主题 token、单色图标资产和工程规范；业务页只组合这些能力，不创建通用 UI 包或动画框架。现有 API、路由、状态 store 与三端部署边界不变。

**Tech Stack:** React 19、TypeScript、Astryx 0.1.4、StyleX/Astryx Theme、Vitest、Playwright、Axe。

## Global Constraints

- Astryx 0.1.4 是唯一通用 UI 基座；不恢复 legacy UI、design-system 或自建通用组件。
- 不修改 `server/`、API、路由、持久化和三端所有权边界。
- 不新增 Motion、Framer Motion、手势库或图标库；不修改 `node_modules`。
- 新视觉规则只进入 `web/shared/src/theme/`；业务页不得增加全局 CSS、色值、阴影常量或 keyframe。
- 不做全站透明玻璃、页面转场或循环动画；维持 `prefers-reduced-motion` 兼容。
- 每个行为变更先写并执行失败测试，再写最小实现。

---

### Task 1: 用 Astryx Selector 与 Switch 收口 Agent 设置页

**Files:**
- Modify: `web/agent/src/features/settings/SettingsPage.tsx:1-120`
- Modify: `web/agent/src/features/settings/settings.test.tsx:65-95`

**Interfaces:**
- Consumes: `usePreferences()` 返回的 `{ locale: string; streamTypingEffect: boolean }` 与 `setPreferences(next)`。
- Produces: 语言使用 Astryx `Selector`，流式打字使用 Astryx `Switch`；两项继续写入 `aiteam.agent.preferences`。

- [ ] **Step 1: 写失败测试，定义 Astryx 控件语义**

在 `settings.test.tsx` 的“偏好 Tab”测试后加入：

```tsx
it("偏好 Tab 使用 Astryx selector 与 switch，并保留本地持久化", async () => {
  loginStorage();
  renderPage();
  fireEvent.click(screen.getByRole("tab", { name: "偏好" }));

  const locale = await screen.findByRole("combobox", { name: "语言" });
  expect(locale.tagName).toBe("BUTTON");
  expect(screen.getByRole("switch", { name: "流式打字效果" })).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试，确认因原生控件而失败**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/agent test -- settings.test.tsx`

Expected: FAIL，语言控件实际标签为 `SELECT`，且找不到 role=`switch`。

- [ ] **Step 3: 最小实现控件替换**

在 `SettingsPage.tsx`：

```tsx
import { Selector } from "@astryxdesign/core/Selector";
import { Switch } from "@astryxdesign/core/Switch";

<Selector
  label="语言"
  value={preferences.locale}
  options={[
    { value: "zh-CN", label: "中文（简体）" },
    { value: "en-US", label: "English" },
  ]}
  onChange={(locale) => setPreferences({ ...preferences, locale })}
/>
<Switch
  label="流式打字效果"
  description="仅影响本机对话展示。"
  value={preferences.streamTypingEffect}
  onChange={(streamTypingEffect) => setPreferences({ ...preferences, streamTypingEffect })}
/>
```

删除对应的原生 `<label>`、`<select>` 与 checkbox。保留“偏好仅保存在本机，不上传控制面。”说明。

- [ ] **Step 4: 运行设置页测试，确认变绿**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/agent test -- settings.test.tsx`

Expected: PASS，原有语言持久化、同步和退出登录断言仍通过。

- [ ] **Step 5: 提交本任务**

```bash
git add web/agent/src/features/settings/SettingsPage.tsx web/agent/src/features/settings/settings.test.tsx
git commit -m "refactor(agent): use Astryx preference controls"
```

### Task 2: 用 Astryx Icon 替换聊天工具栏 emoji

**Files:**
- Create: `web/shared/src/theme/aiteam-icons.tsx`
- Create: `web/shared/src/theme/aiteam-icons.test.tsx`
- Modify: `web/shared/src/theme/index.ts:1`
- Modify: `web/agent/src/features/chat/MessageComposer.tsx:20-260`
- Modify: `web/agent/src/features/chat/chat.test.tsx`

**Interfaces:**
- Produces: `AttachmentIcon`、`AgentIcon`、`SkillIcon`、`ScreenshotIcon`，每项均为接受 `React.SVGProps<SVGSVGElement>` 的单色 SVG component。
- Consumes: Astryx `Icon` 的 component mode 与现有 `Button.icon: ReactNode`。
- Preserves: 工具按钮 label、tooltip、popover、文件选择、@ 提及、技能插入与截图提示行为不变。

- [ ] **Step 1: 写失败测试，定义图标和可访问名称**

在 `aiteam-icons.test.tsx` 中渲染四项图标并断言 SVG 的 `viewBox="0 0 24 24"`、`aria-hidden="true"` 与 `currentColor`；在 `chat.test.tsx` 增加：

```tsx
expect(screen.getByRole("button", { name: "附件上传" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "召唤其他智能体" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "技能市场入口" })).toBeInTheDocument();
expect(screen.getByRole("button", { name: "截图工具" })).toBeInTheDocument();
expect(document.body.textContent).not.toMatch(/[📎🤖⚡📷]/u);
```

- [ ] **Step 2: 运行测试，确认现有 emoji 导致失败**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/agent test -- chat.test.tsx && PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/shared test -- aiteam-icons.test.tsx`

Expected: FAIL；图标模块不存在，且现有 DOM 文本包含 emoji。

- [ ] **Step 3: 以最小 SVG 资产实现并接入 Astryx Icon**

在 `aiteam-icons.tsx` 定义四个只含 path 的 24×24 outline SVG component；每个 root 均转发 `SVGProps`、设置 `fill="none"`、`stroke="currentColor"`、`strokeWidth={1.8}`、`aria-hidden="true"`。

在 `theme/index.ts` 导出四个 component；在 `MessageComposer.tsx` 导入 `Icon` 与这些 component，把：

```tsx
icon={<span aria-hidden="true">📎</span>}
```

替换为：

```tsx
icon={<Icon icon={AttachmentIcon} size="sm" />}
```

其余三个工具分别使用 `AgentIcon`、`SkillIcon`、`ScreenshotIcon`。附件 badge 复用 `AttachmentIcon`；移除按钮保留 Astryx 内置 `Icon icon="close"`。

- [ ] **Step 4: 运行聊天与共享图标测试，确认变绿**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/shared test -- aiteam-icons.test.tsx && PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/agent test -- chat.test.tsx`

Expected: PASS；工具行为和可访问名称不变，DOM 不再包含工具 emoji。

- [ ] **Step 5: 提交本任务**

```bash
git add web/shared/src/theme web/agent/src/features/chat/MessageComposer.tsx web/agent/src/features/chat/chat.test.tsx
git commit -m "refactor(agent): use Astryx chat tool icons"
```

### Task 3: 在共享 Astryx 主题收口排版与表面层级

**Files:**
- Modify: `web/shared/src/theme/aiteam-stone.ts:7-25`
- Modify: `web/shared/src/theme/aiteam-stone.test.ts:4-27`

**Interfaces:**
- Consumes: Astryx `defineTheme` 的 `tokens` 和 `components` override。
- Produces: 更清晰的 H1/H2 type scale、克制 Card/ChatComposer surface 规则；三端继续只导入 `aiteamStone`。

- [ ] **Step 1: 写失败测试，固定主题契约**

在 `aiteam-stone.test.ts` 增加：

```tsx
it("uses compact heading hierarchy and restrained surface elevation", () => {
  expect(aiteamStone.tokens["--text-heading-1-size"]).toBe("1.875rem");
  expect(aiteamStone.tokens["--text-heading-1-leading"]).toBe("1.2");
  expect(aiteamStone.components?.heading?.["level:1"]?.letterSpacing).toBe("-0.02em");
  expect(aiteamStone.components?.card?.base?.boxShadow).toBe("var(--shadow-low)");
  expect(aiteamStone.components?.["chat-composer"]?.base?.boxShadow).toBe("var(--shadow-med)");
});
```

- [ ] **Step 2: 运行共享主题测试，确认契约尚未存在**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/shared test -- aiteam-stone.test.ts`

Expected: FAIL，标题 token 与 component override 尚未定义。

- [ ] **Step 3: 最小主题 override 实现**

在 `aiteamStone` 的 `tokens` 加入：

```ts
"--text-heading-1-size": "1.875rem",
"--text-heading-1-leading": "1.2",
"--text-heading-2-leading": "1.25",
```

在同一 `defineTheme` 调用添加：

```ts
components: {
  heading: {
    "level:1": { letterSpacing: "-0.02em" },
    "level:2": { letterSpacing: "-0.012em" },
  },
  card: {
    base: { boxShadow: "var(--shadow-low)" },
    "variant:muted": { boxShadow: "none" },
  },
  "chat-composer": {
    base: {
      borderColor: "var(--color-border-emphasized)",
      boxShadow: "var(--shadow-med)",
    },
  },
},
```

不增加 `backdrop-filter`、keyframe 或页面级样式。

- [ ] **Step 4: 运行共享主题测试，确认变绿**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 --filter @aiteam/shared test -- aiteam-stone.test.ts`

Expected: PASS，既有主题色和 motion scale 断言仍通过。

- [ ] **Step 5: 提交本任务**

```bash
git add web/shared/src/theme/aiteam-stone.ts web/shared/src/theme/aiteam-stone.test.ts
git commit -m "feat(web): refine shared Astryx theme hierarchy"
```

### Task 4: 添加前端工程架构 README

**Files:**
- Create: `web/README.md`

**Interfaces:**
- Consumes: 根 `AGENTS.md` 的三端边界、`web/shared` exports、现有 pnpm scripts、CI 的 visual/Axe/Playwright 门禁。
- Produces: 后续前端开发的入口规范，不定义后端或跨端新契约。

- [ ] **Step 1: 写 README 验收清单**

在新增 README 前，建立如下内容清单：

```text
- web/{operation,manager,agent,shared} 的职责与禁止跨端调用
- Astryx、aiteamStone、业务 feature 的分层
- 允许/禁止的组件、样式、图标与动效做法
- 可访问性、视觉快照、light/dark/reduced-motion 门禁
- pnpm 测试、类型检查、构建、E2E 命令
```

- [ ] **Step 2: 写入 README**

README 使用中文，至少包含：目录图、依赖方向、主题和组件规范、Apple Design 的克制原则、例外申请规则、测试命令与禁止清单。明确：文件输入是浏览器能力例外；组织图导出是领域可视化例外；任何新的手势/弹簧交互需要独立设计和视觉测试。

- [ ] **Step 3: 人工校验 README 与根约束一致**

Run: `rg -n '跨端|Astryx|theme|motion|Playwright|legacy' web/README.md`

Expected: 每一类约束都有明确正文，且不出现旧 `app/` 或 `/api/team` 作为前端实现路径。

- [ ] **Step 4: 提交本任务**

```bash
git add web/README.md
git commit -m "docs(web): define frontend architecture constraints"
```

### Task 5: 更新视觉基线并完成全量验证

**Files:**
- Modify: `web/e2e/agent/astryx-chat.spec.ts-snapshots/*`
- Modify: `web/e2e/manager/astryx-audit.spec.ts-snapshots/*`
- Modify: `web/e2e/manager/astryx-rollout.spec.ts-snapshots/*`
- Modify: `web/e2e/operation/astryx-rollout.spec.ts-snapshots/*`

**Interfaces:**
- Consumes: 现有 light/dark/reduced-motion visual E2E suites。
- Produces: macOS 与 Linux 均有对应快照，CI 在 Ubuntu 使用 `*-linux.png`。

- [ ] **Step 1: 构建三端前端**

Run: `PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r build`

Expected: shared、operation、manager、agent 均 build 成功。

- [ ] **Step 2: 更新本机 macOS 视觉快照**

Run: `PATH=/opt/homebrew/bin:$PATH MANAGER_CREDENTIAL_KEY='vAkjGKeadpMSZuL5h21AanI5tjHmoOh87WNukUbEFhE=' APP_RW_PASSWORD=apprwpass DB_URL='postgresql://app_rw:apprwpass@127.0.0.1:5433/manager_control_db' ADMIN_DB_URL='postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db' corepack pnpm@11.4.0 exec playwright test e2e/agent/astryx-chat.spec.ts e2e/manager/astryx-audit.spec.ts e2e/manager/astryx-rollout.spec.ts e2e/operation/astryx-rollout.spec.ts --update-snapshots`

Expected: 对应 `*-darwin.png` 更新，无 console/Axe/键盘失败。

- [ ] **Step 3: 执行测试、类型检查、构建与全量 E2E**

Run:

```bash
PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r test
PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r typecheck
PATH=/opt/homebrew/bin:$PATH corepack pnpm@11.4.0 -r build
PATH=/opt/homebrew/bin:$PATH MANAGER_CREDENTIAL_KEY='vAkjGKeadpMSZuL5h21AanI5tjHmoOh87WNukUbEFhE=' APP_RW_PASSWORD=apprwpass DB_URL='postgresql://app_rw:apprwpass@127.0.0.1:5433/manager_control_db' ADMIN_DB_URL='postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db' corepack pnpm@11.4.0 e2e
```

Expected: 所有命令退出码为 0；E2E 在干净 `aiteam-pg` 测试容器上运行。

- [ ] **Step 4: 推送后补齐 Linux 快照**

首次 CI 如因缺失或更新的 `*-linux.png` 失败，下载 `playwright-test-results` artifact，将 `*-actual.png` 映射到相应 `*-linux.png`，抽样检查后提交。再次推送并等待 `v1-web-ci` 的 `typecheck + 单测 + 构建` 与 `Playwright smoke（三端真实装配）` 都为 success。

- [ ] **Step 5: 最终提交**

```bash
git add web/e2e
git commit -m "test(web): refresh Astryx visual baselines"
git push origin HEAD
```

