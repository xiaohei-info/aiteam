# Operation Astryx 全量迁移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将运营端所有页面迁移为直接使用 Astryx 的新 UI，保持现有业务契约，并删除旧共享 UI、Tailwind 构建链和历史样式。

**Architecture:** 保留 `use*Api`、DTO、认证与路由边界，只替换视图层。页面直接导入 `@astryxdesign/core/*`；壳层统一使用 Astryx `AppShell + SideNav`；大文件按业务区块拆分，不引入兼容 wrapper。每批迁移先补交互与可访问性测试，再实现、构建和浏览器验收。

**Tech Stack:** React 19、TypeScript、Astryx 0.1.4、Vitest、Testing Library、Playwright、axe。

## Global Constraints

- 运营端只调用本端 `/api/operation/*` 与 `/api/auth/*`，不得跨端直调。
- 保留现有 API payload、权限门控、一次性凭据安全语义和刷新时机。
- 新源码禁止 `@aiteam/shared/ui`、Tailwind utility class、旧 token CSS 和 UI 兼容层。
-  destructive action 必须使用命名 `AlertDialog`；表格、表单和 Dialog 必须有 accessible name。
- 提交失败时保留用户输入；切换资源时旧异步响应不得覆盖新状态。
- 每项任务执行 RED → GREEN → focused test → typecheck；每批形成独立提交。

---

### Task 1: Astryx foundation, shell, login, and dashboard

**Files:**
- Modify: `web/operation/package.json`
- Create: `web/operation/src/astryx/AstryxProviders.tsx`
- Create: `web/operation/src/astryx/RouterLinkAdapter.tsx`
- Create: `web/operation/src/astryx/RouterLinkAdapter.test.tsx`
- Modify: `web/operation/src/main.tsx`
- Modify: `web/operation/src/shell/AppShell.tsx`
- Modify: `web/operation/src/pages/LoginPage.tsx`
- Modify: `web/operation/src/pages/LoginPage.test.tsx`
- Modify: `web/operation/src/pages/DashboardPlaceholder.tsx`
- Create: `web/operation/src/pages/DashboardPlaceholder.test.tsx`

**Interfaces:**
- Consumes: `operationShellConfig`, `buildShellViewModel`, `SessionContext`, existing login and dashboard APIs.
- Produces: `AstryxProviders({children})`, React Router-compatible Astryx links, responsive operation shell, migrated login/dashboard.

- [ ] **Step 1: Add Astryx dependencies and failing semantic tests**

Add `@astryxdesign/core`, `@astryxdesign/theme-stone`, and `@stylexjs/stylex` at the same exact versions as Manager. Tests must assert named navigation, `main`, login form, loading `status`, error `alert`, dashboard metric cards, keyboard focus, and no `.glass` node.

- [ ] **Step 2: Run tests and confirm RED**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/pages/LoginPage.test.tsx src/pages/DashboardPlaceholder.test.tsx src/astryx/RouterLinkAdapter.test.tsx
```

Expected: failures for missing Astryx providers/semantic landmarks.

- [ ] **Step 3: Implement the foundation**

Use the same provider boundary as Manager:

```tsx
<Theme theme={aiteamStone} mode="system">
  <LinkProvider component={RouterLinkAdapter}>{children}</LinkProvider>
</Theme>
```

Render shell with `AppShell`, `SideNav`, `SideNavSection`, and `SideNavItem`; render login/dashboard with `Center`, `Card`, `FormLayout`, `TextInput`, `Heading`, `Banner`, `Grid`, `Skeleton`, `EmptyState`, and `Button`. Do not alter token storage or login request bodies.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm@11.4.0 --dir web/operation test
corepack pnpm@11.4.0 --dir web/operation run typecheck
git add web/operation/package.json web/operation/src/astryx web/operation/src/main.tsx web/operation/src/shell web/operation/src/pages
git commit -m "feat(operation): establish Astryx shell and entry pages"
```

---

### Task 2: Enterprise provisioning and bootstrap secret flow

**Files:**
- Modify: `web/operation/src/features/enterprise/EnterprisePage.tsx`
- Modify: `web/operation/src/features/enterprise/ProvisionForm.tsx`
- Modify: `web/operation/src/features/enterprise/BootstrapSecretDisplay.tsx`
- Modify: `web/operation/src/features/enterprise/__tests__/EnterprisePage.test.tsx`
- Modify: `web/operation/src/features/enterprise/__tests__/BootstrapSecretDisplay.test.tsx`

**Interfaces:**
- Consumes: existing provisioning API callbacks and one-time bootstrap credential result.
- Produces: named enterprise table/form, confirmation flow, and non-persistent one-time secret banner.

- [ ] **Step 1: Write failing behavior tests**

Cover list loading/error/empty, provision validation, exact submit payload, failed-submit input retention, successful refresh, one-time credential display, explicit copy action, and dismissal without `localStorage`/`sessionStorage` persistence.

- [ ] **Step 2: Confirm RED**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/enterprise/__tests__ --reporter=dot
```

- [ ] **Step 3: Implement direct Astryx UI**

Use `Heading`, `Card`, `Table`, `FormLayout`, `TextInput`, `Button`, `Banner`, `Code`, `Dialog`, `Skeleton`, and `EmptyState`. Keep credentials only in component state and clear them on dismiss/unmount.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/enterprise/__tests__ --reporter=dot
corepack pnpm@11.4.0 --dir web/operation run typecheck
git add web/operation/src/features/enterprise
git commit -m "feat(operation): migrate enterprise provisioning to Astryx"
```

---

### Task 3: Accounts and enterprise lifecycle actions

**Files:**
- Modify: `web/operation/src/features/accounts/AccountsPage.tsx`
- Split from: `web/operation/src/features/accounts/EnterpriseActions.tsx`
- Create: `web/operation/src/features/accounts/RechargeDialog.tsx`
- Create: `web/operation/src/features/accounts/QuotaDialog.tsx`
- Create: `web/operation/src/features/accounts/NotificationDialog.tsx`
- Create: `web/operation/src/features/accounts/LifecycleDialogs.tsx`
- Modify: `web/operation/src/features/accounts/AccountsPage.test.tsx`
- Modify: `web/operation/src/features/accounts/EnterpriseActions.test.tsx`
- Modify: `web/operation/src/features/accounts/LifecycleActions.test.tsx`

**Interfaces:**
- Consumes: existing enterprise action callbacks and `EnterpriseAccount` DTO.
- Produces: typed action dialogs receiving one enterprise and one explicit async callback; no action component creates its own API client.

- [ ] **Step 1: Add failing CRUD/action tests**

Assert named accounts table, search/filter, status badges, dropdown menu keyboard operation, recharge/notification/quota dialogs, disable/enable/reset AlertDialogs, exact request payloads, error retention, close-on-success, and focus return.

- [ ] **Step 2: Confirm RED**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/accounts --reporter=dot
```

- [ ] **Step 3: Split and migrate**

Use `Table`, `SearchInput`, `Selector`, `DropdownMenu`, `Dialog`, `AlertDialog`, `FormLayout`, `TextInput`, `NumberInput`, `TextArea`, `Badge`, `Banner`, and `Button`. Replace the 451-line all-actions component with focused dialogs; keep orchestration and refresh in `EnterpriseActions.tsx`.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/accounts --reporter=dot
corepack pnpm@11.4.0 --dir web/operation run typecheck
git add web/operation/src/features/accounts
git commit -m "feat(operation): migrate account lifecycle workbench to Astryx"
```

---

### Task 4: Board, finance, solution metrics, and system health

**Files:**
- Modify: `web/operation/src/features/board/BoardPage.tsx`
- Modify: `web/operation/src/features/board/OverviewCards.tsx`
- Modify: `web/operation/src/features/board/EnterpriseDetailPage.tsx`
- Modify: `web/operation/src/features/board/BoardPage.test.tsx`
- Modify: `web/operation/src/features/finance/FinancePage.tsx`
- Modify: `web/operation/src/features/finance/FinanceReportsPanel.tsx`
- Modify: `web/operation/src/features/finance/FinancePage.test.tsx`
- Modify: `web/operation/src/features/solutions/SolutionsPage.tsx`
- Modify: `web/operation/src/features/system-health/SystemHealthPage.tsx`
- Modify: `web/operation/src/features/system-health/SystemHealthPage.test.tsx`

**Interfaces:**
- Consumes: existing read-only board, finance, solution-statistics, and health hooks.
- Produces: responsive metric grids, named detail tables, explicit status badges, retry controls, and empty states.

- [ ] **Step 1: Add failing state and accessibility tests**

Cover loading/error/retry/empty/success for each page, named metric regions and tables, date/report controls, enterprise detail navigation, health service rows, and text labels independent of color.

- [ ] **Step 2: Confirm RED**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/board src/features/finance src/features/solutions src/features/system-health --reporter=dot
```

- [ ] **Step 3: Implement common Astryx patterns directly**

Use `Grid`, `Card`, `MetadataList`, `Table`, `Badge`, `Banner`, `Skeleton`, `EmptyState`, `DateInput`, `Selector`, `Heading`, `Text`, and `Button`. Do not create a project-local visual wrapper; share only pure formatting helpers where duplication is real.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/board src/features/finance src/features/solutions src/features/system-health --reporter=dot
corepack pnpm@11.4.0 --dir web/operation run typecheck
git add web/operation/src/features/board web/operation/src/features/finance web/operation/src/features/solutions web/operation/src/features/system-health
git commit -m "feat(operation): migrate governance dashboards to Astryx"
```

---

### Task 5: Catalog list and detail workbenches

**Files:**
- Modify: `web/operation/src/features/catalog/CatalogPage.tsx`
- Split from: `web/operation/src/features/catalog/CatalogDetailPage.tsx`
- Create: `web/operation/src/features/catalog/TemplateOverview.tsx`
- Create: `web/operation/src/features/catalog/TemplateVersionPanel.tsx`
- Create: `web/operation/src/features/catalog/TemplateLifecycleActions.tsx`
- Modify: `web/operation/src/features/catalog/catalog.test.tsx`

**Interfaces:**
- Consumes: existing catalog list/detail/publish/unpublish/deprecate APIs.
- Produces: named catalog table/cards, route-stable detail sections, and confirmed lifecycle actions.

- [ ] **Step 1: Add failing catalog interaction tests**

Cover expert/solution route isolation, filters, detail navigation, loading/error/empty, status text + Badge, version selection, publish/unpublish/deprecate confirmation, failed-action state, and stale detail response protection when route params change.

- [ ] **Step 2: Confirm RED**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/catalog/catalog.test.tsx --reporter=dot
```

- [ ] **Step 3: Split and implement**

Use `Table`, `SearchInput`, `Selector`, `Badge`, `Breadcrumbs`, `Card`, `MetadataList`, `TabList`, `CodeBlock`, `Dialog`, `AlertDialog`, `Skeleton`, and `EmptyState`. Add a monotonically increasing request id for route-driven detail loads and ignore non-current completions.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/catalog/catalog.test.tsx --reporter=dot
corepack pnpm@11.4.0 --dir web/operation run typecheck
git add web/operation/src/features/catalog
git commit -m "feat(operation): migrate catalog browsing to Astryx"
```

---

### Task 6: Split and migrate catalog registration

**Files:**
- Split from: `web/operation/src/features/catalog/RegisterForm.tsx`
- Create: `web/operation/src/features/catalog/register/RegisterForm.tsx`
- Create: `web/operation/src/features/catalog/register/BasicInfoFields.tsx`
- Create: `web/operation/src/features/catalog/register/RuntimeConfigFields.tsx`
- Create: `web/operation/src/features/catalog/register/ExpertTemplateFields.tsx`
- Create: `web/operation/src/features/catalog/register/SolutionTemplateFields.tsx`
- Create: `web/operation/src/features/catalog/register/TeamMemberSelector.tsx`
- Create: `web/operation/src/features/catalog/register/validation.ts`
- Create: `web/operation/src/features/catalog/register/validation.test.ts`
- Modify: `web/operation/src/features/catalog/catalog.test.tsx`
- Delete: old monolithic `web/operation/src/features/catalog/RegisterForm.tsx` after imports move.

**Interfaces:**
- Consumes: existing registration DTO and submit callback.
- Produces: one `RegisterForm` orchestration component; typed section props; pure `validateRegistration(input)` returning field errors.

- [ ] **Step 1: Extract behavior into failing tests**

Assert expert/solution conditional fields, JSON/YAML validation, team member ordering/planner selection, duplicate prevention, exact final payload, submit failure retention, success reset, and keyboard-operable selectors. Unit-test pure validation separately.

- [ ] **Step 2: Confirm RED**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/catalog/register src/features/catalog/catalog.test.tsx --reporter=dot
```

- [ ] **Step 3: Implement focused sections**

Use `FormLayout`, `TextInput`, `TextArea`, `NumberInput`, `Selector`, `MultiSelector`, `CheckboxInput`, `Table`, `Collapsible`, `Banner`, `Button`, and `VStack`. Keep state ownership in the orchestration component; sections receive values and typed callbacks only. Delete the 762-line old file once all imports target `register/RegisterForm.tsx`.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/features/catalog --reporter=dot
corepack pnpm@11.4.0 --dir web/operation run typecheck
git add web/operation/src/features/catalog
git commit -m "refactor(operation): rebuild catalog registration with Astryx"
```

---

### Task 7: Delete legacy UI, add rollout E2E, and record GO/NO-GO

**Files:**
- Create: `web/operation/src/astryx/no-legacy-ui.test.ts`
- Modify: `web/operation/src/styles/app.css`
- Modify: `web/operation/src/main.tsx`
- Modify: `web/operation/package.json`
- Modify: `web/operation/vite.config.ts`
- Modify: `web/operation/vitest.config.ts`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/e2e/operation/astryx-rollout.spec.ts`
- Create: `docs/superpowers/specs/2026-07-11-operation-astryx全量迁移验收.md`

**Interfaces:**
- Consumes: all migrated operation pages.
- Produces: Astryx-only Operation build, executable zero-legacy gate, visual/accessibility evidence, and GO/NO-GO record.

- [ ] **Step 1: Write and run the failing zero-legacy gate**

Recursively reject `@aiteam/shared/ui`, `className="`, `.glass`, `text-gold`, `bg-surface`, `border-gold`, `text-text-`, `rounded-window`, `tailwindcss`, `@tailwindcss/vite`, `@source`, and shared token CSS.

```bash
corepack pnpm@11.4.0 --dir web/operation exec vitest run src/astryx/no-legacy-ui.test.ts --reporter=dot
```

- [ ] **Step 2: Remove old build chain**

Keep `app.css` imports limited to Astryx reset/core/Stone plus document height/system font. Remove Tailwind Vite plugin/devDependencies, obsolete Vitest UI/theme aliases, and old fallback utility classes. Update lockfile:

```bash
cd web && corepack pnpm@11.4.0 install --lockfile-only
```

- [ ] **Step 3: Add rollout E2E**

Exercise Login, Enterprises, Accounts, Experts, Industry Solutions, Finance, Board, and Health. Assert headings/landmarks, no browser errors, no axe critical/serious violations, real Tab focus, destructive confirmation, and light/dark snapshots for the dashboard and catalog detail.

- [ ] **Step 4: Run independent gates**

```bash
corepack pnpm@11.4.0 --dir web/operation test
corepack pnpm@11.4.0 --dir web/operation run typecheck
corepack pnpm@11.4.0 --dir web/operation run build
DB_URL='postgresql://app_rw:aiteam_dev@127.0.0.1:5433/manager_control_db' ADMIN_DB_URL='postgresql://postgres:postgres@127.0.0.1:5433/manager_control_db' E2E_PYTHON=/Volumes/SSD1T/code/ai/aiteam/.venv/bin/python corepack pnpm@11.4.0 --dir web exec playwright test --project=operation-smoke
rg -n '@aiteam/shared/ui|glass|text-gold|bg-surface|border-gold|text-text-|rounded-window|tailwindcss' web/operation
```

Expected: unit tests, typecheck, build, and E2E all pass; zero-legacy scan has no source/config matches.

- [ ] **Step 5: Record evidence and commit**

Record test counts, routes, axe result, screenshots, browser errors, gzip JS/CSS size, warnings, zero-legacy output, and GO/NO-GO.

```bash
git add web/operation web/e2e/operation web/pnpm-lock.yaml docs/superpowers/specs/2026-07-11-operation-astryx全量迁移验收.md
git commit -m "refactor(operation): complete Astryx rollout and remove legacy UI"
```
