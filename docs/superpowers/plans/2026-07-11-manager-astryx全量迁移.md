# Manager Astryx Full Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Manager 所有页面迁移为直接 Astryx 组合，并在该端删除 `@aiteam/shared/ui`、Tailwind utilities、黑金 token 与兼容实现，同时保持现有路由、API、权限和业务状态不变。

**Architecture:** 保留现有 feature/API hook/type 边界，只替换 React 渲染层。每批直接使用 Astryx 原语，不创建旧 props 兼容 wrapper；每批独立测试和提交，最后通过静态零旧 UI 闸门删除 Manager 的 Tailwind 构建链。

**Tech Stack:** React 19.2.7 · TypeScript 5.5 · Vite 5 · Astryx Core 0.1.4 · Stone 0.1.4 · StyleX 0.18.3 · Vitest 2 · Testing Library 16.3 · Playwright 1.61 · axe-core 4.12.

## Global Constraints

- 不修改 `server/`、API 路径、envelope、角色、TenantContext 或数据库契约。
- 保留 `web/manager/src/App.tsx` 全部现有路由。
- 禁止新增 `Legacy*`、`*Adapter`、旧组件 props 兼容层或双实现 feature flag。
- 页面直接 import `@astryxdesign/core/<Component>`；只允许复用业务 API hooks/types。
- loading/error/empty/data 四态必须完整；提交失败保留输入和 Dialog。
- 每页唯一 h1；表格、Dialog、表单、icon-only action 有可访问名称。
- 不新增页面动画、列表 stagger、`transition: all`、UI `ease-in`、`scale(0)` 或布局属性动画。
- Manager 阶段结束时 `@aiteam/shared/ui`、Tailwind、旧 token 和旧 utility class 在 Manager 端归零。

---

### Task 1: Migrate Manager authentication and dashboard foundation

**Files:**
- Modify: `web/manager/src/pages/LoginPage.tsx`
- Modify: `web/manager/src/pages/LoginPage.test.tsx`
- Modify: `web/manager/src/pages/DashboardPlaceholder.tsx`
- Create: `web/manager/src/pages/DashboardPlaceholder.test.tsx`

**Interfaces:**
- Consumes: `useSession`, `createManagerApiClient`, `useGovernanceApi`, existing i18n keys.
- Produces: Astryx login/reset forms and dashboard summary tables with unchanged submission/request order.

- [ ] **Step 1: Strengthen semantic tests**

Add assertions that Login renders one named form, Astryx-labelled enterprise/account/password inputs, alert errors, and reset mode fields; add Dashboard tests for heading, two named tables, loading status, error alert, and empty states.

- [ ] **Step 2: Verify the new assertions fail**

Run:

```bash
cd web
pnpm --filter @aiteam/manager-web test -- LoginPage.test.tsx DashboardPlaceholder.test.tsx
```

Expected: FAIL because the current pages use raw labels, shared GlassPanel/Table, and have no Dashboard test file.

- [ ] **Step 3: Replace rendering directly with Astryx**

Use `Center`, `Card`, `Heading`, `FormLayout`, `TextInput`, `Button`, `Banner`, `VStack`, `Grid`, `Table`, `Skeleton`, and `EmptyState`. Keep `handleLogin`, `handleOwnerReset`, tenant resolve, 403 reset transition, navigation, and `Promise.all` dashboard data flow unchanged. Do not move auth state into a new store.

- [ ] **Step 4: Run focused and full Manager verification**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- LoginPage.test.tsx DashboardPlaceholder.test.tsx
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web build
```

Expected: all pass; Manager test count increases by the new Dashboard cases.

- [ ] **Step 5: Commit**

```bash
git add web/manager/src/pages
git commit -m "feat(manager): migrate login and dashboard to Astryx"
```

---

### Task 2: Migrate simple cards, billing, and settings pages

**Files:**
- Modify: `web/manager/src/features/connectors/ConnectorsPage.tsx`
- Modify: `web/manager/src/features/connectors/__tests__/ConnectorsPage.test.tsx`
- Modify: `web/manager/src/features/billing/BillingPage.tsx`
- Modify: `web/manager/src/features/billing/RechargePage.tsx`
- Modify: `web/manager/src/features/billing/__tests__/BillingPage.test.tsx`
- Modify: `web/manager/src/features/billing/__tests__/RechargePage.test.tsx`
- Modify: `web/manager/src/features/memory-items/MemoryPage.tsx`
- Modify: `web/manager/src/features/memory-items/__tests__/MemoryPage.test.tsx`
- Modify: `web/manager/src/features/settings/SettingsPage.tsx`
- Modify: `web/manager/src/features/settings/__tests__/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: existing `useConnectorsApi`, `useBillingApi`, `useMemoryApi`, `useSettingsApi` signatures.
- Produces: Astryx cards, segmented period controls, forms, lists, and feedback without request changes.

- [ ] **Step 1: Add failing Astryx semantic assertions**

For each page assert a level-1 heading, loading status/error alert/empty state where applicable, named controls, and no `.glass` element. Billing period must expose a single-selection control; connector test result must use status/alert; recharge and settings submission buttons must retain disabled/loading behavior.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- ConnectorsPage.test.tsx BillingPage.test.tsx RechargePage.test.tsx MemoryPage.test.tsx SettingsPage.test.tsx
```

- [ ] **Step 3: Implement direct Astryx composition**

Use `Heading`, `Card`, `Grid`, `VStack/HStack`, `SegmentedControl`, `TextInput`, `NumberInput` where the contract is numeric, `Button`, `Banner`, `Skeleton`, `EmptyState`, `List/Item`, and `Timestamp`. Preserve current request payloads and display formatting exactly.

- [ ] **Step 4: Verify batch**

```bash
cd web
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web typecheck
pnpm --filter @aiteam/manager-web build
```

- [ ] **Step 5: Commit**

```bash
git add web/manager/src/features/connectors web/manager/src/features/billing web/manager/src/features/memory-items web/manager/src/features/settings
git commit -m "feat(manager): migrate simple management pages to Astryx"
```

---

### Task 3: Migrate marketplace, solutions, experts, and apply history

**Files:**
- Modify: `web/manager/src/features/marketplace/MarketplacePage.tsx`
- Modify: `web/manager/src/features/marketplace/__tests__/MarketplacePage.test.tsx`
- Modify: `web/manager/src/features/solutions/SolutionsPage.tsx`
- Modify: `web/manager/src/features/solutions/__tests__/SolutionsPage.test.tsx`
- Modify: `web/manager/src/features/experts/ExpertsPage.tsx`
- Modify: `web/manager/src/features/experts/EmployeeConfigDrawer.tsx`
- Modify: `web/manager/src/features/experts/__tests__/ExpertsPage.test.tsx`
- Modify: `web/manager/src/features/solution-apply/SolutionApplyHistoryPage.tsx`
- Modify: `web/manager/src/features/solution-apply/__tests__/SolutionApplyHistoryPage.test.tsx`

**Interfaces:**
- Consumes: existing catalog/recruit/apply APIs and employee configuration callbacks.
- Produces: accessible Astryx catalog cards, details Dialogs, employee configuration Dialog, and apply-history expansion.

- [ ] **Step 1: Add interaction-first failing tests**

Assert catalog items are named articles/items, detail and config overlays are `role=dialog` with accessible names, Escape/cancel closes without mutation, failed submit keeps dialog open, status uses Badge plus text, and expand/collapse uses `aria-expanded`.

- [ ] **Step 2: Confirm failures**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- MarketplacePage.test.tsx SolutionsPage.test.tsx ExpertsPage.test.tsx SolutionApplyHistoryPage.test.tsx
```

- [ ] **Step 3: Implement Astryx catalog/detail UI**

Use `Heading`, `Grid`, `ClickableCard`/`Card`, `Badge`, `MetadataList`, `Dialog`, `FormLayout`, `Selector`, `TextInput`, `Button`, `Collapsible`, `Skeleton`, and `EmptyState`. Preserve recruitment/apply/config payloads, permission gates, and refresh calls.

- [ ] **Step 4: Verify batch and browser errors**

```bash
cd web
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web build
pnpm exec playwright test --project=manager-smoke e2e/manager/smoke.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add web/manager/src/features/marketplace web/manager/src/features/solutions web/manager/src/features/experts web/manager/src/features/solution-apply
git commit -m "feat(manager): migrate catalog and expert flows to Astryx"
```

---

### Task 4: Split and migrate provider, capability, and LLM workbenches

**Files:**
- Modify: `web/manager/src/features/providers/ProvidersPage.tsx`
- Modify: `web/manager/src/features/providers/__tests__/ProvidersPage.test.tsx`
- Modify: `web/manager/src/features/capability/CapabilityPage.tsx`
- Create: `web/manager/src/features/capability/CapabilityPage.test.tsx`
- Modify: `web/manager/src/features/llm/LlmPage.tsx`
- Modify: `web/manager/src/features/llm/__tests__/LlmPage.test.tsx`
- Create: `web/manager/src/features/llm/ProviderSection.tsx`
- Create: `web/manager/src/features/llm/ModelSection.tsx`

**Interfaces:**
- Consumes: existing provider/capability/LLM hooks and DTOs.
- Produces: direct Astryx configuration workbenches; `ProviderSection` and `ModelSection` receive typed data/callbacks only and expose no legacy UI props.

- [ ] **Step 1: Add failing tests for CRUD and focus behavior**

Cover add/remove model row, enable switch, provider/model create/update/delete, capability search/filter, validation errors, submit failure retention, and dialog focus return. Assert Astryx table/form/dialog semantics and absence of `.glass`.

- [ ] **Step 2: Confirm failures**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- ProvidersPage.test.tsx CapabilityPage.test.tsx LlmPage.test.tsx
```

- [ ] **Step 3: Implement and split only the oversized LLM file**

Use `FormLayout`, `TextInput`, `Selector`, `CheckboxInput`/`Switch`, `Table`, `Dialog`, `Banner`, `Button`, `Card`, `TabList`, and `EmptyState`. Split `LlmPage.tsx` only along Provider/Model business sections; keep API orchestration in `LlmPage` and pass explicit typed callbacks to the sections.

- [ ] **Step 4: Verify batch**

```bash
cd web
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web typecheck
pnpm --filter @aiteam/manager-web build
```

- [ ] **Step 5: Commit**

```bash
git add web/manager/src/features/providers web/manager/src/features/capability web/manager/src/features/llm
git commit -m "feat(manager): migrate configuration workbenches to Astryx"
```

---

### Task 5: Migrate members, grants, organization, and knowledge

**Files:**
- Modify: `web/manager/src/features/members/MembersPage.tsx`
- Modify: `web/manager/src/features/members/__tests__/MembersPage.test.tsx`
- Modify: `web/manager/src/features/grants/GrantsPage.tsx`
- Modify: `web/manager/src/features/grants/__tests__/GrantsPage.test.tsx`
- Modify: `web/manager/src/features/org/OrgPage.tsx`
- Modify: `web/manager/src/features/org/__tests__/OrgPage.test.tsx`
- Modify: `web/manager/src/features/knowledge/KnowledgePage.tsx`
- Modify: `web/manager/src/features/knowledge/DocumentsPanel.tsx`
- Modify: `web/manager/src/features/knowledge/__tests__/KnowledgePage.test.tsx`

**Interfaces:**
- Consumes: existing member/grant/org/knowledge hooks, tenant-scoped DTOs, and assignment callbacks.
- Produces: Astryx member/grant tables, organization TreeList, knowledge binding forms, and document table.

- [ ] **Step 1: Add failing contract and accessibility tests**

Assert named tables, member/grant form labels, role-gated actions, department TreeList semantics, assignment selector, knowledge/document empty/error/loading states, destructive confirmations, and stale-request protection for dependency-driven loads.

- [ ] **Step 2: Confirm failures**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- MembersPage.test.tsx GrantsPage.test.tsx OrgPage.test.tsx KnowledgePage.test.tsx
```

- [ ] **Step 3: Implement direct Astryx UI**

Use `Table`, `Pagination`, `FormLayout`, `TextInput`, `Selector`/`MultiSelector`, `TreeList`, `Dialog`/`AlertDialog`, `Banner`, `Skeleton`, `EmptyState`, `Badge`, and layout primitives. Preserve all tenant-owned IDs, payloads, RLS-facing API calls, and role gates.

- [ ] **Step 4: Verify batch**

```bash
cd web
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web build
```

- [ ] **Step 5: Commit**

```bash
git add web/manager/src/features/members web/manager/src/features/grants web/manager/src/features/org web/manager/src/features/knowledge
git commit -m "feat(manager): migrate tenant administration to Astryx"
```

---

### Task 6: Migrate governance and extend Manager browser gates

**Files:**
- Modify: `web/manager/src/features/governance/GovernancePage.tsx`
- Modify: `web/manager/src/features/governance/__tests__/GovernancePage.test.tsx`
- Create: `web/e2e/manager/astryx-rollout.spec.ts`
- Create: `web/e2e/manager/astryx-rollout.spec.ts-snapshots/*`

**Interfaces:**
- Consumes: existing governance APIs and seeded Manager session.
- Produces: Astryx governance dashboard plus browser gates for Login, Members, Providers, Governance, and Audit.

- [ ] **Step 1: Add failing governance and E2E assertions**

Unit tests cover quota create/evaluate, usage/audit tables, filters, loading/error/empty, and disabled submit. Playwright must visit `/members`, `/providers`, `/governance`, and `/audit`, assert h1 and primary landmark, run axe critical/serious filter, exercise Tab focus, capture one deterministic light and dark rollout screenshot, and assert browser errors empty.

- [ ] **Step 2: Confirm failures**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- GovernancePage.test.tsx
pnpm exec playwright test --project=manager-smoke e2e/manager/astryx-rollout.spec.ts --update-snapshots
```

- [ ] **Step 3: Implement governance with Astryx**

Use `Heading`, `Card`, `Grid`, `Table`, `FormLayout`, `NumberInput`, `Selector`, `Button`, `Badge`, `Banner`, `Skeleton`, and `EmptyState`. Keep governance summaries aggregate-only and preserve existing API payloads.

- [ ] **Step 4: Generate and approve screenshots, then rerun without updates**

```bash
cd web
pnpm exec playwright test --project=manager-smoke e2e/manager/astryx-rollout.spec.ts --update-snapshots
pnpm exec playwright test --project=manager-smoke e2e/manager/astryx-rollout.spec.ts
```

- [ ] **Step 5: Commit**

```bash
git add web/manager/src/features/governance web/e2e/manager/astryx-rollout.spec.ts web/e2e/manager/astryx-rollout.spec.ts-snapshots
git commit -m "feat(manager): complete Astryx governance rollout"
```

---

### Task 7: Delete Manager legacy UI and Tailwind build chain

**Files:**
- Modify: `web/manager/src/styles/app.css`
- Modify: `web/manager/package.json`
- Modify: `web/manager/vite.config.ts`
- Modify: `web/manager/vitest.config.ts`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/manager/src/astryx/no-legacy-ui.test.ts`

**Interfaces:**
- Consumes: all migrated Manager pages.
- Produces: Manager build with Astryx CSS only and an executable zero-legacy source/config gate.

- [ ] **Step 1: Write the failing zero-legacy test**

The test recursively scans `web/manager/src` and fails on `@aiteam/shared/ui`, `.glass`, `glass`, `text-gold`, `bg-surface`, `border-gold`, `text-text-`, `rounded-window`, and Tailwind-only utility class strings. It also reads `package.json`, `vite.config.ts`, and `styles/app.css` and rejects `tailwindcss`, `@tailwindcss/vite`, `@source`, Tailwind imports, and `@aiteam/shared/design-system/tokens.css`.

- [ ] **Step 2: Run and confirm failure**

```bash
cd web
pnpm --filter @aiteam/manager-web test -- no-legacy-ui.test.ts
```

- [ ] **Step 3: Remove the old build chain**

Delete Manager Tailwind imports, Astryx Tailwind bridge CSS, and token import from `app.css`; retain only Astryx reset/core/Stone plus global height/system font rules. Remove the Tailwind plugin from Vite, remove Manager Tailwind devDependencies, remove the obsolete shared-ui Vitest alias, and update the lockfile with `pnpm install --lockfile-only`.

- [ ] **Step 4: Run final Manager verification**

```bash
cd web
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web typecheck
pnpm --filter @aiteam/manager-web build
pnpm exec playwright test --project=manager-smoke
rg -n '@aiteam/shared/ui|glass|text-gold|bg-surface|border-gold|text-text-|rounded-window' manager/src
```

Expected: all tests/build/E2E pass and `rg` exits 1 with no matches.

- [ ] **Step 5: Record bundle and commit**

Record Manager gzip JS/CSS total in the rollout acceptance note, then:

```bash
git add web/manager web/pnpm-lock.yaml docs/superpowers/specs
git commit -m "refactor(manager): remove legacy UI stack"
```

---

### Task 8: Independent Manager rollout verification

**Files:**
- Create: `docs/superpowers/specs/2026-07-11-manager-astryx全量迁移验收.md`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: GO/NO-GO evidence before Operation migration.

- [ ] **Step 1: Run all independent gates**

```bash
cd web
pnpm --filter @aiteam/manager-web test
pnpm --filter @aiteam/manager-web typecheck
pnpm --filter @aiteam/manager-web build
pnpm exec playwright test --project=manager-smoke
cd ..
/Volumes/SSD1T/code/ai/aiteam/.venv/bin/python -m pytest server/tests/integration/test_verification_matrix.py::test_user_client_build_excludes_control_plane -q
```

- [ ] **Step 2: Write complete evidence**

Record test counts, routes exercised, axe results, screenshot paths, browser errors, gzip size, zero-legacy scan output, known upstream warnings, and GO/NO-GO. GO requires no Manager old UI source/config dependency and no behavior regression.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-11-manager-astryx全量迁移验收.md
git commit -m "docs(manager): record full Astryx rollout evidence"
```
