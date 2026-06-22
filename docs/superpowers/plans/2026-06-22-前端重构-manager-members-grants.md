# Manager 成员/部门/授权（#132）黑金重写 实施计划

> 仅前端表现层改造：零后端改动、零 API/契约改动；保留全部 testid / getByLabelText 标签 / 按钮文案 / 红线行为 / hook 逻辑。

**Goal:** 用黑金玻璃质感 + 新增 shared UI 原子组件（Input/Select/Field/Table）重写 Manager `members`/`grants` 两页，消除 BEM 与表单类重复。

**Architecture:** 新增 4 个 shared UI 原子组件（表现与逻辑分离、forwardRef、cn 合并 className），两页改用之；保留原生 `<select multiple>`（多选测试依赖 options/selected）、`<label>` 包裹控件（getByLabelText 依赖）、所有 data-testid 与 i18n key。

**Tech Stack:** React 18 + Tailwind v4 黑金 token + @aiteam/shared/ui。

---

## Task 1: shared UI 原子组件 Input/Select/Field

**Files:**
- Create: `web/shared/src/ui/input.tsx`、`select.tsx`、`field.tsx`
- Create: `web/shared/src/ui/__tests__`（或同级）`input.test.tsx`
- Modify: `web/shared/src/ui/index.ts`（导出）

- [ ] Input/Select：forwardRef 原生 input/select，黑金边框 + focus ring，cn 合并 className
- [ ] Field：`<label><span>{label}</span>{children}</label>`，保证 getByLabelText 关联
- [ ] 测试：渲染 + className 合并 + Field 关联 getByLabelText
- [ ] 导出到 index.ts

## Task 2: shared UI Table 原语

**Files:**
- Create: `web/shared/src/ui/table.tsx` + `table.test.tsx`
- Modify: `web/shared/src/ui/index.ts`

- [ ] Table：`<table>` 挂黑金基类（`[&_th]`/`[&_td]` 描述符样式 + 行 hover）
- [ ] 测试：渲染 children + className 合并

## Task 3: MembersPage 黑金重写

**Files:**
- Modify: `web/shared/src/ui` build 后；`web/manager/src/features/members/MembersPage.tsx`

- [ ] section/标题/凭据面板/错误用 GlassPanel + 黑金 class（凭据面板 role=status 不变）
- [ ] 表格改 shared Table；行保留 `data-testid="member-row"`
- [ ] 创建表单改 Field+Input+Select+Button；label 文案走原 i18n key（getByLabelText 不变）
- [ ] 按钮文案 创建成员/停用/启用 不变；canWrite 门控不变；凭据红线不变
- [ ] `pnpm --filter @aiteam/manager test` MembersPage 全绿

## Task 4: GrantsPage 黑金重写

**Files:**
- Modify: `web/manager/src/features/grants/GrantsPage.tsx`

- [ ] 同 Task 3 改造；保留 `grant-row`、原生多选 select、空授权守卫、撤销
- [ ] getByLabelText 授权资源/成员/部门 不变；按钮 授权/撤销 文案不变
- [ ] GrantsPage 测试全绿

## Task 5: 全量验证

- [ ] `pnpm --filter @aiteam/shared build`（消费方依赖 dist）
- [ ] shared / manager / agent / operation 测试全绿
- [ ] manager build；grep dist CSS 确认新增 class 编译（无静默丢弃）
- [ ] 确认零后端改动（git diff 仅 web/ 与 docs/）
