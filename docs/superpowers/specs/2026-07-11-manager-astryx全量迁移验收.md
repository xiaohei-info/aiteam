# Manager Astryx 全量迁移验收

日期：2026-07-11

结论：**GO**

## 范围

企业端 Manager 的登录、应用壳、仪表盘、成员、授权、组织、知识库、Provider、LLM、能力目录、市场、专家、方案、计费、设置、连接器、记忆、审计和治理页面已全部迁移为直接使用 Astryx。旧共享 UI、Tailwind 构建链、旧设计 token 和历史 utility class 已从 Manager 源码与配置删除。

## 自动化验证

- 单元/组件测试：32 个测试文件，216/216 通过。
- TypeScript：`tsc -b --noEmit` 通过。
- 生产构建：Vite 构建通过，2213 个模块完成转换。
- Manager Playwright：23/23 通过。
- 用户端精简产物隔离：`test_user_client_build_excludes_control_plane` 1/1 通过。

## 浏览器验收

已覆盖：

- 登录页标题、表单和认证链路。
- Members、Providers、Governance、Audit 的标题、主地标和页面可达性。
- 治理页 light/dark 视觉快照。
- axe critical/serious 可访问性门禁。
- 真实 Tab 焦点移动。
- 页面 console/page error 门禁。
- Manager 既有 API contract 与页面 smoke。

快照：

- `web/e2e/manager/astryx-rollout.spec.ts-snapshots/manager-rollout-light-manager-smoke-darwin.png`
- `web/e2e/manager/astryx-rollout.spec.ts-snapshots/manager-rollout-dark-manager-smoke-darwin.png`

## 零历史包袱门禁

`web/manager/src/astryx/no-legacy-ui.test.ts` 持续扫描并拒绝：

- `@aiteam/shared/ui`
- Glass/旧黑金样式标记
- Tailwind utility `className` 字符串
- `tailwindcss` 与 `@tailwindcss/vite`
- `@source`
- `@aiteam/shared/design-system/tokens.css`

门禁 2/2 通过。Manager 的 `package.json`、Vite、Vitest 和 CSS 入口不再保留旧 UI 构建链。

## 构建体积

- CSS：138.43 kB，gzip 25.69 kB。
- JS：639.59 kB，gzip 190.36 kB。
- gzip JS + CSS：216.05 kB。

## 已知非阻断警告

- React Router 6 测试环境提示未来 v7 transition/splat flag；不影响当前行为。
- Vite 提示单 JS chunk 超过 500 kB；当前 gzip 190.36 kB，不阻断本次功能上线，后续可在三端完成后统一评估路由级动态拆包。
- Playwright 子进程提示 `NO_COLOR` 被 `FORCE_COLOR` 覆盖；不影响测试结果。

## 上线裁决

Manager 已达到页面、行为、可访问性、构建、浏览器与零 legacy 的上线门槛，可以作为三端新前端中的第一个正式 GO 端。Operation 与 Agent 尚未完成，因此三端整体仍不可最终上线。
