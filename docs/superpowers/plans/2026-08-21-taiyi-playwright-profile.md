---
created: 2026-08-21
status: implemented-taiyi-smoke-partial
scope: taiyi-playwright
---

# taiyi 外部部署 Playwright profile

## 目标

让同一套 `web/e2e` 通过环境变量连接已部署的 taiyi Operation/Manager/Agent，而不是强制启动本地 dev webServer。默认本地 DAG 行为不变。

## 约束

- `E2E_EXTERNAL=true` 时不启动 Playwright webServer、不执行本地 DB seed；使用显式 `E2E_TENANT_ID` 和三端凭据。
- UI/API origin 必须分别可配置；taiyi 单机可通过 SSH port-forward 暴露 8781/8782/8783。
- 不绕过 Agent 登录；storageState 仍通过真实三端 login API 生成。
- 默认配置和 harness origin invariant 测试保持不变。

## 实施

- `web/e2e/support/auth.ts`：UI/API origin 使用环境变量覆盖。
- `web/e2e/support/globalSetup.ts`：external 模式跳过 seed，仅使用既有 tenant；仍构建 shared 并真实登录。
- `web/playwright.config.ts`：external 模式关闭 webServer，smoke/cross-tier 使用配置 origin；本地模式完全不变。
- 增加 external 配置/命令文档和最小 profile 检查。

## 验收结果

- 本地默认 Playwright 配置仍列出 114 tests / 17 files；
- taiyi external profile 已连接三端 root/health/login；
- Operation smoke：全部通过；
- Manager smoke：全部通过；
- Agent smoke：5/10 通过。

Agent 剩余失败已定位：taiyi 当前 Agent 部署版本的 OpenAPI 尚未发布 abort path，Agent UI chat/keyboard gate 与当前部署静态前端不一致；不是 external profile 隐藏失败。下一步需先把最新 Agent server/UI 产物部署到 taiyi，再重跑 Agent/cross-tier。
