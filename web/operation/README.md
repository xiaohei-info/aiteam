# @aiteam/operation-web · 运营端前端

AI Team v1 **运营端前端**（独立工程 / 独立构建，v1 概要设计 08 §12.1）。三套独立前端工程之一，**只调本端** `/api/operation/*` 与 `/api/auth/*`（同 origin）。

## 边界（D3 / D15）

- 只调本端 `/api/operation/*` 与 `/api/auth/*`；跨端（`/api/manager/*`、`/api/agent/*`）由 `@aiteam/shared` 的 `ApiClient` 基类在发请求前拦截抛 `cross_tier_call_forbidden`。
- 公共能力一律从 `@aiteam/shared` import（page-shell / api-client / role-state / i18n / 设计系统 / contracts），**禁止复制**。
- 只消费归一后的 `BusinessTimelineEvent`，不绑定 runtime 原始事件（D6）。

## 目录

```
src/
├── api/            # 本端 api-client 工厂（基于 shared ApiClient 基类）
├── auth/           # 会话上下文 + RequireAuth 门控
├── i18n/           # 运营端文案（合并进 shared I18n）
├── pages/          # 路由页面（登录页骨架 + 业务占位，待 W-O.2/3/4 接入）
├── shell/          # AppShell + 运营端导航配置（基于 shared page-shell）
├── styles/         # 全局 CSS（设计 token 镜像自 shared）
├── App.tsx         # 根路由
├── AppProviders.tsx# i18n + 会话上下文装配
└── main.tsx        # 入口
```

## 开发

```bash
pnpm install            # 在 web/ 下
pnpm -C operation dev   # dev server（/api 代理到 operation_service，默认 :8000）
pnpm -C operation build # tsc --noEmit + vite build → dist/
pnpm -C operation test  # vitest（边界门控 + 壳配置 + 登录页骨架）
```

## 后续卡

- W-O.2 企业开通页（F01/F02）
- W-O.3 目录治理页（F03）
- W-O.4 跨企业治理看板（rollup）

口径以 v1 概要设计 08 + 仓库 `CLAUDE.md` 为准。
