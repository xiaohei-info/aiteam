# Agent Astryx 全量迁移验收

日期：2026-07-12

结论：**GO；三端新前端整体 GO**

## 范围

用户端 Agent 的登录、应用壳、工作台、私聊、群聊、人才市场、知识库、办公室、组织架构、同步与用量、设置、Run、Loop、Task 和本地终端已全部迁移为直接使用 Astryx。原有会话、时间线、message → run、group-dispatch、快照冻结、本地执行和脱敏摘要语义保持不变。

三端完成后继续执行了最终物理清理：`web/shared/src/ui`、旧黑金 `design-system`、token CSS 生成脚本、历史导出以及 `@radix-ui/react-slot`、`clsx`、`tailwind-merge` 直接依赖均已删除。共享包构建会主动清除旧 `dist/ui` 与 `dist/design-system`，不会把历史产物残留到交付物。

## 自动化验证

- Agent 单元/组件测试：24 个测试文件，156/156 通过。
- Shared 单元测试：10 个测试文件，45/45 通过。
- 三端及共享前端总计：85 个测试文件，579/579 通过。
- 三端及共享 TypeScript：全部通过。
- 三端生产构建：全部通过。
- Agent Playwright：18/18 通过。
- 全套 Playwright：120 通过，1 个按测试条件跳过，0 失败。
- 用户端精简产物隔离：`test_user_client_build_excludes_control_plane` 1/1 通过。
- 冻结锁文件离线安装：5 个 workspace 安装成功。

## 浏览器验收

已覆盖：

- 登录页与真实认证链路。
- 工作台、人才市场、知识库、办公室、组织架构、设置、同步与用量的标题、主地标和页面可达性。
- 私聊 light/dark 视觉快照、dark/reduced-motion 可用性。
- 私聊真实 message → run 主链。
- 群聊、Run、授权快照与用量 outbox smoke。
- axe critical/serious 可访问性门禁。
- 真实键盘焦点可见性。
- 页面 console/page error 门禁。

快照：

- `web/e2e/agent/astryx-chat.spec.ts-snapshots/agent-chat-light-agent-smoke-darwin.png`
- `web/e2e/agent/astryx-chat.spec.ts-snapshots/agent-chat-dark-agent-smoke-darwin.png`

## 零历史包袱门禁

端内门禁持续拒绝：

- `@aiteam/shared/ui`
- Tailwind utility `className` 字符串
- Glass/旧黑金样式标记
- `tailwindcss`、`@tailwindcss/vite` 与 `@source`
- `@aiteam/shared/design-system/tokens.css`

共享门禁进一步断言旧 UI、旧 design-system、旧 token 构建脚本、旧 package exports、旧依赖及其历史 dist 目录均不存在。Agent、Manager、Operation 与 Shared 的零 legacy 门禁全部通过。

## 构建体积

- Agent CSS：138.43 kB，gzip 25.69 kB。
- Agent JS：579.67 kB，gzip 179.30 kB。
- Agent gzip JS + CSS：204.99 kB。

## 已知非阻断警告

- React Router 6 测试环境提示未来 v7 transition/splat flag；不影响当前行为。
- 三端 Vite 均提示单 JS chunk 超过 500 kB；Agent gzip JS 为 179.30 kB，后续可独立做路由级动态拆包，不阻断上线。
- Playwright 子进程提示 `NO_COLOR` 被 `FORCE_COLOR` 覆盖；不影响测试结果。
- 全量跨端并发验收中服务间调用曾记录一次超时堆栈，但用例按既定恢复路径完成，最终 120 个用例通过且无失败。

## 上线裁决

Agent 已达到页面、行为、可访问性、构建、浏览器、跨端主链、分端产物和零 legacy 的上线门槛。Manager、Operation、Agent 三端均为 GO，旧共享 UI 与黑金/Tailwind 技术栈已经物理删除，三端新前端可以进入合并与发布流程。
