# @aiteam/manager-web · 企业端前端

AI Team v1 **企业端前端**（独立工程 / 独立构建，v1 概要设计 08 §12.1）。三套独立前端工程之一，**只调本端** `/api/manager/*` 与 `/api/auth/*`（同 origin）。

## 边界（D3 / D15）

- 只调本端 `/api/manager/*` 与 `/api/auth/*`；跨端（`/api/operation/*`、`/api/agent/*`）由 `@aiteam/shared` 的 `ApiClient` 基类在发请求前拦截抛 `cross_tier_call_forbidden`。
- 公共能力一律从 `@aiteam/shared` import（page-shell / api-client / role-state / i18n / 设计系统 / contracts），**禁止复制**。
- 企业角色只用 `owner | enterprise_admin | finance_admin | member`（`EnterpriseRole`），禁旧 `admin/manager/viewer`。

## 企业端业务面（08 §12.1）

成员账号 / 招募专家 / 成员级授权 / 企业治理。本卡（W-M）只落骨架与角色门控，细分业务页由后续卡接入：

| 导航 | 路由 | 可见角色 |
|------|------|----------|
| 企业概览 | `/` | 登录即可见（含 member） |
| 成员账号 | `/members` | owner / enterprise_admin |
| 招募专家 | `/marketplace` | owner / enterprise_admin |
| 方案目录 | `/solutions` | owner / enterprise_admin |
| 成员级授权 | `/grants` | owner / enterprise_admin |
| 企业治理 | `/governance` | owner / enterprise_admin / finance_admin |

## 目录

```
src/
├── api/            # 本端 api-client 工厂（基于 shared ApiClient 基类）+ 边界测试
├── auth/           # 会话上下文 + RequireAuth 门控
├── i18n/           # 企业端文案（合并进 shared I18n）
├── pages/          # 路由页面（登录页骨架 + 业务占位，待后续卡接入）
├── shell/          # AppShell + 企业端导航配置（基于 shared page-shell）
├── styles/         # 全局 CSS（设计 token 镜像自 shared）
├── App.tsx         # 根路由
├── AppProviders.tsx# i18n + 会话上下文装配
└── main.tsx        # 入口
```

## 开发

```bash
pnpm install                 # 在 web/ 下
pnpm --filter @aiteam/manager-web dev    # dev server（/api 代理到 manager_service，默认 :8000）
pnpm --filter @aiteam/manager-web build  # tsc -b --noEmit + vite build → dist/
pnpm --filter @aiteam/manager-web test   # vitest（边界门控 + 壳配置 + 登录页骨架）
```

口径以 v1 概要设计 08 + 仓库 `CLAUDE.md` 为准。
