# Manager Astryx 全量迁移设计

## 核心判断

值得做。Manager 已有 Astryx AppShell 与 Audit 标杆，剩余问题不是业务能力缺失，而是 20 个页面/子面板仍依赖旧 `@aiteam/shared/ui`、Tailwind utilities 与黑金 token。继续混用会持续制造对比度、主题和删除边界问题；本阶段应在不改变 API、路由、角色和状态语义的前提下，把 Manager 端一次收口到纯 Astryx。

## 选择的路径

采用“按复杂度分五批、每批可运行、Manager 端末尾归零”的方案。

- 不采用一次性大爆炸：20 个入口中包含复杂表单、树、抽屉和治理工作台，一次提交难以审查和回归。
- 不采用旧组件兼容包装：禁止新增 `LegacyButton`、`GlassPanelAdapter`、旧 props 到 Astryx props 的桥接层；这会直接违背 zero-legacy 目标。
- 允许少量新的 Manager-local 业务组合，但只在两个以上页面具有同一业务语义时创建；它们必须直接组合 Astryx，不暴露旧组件 API。

## 架构边界

- 路由保持 `web/manager/src/App.tsx` 现有路径不变。
- API hooks、types、认证、TenantContext 相关行为不变；页面继续只调用本端 `/api/manager/*` 与 `/api/auth/*`。
- 页面状态保持 feature-local；不引入全局 UI store，不持久化 loading、展开、筛选等展示态。
- 直接使用 Astryx `Heading`、`Card`、`Table`、`TextInput`、`Selector`、`Button`、`Dialog`、`Pagination`、`EmptyState`、`Skeleton`、`Banner`、`Grid/VStack/HStack` 等原语。
- 不修改 shared 业务语义库，不修改后端、数据库、API envelope、错误模型和角色枚举。

## 分批顺序

1. **基础与简单页**：Login、Dashboard、Connectors、Billing、Recharge、Memory、Settings。建立登录/空状态/卡片/简单表单的直接 Astryx 口径。
2. **目录与详情页**：Marketplace、Solutions、Experts、EmployeeConfigDrawer、SolutionApplyHistory。建立卡片目录、详情 Dialog/Drawer 与状态标签口径。
3. **配置工作台**：Providers、Capability、LLM。拆分过大的表单区块，使用 Astryx FormLayout、输入控件、Table 与 Dialog，保留现有 CRUD 顺序和校验。
4. **租户组织与知识**：Members、Grants、Org、Knowledge、DocumentsPanel。保留成员/授权/部门/知识绑定数据流，树和批量操作只改渲染。
5. **治理与端内清理**：Governance；随后删除 Manager 的所有 `@aiteam/shared/ui` import、Tailwind Vite 插件与 Tailwind CSS imports、`@source shared`、`@aiteam/shared/design-system/tokens.css`。Manager 构建产物不得再含 `.glass`、`text-gold`、`bg-surface` 等旧类。

## 数据流与错误处理

- 所有已有 `use*Api` hook 保持函数签名；页面继续通过 hook 拉取/提交。
- loading 使用 Skeleton/Spinner，空数据使用 EmptyState，页面级失败使用 Banner/role=alert；提交失败保留用户输入，不关闭 Dialog。
- 防陈旧请求原则复用 Audit：异步 effect 必须在卸载或依赖变化后禁止旧请求回写。
- destructive action 保留现有确认步骤；不得因为换 UI 缩短权限或确认链。

## 可访问性与交互

- 每页唯一 `h1`；表格、导航、Dialog、表单字段都有可访问名称。
- icon-only 按钮必须提供 label/tooltip；状态不能只靠颜色表达。
- 键盘可完成列表筛选、分页、Dialog 打开/关闭、表单提交与取消。
- 不新增页面切换动画、列表 stagger、`transition: all`、`ease-in`、`scale(0)` 或布局属性动画。
- light/dark 均由 `Theme mode="system"` 驱动，不在页面写固定浅色/深色值。

## 测试与完成标准

- 每批先强化现有 Vitest 语义断言，再替换渲染；API hook 测试继续作为行为回归。
- 每批完成后运行对应 feature tests、Manager 全量 192+ tests、typecheck 和 build。
- 扩展 Manager Playwright，至少覆盖 Login、Members、Providers、Governance 与既有 Audit 的 light/dark、axe、键盘和 browser-error 门禁。
- Manager 端最终完成条件：
  - `rg '@aiteam/shared/ui|glass|text-gold|bg-surface|border-gold' web/manager/src` 无命中；
  - Manager package/config/CSS 不再依赖 Tailwind；
  - Manager 全量 unit/build/E2E 通过；
  - 路由和 API 请求路径与迁移前一致；
  - 不存在旧 UI wrapper、alias 或双实现。

## 非目标

- 不迁移 Operation 或 Agent 的剩余页面。
- 不调整 Manager 业务流程、后端契约、权限、租户隔离或数据模型。
- 不在本阶段删除 shared 旧 UI 源码；它仍被 Operation/Agent 使用，待三端迁移完成后统一物理删除。
- 不为体积数字提前引入复杂手工分包；每批记录增量，最终基于实测处理。
