# 2026-07-01-manager-talent-market-split — Design: 拆分「招募专家+方案」为「人才市场」+「方案目录」

> 目标：manager 端「招募专家」和「应用行业方案」不应塞在同一个侧边菜单 / 同一页；应拆为两个独立菜单入口。参照旧架构下 manager 端人才市场 UX（原 issue 要求按 admin/templates 实现 — 即：从 Operator 目录拉专家模板 → 招募为 tenant 实例；方案包单独一页浏览与应用）。
> 分支：feature/v1.0.0（前端三套独立工程 `web/{agent,manager,operation}`）。

## 现状（feature/v1.0.0）

- `web/src/manager/src/App.tsx:30` 仅注册 `/experts`（ExpertsPage）。
- `web/src/manager/src/shell/config.ts:10-11` nav 只有 `experts = 招募专家`，但另一项 `solution_apply` 无对应页面挂载（solution-apply feature 当前是一个历史记录页 `SolutionApplyHistoryPage`，挂在 solution-apply 路由，功能错位）。
- `ExpertsPage`（523 行）一头包三段：① 可招募专家模板（浏览+招募，调 `/api/manager/recruit/catalog/experts`、`/api/manager/recruit/experts`）② 可应用行业方案目录（浏览+应用，调 `/api/manager/recruit/catalog/solutions`、`/api/manager/recruit/solutions`）③ 已招募实例（员工列表）+ 已应用方案实例。
- 违反了 manager 原 UX：招募专家应该在「人才市场」里完成；方案的浏览与应用是独立的「方案目录」页。

> 参考：SSD1T aiteam 旧前端 `admin-templates.js`（manager 端人才市场）、`admin-solutions.js`（manager 端行业方案）；同一份 api 在新架构里走 `team_panel/api_team/...`。

## 目标

1. 侧边菜单保留「人才市场」(`experts`)、**新增**「方案目录」(`solutions`) 两个入口。
2. 「人才市场」页只承担 ① 专家目录 + 招募跳转（不再混方案列表）。
3. 「方案目录」页 = 方案目录浏览 + 应用（方案目录数据来自 Operator catalog）。
4. 旧接口、鉴权、多语言 key 保持复用，仅做职责拆分和平迁。

## 非目标

- 不新增/改后端接口（保留 `/api/manager/recruit/catalog/experts|solutions`、`POST /experts`、`/solutions`）。
- 不动「已招募实例」主视图（员工配置页，`/members` / `admin-employees`）。
- 不动 operation/admin/system 端。

## 方案

### 推荐方案（A）：把 ExpertsPage 拆为两个 feature 子页 + 采用已有的 SolutionApplyHistoryPage 演进

- 在 `web/manager/src/features/experts/` 拆出 `TalentMarketPage.tsx`（人才市场，专注 ①），复用 `useExpertsApi` 的 `listTemplates/recruitExpert/pollOrder`；禁掉方案的 ②③ 段落。
- 在 `web/manager/src/features/solutions/` 新建 `SolutionsPage.tsx`（方案目录，专注 ②），复用 `useExpertsApi` 的 `listSolutions/applySolution/pollOrder/listSolutionInstances`，并把 `solution-apply` 的旧历史页 `SolutionApplyHistoryPage.tsx` 平移进 `features/solutions/index.ts` 的子路由或在 SolutionsPage 内以 history 区段呈现。
- `App.tsx` 路由由 1 条改为 2 条：`/experts` → `TalentMarketPage`、`/solutions` → `SolutionsPage`。
- `web/manager/src/shell/config.ts` nav：id `experts` 保留但 label 改为「人才市场」；新增 `solutions` label 「方案目录」。（保留 `solution_apply` key 向后兼容或删除。）
- i18n：新增 `manager.nav.talent_market = 人才市场`、`solutions_title`、`apply_solution_*` 等；复用现有 `manager.experts.*` 大部分 key。

### 备选方案（B）：页面不动，仅菜单加一项胶囊切到 ExpertsPage 内部子视图

- 菜单点击仍指向 `/experts`，但 ExpertsPage 顶部 tabs（「专家招募 | 方案招募」）。
- 优点：零路由变动；缺点：①③ 仍与方案段耦合、问题根本未解。
- 不推荐：issue 诉求是「人才市场」独立，A 更直接。

## 数据流（不变）

```
前端 manager ──/api/manager/recruit/catalog/experts──→ OperatorCatalogPort.list_expert_templates()
前端 manager ──/api/manager/recruit/catalog/solutions──→ OperatorCatalogPort.list_solution_packages()
前端 manager ──POST /api/manager/recruit/experts────→ RecruitService.recruit_expert() → 落 employee + 审计
前端 manager ──POST /api/manager/recruit/solutions──→ RecruitService.apply_solution() → 落 solution_instance + 审计
```

## 影响面

- `web/manager/src/features/experts/*` 瘦身（移走 ②③）。
- 新增 `web/manager/src/features/solutions/*`。
- 路由/nav/i18n 三处。
- 测试：旧的 `ExpertsPage.test.tsx` 重命名为 `TalentMarketPage.test.tsx` 并裁掉断言方案/实例段落；新建 `SolutionsPage.test.tsx`。`config.test.ts` 补 solutions nav 断言。

## 风险点

- 把 ExpertsPage ③（已招募实例段）挪走不可行：因为员工主视图已在「成员」页（`/members`），③ 在 manager 端本就重复，删掉不影响运营；若是唯一依赖要保留，可在 SolutionsPage 输出「最近应用」。
- `/solutions` 路由不能和「成员页详情路由」冲突（现在成员页路由是 `/members`、无 `/solutions`，OK）。

## 验收标准（AC）

1. 侧边菜单显示「人才市场 + 方案目录」两个入口，点击分别进入不同页。
2. 「人才市场」页只展示 Operator 目录专家列表 + 招募（不再混入方案列表）。
3. 「方案目录」页展示 Operator 目录方案列表 + 应用，且显示最近应用历史。
4. 招募专家操作可正常完成（拉模板→招募 order → 导航到新员工）。
5. manager UI 测试（`pnpm vitest` 在 `web/`）全绿；i18n key 无缺失。
