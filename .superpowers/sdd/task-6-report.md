# Task 6 完成报告：Governance + Manager rollout E2E

## 交付

- `web/manager/src/features/governance/GovernancePage.tsx`
  - 用 Astryx `Heading`、`Card`、`Grid`、`Table`、`FormLayout`、`NumberInput`、`Selector`、`Button`、`Badge`、`Banner`、`Skeleton` 与 `EmptyState` 重建治理页。
  - 保持既有治理 API、配额创建 payload 和脱敏聚合摘要边界不变。
  - 增加本地员工/审计动作筛选、命名表格、加载/错误/空状态及禁用空 slug 提交。
- `web/manager/src/features/governance/__tests__/GovernancePage.test.tsx`
  - 覆盖配额创建/评估/删除、只读角色、表格与筛选入口、空/加载/错误状态及禁用提交。
- `web/e2e/manager/astryx-rollout.spec.ts` 与 snapshots
  - 覆盖 Login、Members、Providers、Governance、Audit 的标题与主地标。
  - 覆盖 axe critical/serious、真实 Tab 焦点、浏览器错误和治理 light/dark 快照。

## TDD 证据

- 先新增治理单测：旧共享 UI 缺少命名表格、筛选、Astryx 卡片、加载状态和禁用提交，初次运行出现 4 个预期失败。
- 先新增 rollout E2E：旧治理页在命名表格和 axe serious 对比度门禁失败；实现后重新生成快照并通过。

## 验证

- `corepack pnpm@11.4.0 exec vitest run src/features/governance/__tests__/GovernancePage.test.tsx`：8/8 通过。
- `corepack pnpm@11.4.0 run typecheck`：通过。
- `corepack pnpm@11.4.0 exec playwright test --project=manager-smoke e2e/manager/astryx-rollout.spec.ts --update-snapshots`：3/3 通过。
- 同一 Playwright 命令（无 `--update-snapshots`）：3/3 通过。

## 范围审计

- 未修改 `@aiteam/shared/ui`、Tailwind utility 或兼容 wrapper。
- 工作区中已有 `grants`、`members`、`org` 的并行改动；未读取后回退或覆盖，未纳入本任务提交。
