# Operation Astryx 全量迁移验收

日期：2026-07-11

结论：**GO**

## 范围

运营端 Operation 的登录、应用壳、运营概览、企业开通、账号生命周期、配额与充值、跨企业治理、财务、行业方案、系统健康、目录浏览、目录详情和模板注册已全部迁移为直接使用 Astryx。旧共享 UI、Tailwind 构建链、旧设计 token 和历史 utility class 已从 Operation 源码与配置删除。

目录注册原 762 行巨型组件已拆为职责清晰的表单、运行时配置、团队成员和校验模块；目录详情中的版本、生命周期和概览也已拆分，避免把新 UI 建在新的技术债上。

## 自动化验证

- 单元/组件测试：19 个测试文件，162/162 通过。
- TypeScript：`tsc -b --noEmit` 通过。
- 生产构建：Vite 构建通过。
- Operation Playwright：15/15 通过。
- 冻结锁文件离线安装：5 个 workspace 均已是最新，安装成功。

## 浏览器验收

已覆盖：

- 登录页标题、表单和认证链路。
- 概览、企业开通、账号、目录、目录注册、治理、财务、方案和系统健康页面的标题、主地标与可达性。
- 隐藏目录模板前的破坏性确认。
- 概览和目录详情 light/dark 视觉快照。
- axe critical/serious 可访问性门禁。
- 真实 Tab 焦点移动。
- 页面 console/page error 门禁。
- Operation 既有 API contract 与页面 smoke。

快照：

- `web/e2e/operation/astryx-rollout.spec.ts-snapshots/operation-dashboard-light-operation-smoke-darwin.png`
- `web/e2e/operation/astryx-rollout.spec.ts-snapshots/operation-dashboard-dark-operation-smoke-darwin.png`
- `web/e2e/operation/astryx-rollout.spec.ts-snapshots/operation-catalog-detail-light-operation-smoke-darwin.png`
- `web/e2e/operation/astryx-rollout.spec.ts-snapshots/operation-catalog-detail-dark-operation-smoke-darwin.png`

## 零历史包袱门禁

`web/operation/src/astryx/no-legacy-ui.test.ts` 持续扫描并拒绝：

- `@aiteam/shared/ui`
- Glass/旧黑金样式标记
- Tailwind utility `className` 字符串
- `tailwindcss` 与 `@tailwindcss/vite`
- `@source`
- `@aiteam/shared/design-system/tokens.css`

门禁 2/2 通过。Operation 的 `package.json`、Vite 和 CSS 入口不再保留旧 UI 构建链。

## 构建体积

- CSS：138.43 kB，gzip 25.69 kB。
- JS：611.57 kB，gzip 188.64 kB。
- gzip JS + CSS：214.33 kB。

## 已知非阻断警告

- React Router 6 测试环境提示未来 v7 transition/splat flag；不影响当前行为。
- Vite 提示单 JS chunk 超过 500 kB；当前 gzip 188.64 kB，不阻断本次功能上线，三端完成后统一评估路由级动态拆包。
- Playwright 子进程提示 `NO_COLOR` 被 `FORCE_COLOR` 覆盖；不影响测试结果。

## 上线裁决

Operation 已达到页面、行为、可访问性、构建、浏览器与零 legacy 的上线门槛，可以正式 GO。Manager 与 Operation 均已完成；Agent 尚未完成，因此三端整体仍不可最终上线。
