# CI 故障排查 (Troubleshooting)

Wave3 分层 CI 门禁的故障排查手册。看到某个 gate 红/失败时按本文件定位。
操作流程（artifact 获取、本地复现、升级路径）见同目录 `runbook.md`。

## 门禁总览

| Gate | Workflow / Job | 触发 | 阻断? | 目标 |
|------|----------------|------|-------|------|
| G1 PR Quick | `.github/workflows/pr-quick.yml` (`pr-quick`) | push / PR（`server/**`） | ✅ 阻断 PR | 5–10 分钟内阻断明显破坏（pr_quick 子集） |
| G2 Service Integration Full | `.github/workflows/ci.yml` (`integration`) | push / PR（`server/**`） | ✅ 阻断 PR | 三条闭环 service integration（真 PG + RLS） |
| G3 Browser E2E | `.github/workflows/web-ci.yml` (`playwright-smoke`) | push / PR（`web/**`） | ✅ 阻断 PR | 三端 + 跨端主链 chromium gate |
| G4 Nightly | `.github/workflows/nightly.yml` | cron 每日 / 手动 | ❌ 不阻断 PR | 多浏览器 / 大数据 / 性能 |
| G5 Pre-Deploy | `.github/workflows/pre-deploy.yml` | push → `feature/v1.0.0` / 手动 | ✅ 阻断部署 | staging smoke + production readonly smoke |
| G6 文档 | 本文件 + `runbook.md` | — | — | artifact 获取 / 本地复现 / 升级路径 |

> 原始 GitHub Actions logs 永远以仓库 Actions 页为准，本文件不替代 logs，只帮你快速定位。

> G2/G3 由前序 wave 的 `ci.yml` / `web-ci.yml` 承载；本卡（Wave3）新增 G1/G4/G5 + G6 文档，并把六层门禁收口为一张分层矩阵。

## G1/G2 共用：server 集成测试（真 PG + RLS）

G1（pr_quick 子集）与 G2（全量 integration）都跑 `server/` 下 `@pytest.mark.integration` 用例，依赖真 PostgreSQL + RLS。无 `DB_URL`/`ADMIN_DB_URL` 时整组 integration **skip**（不会 error），所以"全绿但没真跑"是常见假绿——务必确认 PG 真起来、用例真 ran。

- **PG service 起不来**：`services.postgres` health check 失败。库名必须为 `manager_control_db`（0001 迁移硬编码 `GRANT CONNECT ON DATABASE manager_control_db`，库不存在该 GRANT 会失败）。
- **`app_rw` 角色缺失/口令不符**：`APP_RW_PASSWORD` 由 `apply_migrations` 幂等下发；CI env 须为 `aprwpass`，`DB_URL` 须 `postgresql://app_rw:apprwpass@...`。
- **运营端 app 构建 ValueError**：`OPERATION_SYSTEM_USERNAME/PASSWORD` 缺失。CI env 须 `sysadmin` / `changeme-me`（`tests/operation/test_system_auth.py` 与入户链 e2e 硬编码此对凭据）。
- **迁移未应用**：首次业务连接自动 `apply_migrations`，无需手动建表；若报 `relation does not exist`，检查 `ADMIN_DB_URL` 是否指向超管连接。
- **G1 超预算（>10min）**：pr_quick 子集应 5–10 分钟。看是否混入非 pr_quick 用例（命令须带 `and pr_quick`）；`server/PR_QUICK_MANIFEST.md` 是子集清单的唯一口径。

## G3：web 浏览器 E2E（chromium）

`web-ci.yml:playwright-smoke` 跑 `pnpm e2e`，`web/playwright.config.ts` 的所有 project（harness / operation-smoke / manager-smoke / agent-smoke / cross-tier）均使用 chromium（Desktop Chrome），即 G3 chromium gate。G4 nightly 通过生成 `web/playwright.nightly.config.ts`，把同一组 project 切到 firefox/webkit 做多浏览器观察。

- **webServer 起不来**：配置拉起三端后端（`server/run.py --tier operation|manager|agent`）+ 三端前端 dev server。manager 需 `DB_URL/ADMIN_DB_URL`；agent 需 `MANAGER_URL`。看 `web/test-results/` 下 stderr。
- **`pnpm --filter @aiteam/shared run build` 失败**：消费端经 exports 解析 `@aiteam/shared/*` 到 `shared/dist`，typecheck/test/e2e 前必须先产出 shared dist。
- **globalSetup 失败**：seed E2E 租户 + 三端登录产出 storageState。看 globalSetup 日志，通常是 DB 不可达或运营端凭据错。
- **chromium 未装**：CI 跑 `pnpm exec playwright install --with-deps chromium`；本地同样。
- **`--project=chromium` 语义**：contract 的 `pnpm e2e --project=chromium` 是"chromium 浏览器 gate"的通用标签。本项目所有 e2e project 默认使用 chromium（`Desktop Chrome`），无独立 `chromium` project；等价命令为 `pnpm e2e`（详见 runbook §"G3 命令等价"）。

## G4：nightly 失败

- **不阻断 PR**：nightly 是独立 workflow，PR 不触发它；所有 job `continue-on-error: true`。
- **连续 3 天失败 → P0**：见 runbook §"G4 连续失败升级 P0"。
- **多浏览器某款挂**：`fail-fast: false`，单浏览器失败不拖垮整轮。看对应 `nightly-playwright-<browser>` artifact。本仓库使用 `.github/scripts/write-nightly-playwright-config.mjs <browser>` 生成 nightly 专用 config 后跑 `pnpm exec playwright test --config=playwright.nightly.config.ts`；不要改回 `pnpm e2e --browser=<browser>`，后者与已定义 projects 的 Playwright config 不兼容。
- **big-data / perf job 挂**：观察性 job，失败只影响趋势，不升级除非连续 3 天。

## G5：pre-deploy 失败

- **staging smoke 挂**：先跑 pr_quick 子集（真 PG），再探 `AITEAM_STAGING_URL` 的 `/healthz`、`/docs`。`AITEAM_STAGING_URL` 未配 → endpoint 探测跳过（仅跑 pr_quick）。
- **production readonly smoke 挂**：仅 `workflow_dispatch` 且 `target ∈ {production, both}` 才跑。只发 GET，不写。401/403 → production Environment 的凭据/URL 配置问题。
- **environment 卡审批**：`staging`/`production` Environment 的 required reviewers 没配 → 部署卡在等审批，不是失败。

## artifact 获取

见 `runbook.md` §"artifact 获取"。

## 仍定位不了

1. 拿到失败 run 的 workflow + job 名 + 失败 step 上下文（前后 50 行）。
2. 按 runbook §"本地复现" 在本地跑同一命令。
3. 仍复现不了 → 在 PR/issue 贴 run URL + 本地复现命令 + 差异，@ 负责 squad。
