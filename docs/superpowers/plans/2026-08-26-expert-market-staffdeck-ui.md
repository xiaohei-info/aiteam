# Operator / Manager 专家与人才市场 StaffDeck 风格迭代计划

## 目标与边界

- 参考 OpenBMB/StaffDeck 的数字员工页面：柔和中性背景、圆角信息卡、头像/角色层级、状态与能力标签、搜索/筛选、响应式卡片网格。
- 在现有 Astryx 组件、API 和权限边界上迭代，不改变后端契约、招募/发布/生命周期语义，不引入新 UI 依赖。
- Operator 优化专家目录 `/experts`；行业方案 `/industry-solutions` 保留现有表格工作台，避免扩大范围。
- Manager 优化人才市场 `/marketplace` 与已招募专家 `/experts`，保留现有配置抽屉、招募、生命周期操作。
- 保留可访问名称、键盘操作、加载/错误/空状态和已有 API 行为；不在卡片展示内部 ID。

## 涉及模块与文件

- `web/operation/src/features/catalog/CatalogPage.tsx`：专家列表改为卡片工作台，增加统计、搜索/状态筛选、头像/能力/模型/生命周期展示；方案列表继续使用表格。
- `web/operation/src/features/catalog/catalog.css`（新增）：Operator 专家卡片和工具栏样式，复用 Stone/Astryx 色彩，不污染其他页面。
- `web/operation/src/features/catalog/catalog.test.tsx`：覆盖卡片渲染、筛选、状态/操作回归。
- `web/manager/src/features/marketplace/MarketplacePage.tsx`：人才市场增加统计、搜索/分类筛选和数字员工卡片布局，招募权限及成功/失败反馈不变。
- `web/manager/src/features/experts/ExpertsPage.tsx`：已招募专家由表格改为卡片网格，增加搜索/状态筛选与配置摘要，保留配置抽屉和生命周期按钮。
- `web/manager/src/features/experts/experts.css`（新增）：Manager 专家/人才市场共享视觉样式。
- `web/manager/src/features/marketplace/__tests__/MarketplacePage.test.tsx`、`web/manager/src/features/experts/__tests__/ExpertsPage.test.tsx`：同步 UI 语义断言并新增筛选/卡片回归。

## 实施顺序

1. 先确认当前工作树中的 Agent/后端未提交改动不触碰；完成 StaffDeck 页面与当前 Astryx 能力对照。
2. 抽取最小的纯展示辅助函数（状态、首字母、模型/能力标签），先实现 Operator 专家卡片视图，方案路径维持原逻辑。
3. 实现 Manager 人才市场卡片视图与本地筛选；不额外增加 API 请求，统计只基于已加载模板。
4. 实现 Manager 已招募专家卡片视图与筛选；生命周期、配置抽屉和权限调用保持原入口。
5. 为两端加入局部 CSS：响应式 `auto-fit` 网格、圆角/阴影/灰色头部、头像徽标、状态点、底部统计区、移动端降级。
6. 同步测试，先跑目标 Vitest，再跑两端 typecheck/build；确认 diff 不包含非目标文件。
7. 若本地服务可用，执行 Operator/Manager 专家与人才市场页面 smoke；否则记录未执行原因，不以静态构建替代浏览器验收。

## 关键约束与非目标

- 不修改 `useCatalogApi`、`useExpertsApi` 或任何后端 schema/API。
- 不恢复旧方案字段、不展示模板/员工内部 ID、不绕过角色门控。
- 不复制 StaffDeck 后端逻辑或引入其依赖/资源；仅采用页面信息架构和视觉语言。
- 不重构全局 AppShell/主题；样式局部化，避免影响 Agent 或其他业务页。

## 完成标准与验证

- Operator `/experts` 与 Manager `/marketplace`、`/experts` 均呈现响应式数字员工卡片，搜索/筛选、空/错/加载状态可用。
- 发布/下架、招募、配置、激活/暂停/恢复仍调用原 API，权限与确认流程不变。
- 目标测试、两端 TypeScript 检查、生产构建通过；`git diff --check` 通过。
- 已有 Agent/Manager 后端等并发未提交改动保持原样。
