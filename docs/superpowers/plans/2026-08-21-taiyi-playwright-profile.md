---
created: 2026-08-21
status: completed-taiyi-smoke
scope: taiyi-playwright
---

# taiyi 外部部署 Playwright profile

## 目标

让同一套 `web/e2e` 通过环境变量连接已部署的 taiyi Operation/Manager/Agent，而不是强制启动本地 dev webServer。默认本地 DAG 行为不变。

## 约束

- `E2E_EXTERNAL=true` 时不启动 Playwright webServer、不执行本地 DB seed；使用显式 `E2E_TENANT_ID`、`E2E_AGENT_EMPLOYEE_ID` 和三端凭据；缺少员工 ID 时在 globalSetup fail-fast，避免 prompt/delegation 用例得到误导性的 403。
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
- 外部运行必须提供 `E2E_TENANT_ID`、`E2E_AGENT_EMPLOYEE_ID`、成员凭据和 Operation 凭据；
- 最新 taiyi 部署（8781/8782/8783）三端 smoke：Operation `15 passed`、Manager `23 passed`、Agent `10 passed`，合计 `48 passed`；
- Manager audit/governance 截图基线已随当前页面导航/投影刷新；
- Agent prompt 真实 endpoint 返回 202，RAG deletion/reconcile 真实 upstream-id smoke 已通过。

期间修复了 Agent list envelope 与前端 `listGet` 契约不一致、OpenAPI 缺少 abort path、E2E 动态会话选择和外部部署截图数据不稳定问题；Agent prompt external smoke 需要显式 `E2E_AGENT_EMPLOYEE_ID`。
