# Operation 端骨架统一 + AppShell + 登录 + Dashboard（#135）实施计划

> 仅前端：零后端 / 零 API·契约改动。模式对齐 #131（Manager 骨架）。

**Goal:** Operation 端接入 Tailwind v4 + app-kit，shell 改用 shared AppShell，登录/Dashboard 黑金重写。

## Task 1: Tailwind v4 + app.css
- Modify `web/operation/vite.config.ts`：plugins 加 `tailwindcss()`
- Create `web/operation/src/styles/app.css`：@import tailwindcss + shared tokens.css + @source shared + body 黑金基样

## Task 2: app-kit providers
- Modify `web/operation/src/main.tsx`：ErrorBoundary > QueryProvider > BrowserRouter > AppProviders > App；import app.css

## Task 3: shell 改 shared AppShell
- Rewrite `web/operation/src/shell/AppShell.tsx`：useLocation + buildShellViewModel + shared AppShell（renderLink 走 react-router Link，active=id===activeItemId）；requiresLogin→<Outlet/>

## Task 4: 登录页黑金
- Rewrite `web/operation/src/pages/LoginPage.tsx`：GlassPanel+Field+Input+Button；form `data-testid="login-form"`；保留 i18n key（operation.title/login.phone/login.secret/login.submit/login.required/login.pending_backend）与脚手架行为（不造假 token、已登录 Navigate）
- Modify `web/operation/src/pages/LoginPage.test.tsx`：`.login-page__form` querySelector → `queryByTestId("login-form")`

## Task 5: Dashboard 黑金
- Rewrite `web/operation/src/pages/DashboardPlaceholder.tsx`：GlassPanel 包裹，保留 operation.nav.dashboard/operation.placeholder

## Task 6: 验证
- shared build；operation typecheck + test；agent/manager 回归；operation build + grep dist CSS；确认仅 web/ + docs/
