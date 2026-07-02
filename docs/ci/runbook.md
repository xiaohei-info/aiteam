# CI Runbook

Wave3 分层 CI 门禁的操作手册：artifact 获取、本地复现、升级路径、各 gate 覆盖范围与命令等价。
故障定位（症状→原因）见同目录 `troubleshooting.md`。

## 仓库路径与门禁映射

v1 三端微服务代码在 `server/`（后端）+ `web/`（前端）。`app/` 是冻结的 MVP 单体，**不在 v1 CI 范围**（旧单体有自己的测试，由 `app/` 自行维护）。

| Gate | 承载 | 验证命令 | 工作目录 |
|------|------|----------|----------|
| ~~G1 PR Quick~~ | **已裁撤**（2026-07-02 CI 精简：full integration 仅 ~1.5min，快子集无独立价值；`pr_quick` marker 保留供本地快速自检） | `pytest -q -m "integration and pr_quick"`（仅本地） | `server/` |
| G2 Service Integration Full | `ci.yml:integration`（前序 wave） | `pytest -v -m integration` | `server/` |
| G3 Browser E2E | `web-ci.yml:playwright-smoke`（前序 wave） | `pnpm e2e`（= chromium gate） | `web/` |
| ~~G4 Nightly~~ | **已删除**（2026-07-02 CI 精简：多浏览器/大数据/性能观察当前阶段完全不需要，连手动触发入口也不留；需要时 git revert 恢复） | — | — |
| ~~G5 Pre-Deploy~~ | **已裁撤**（2026-07-02：staging smoke 与 G2 完全重复、production URL vars 从未配置；部署职责由 `deploy-feature-v1.0.0.yml`（merge 后自部署 + /healthz 冒烟）承接。将来有独立 staging 环境再恢复） | — | — |
| G6 文档 | `docs/ci/{troubleshooting,runbook}.md`（Wave3 新增） | `test -f docs/ci/troubleshooting.md && test -f docs/ci/runbook.md` | 仓库根 |

集成分支：`feature/v1.0.0`。PR base 必须指向它（或 `master` 终态），不要打到无关分支。

## 各 gate 验证命令（与 contract.verification_commands 对齐）

```bash
# （原 G1 已裁撤；pr_quick marker 仅供本地快速自检）
cd server && pytest -q -m "integration and pr_quick"

# G2 Service Integration Full（真 PG + RLS）
cd server && pytest -v -m integration

# G3 Browser E2E（chromium gate）
cd web && pnpm e2e

# G6 文档存在性
test -f docs/ci/troubleshooting.md && test -f docs/ci/runbook.md
```

### G3 命令等价

contract 的 `pnpm e2e --project=chromium` 是"chromium 浏览器 gate"的通用标签。`web/playwright.config.ts` 的所有 e2e project（harness / operation-smoke / manager-smoke / agent-smoke / cross-tier）默认使用 chromium（Desktop Chrome），不存在名为 `chromium` 的 project。因此：

- 实际 gate 命令 = `pnpm e2e`（跑全部 chromium smoke project）。
- `pnpm e2e --project=chromium` 在本仓库会因无同名 project 而选 0 用例；**不要直接用**。要限定单端，用 `--project=operation-smoke|manager-smoke|agent-smoke|cross-tier`。
- 多浏览器（firefox/webkit）是 G4 nightly 职责，经 `.github/scripts/write-nightly-playwright-config.mjs <browser>` 生成 `web/playwright.nightly.config.ts` 后执行 `pnpm exec playwright test --config=playwright.nightly.config.ts` 覆盖（见下）。不要使用 `--browser=<browser>`；Playwright 在配置文件已定义 projects 时会拒绝该参数。

## artifact 获取

GitHub Actions 产物在 run 页 "Artifacts" 区下载，或用 `gh`：

```bash
gh run download <run-id> --repo xiaohei-info/aiteam --dir ./artifacts
```

| artifact | 产出门 | 用途 |
|----------|--------|------|
| `playwright-report` / `nightly-playwright-<browser>` | G3 / G4 | Playwright HTML 报告（trace/screenshot/video） |
| `playwright-test-results` | G3 | 失败用例的 trace / screenshot / video |
| `coverage.xml`（server）/ lcov（web） | G2 / ci.yml / web-ci.yml | diff-cover 改动分支覆盖门（≥90%）的口径源 |

> artifacts 不替代 GitHub Actions 原始 logs；定位时两者结合。

## 本地复现

### 前置：真 PostgreSQL（G1/G2 必需）

```bash
docker run -d --name aiteam-pg -p 5432:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=manager_control_db postgres:16

# 对齐 ci.yml env（app_rw 口令由迁移用 APP_RW_PASSWORD 下发）
export ADMIN_DB_URL=postgresql://postgres:postgres@localhost:5432/manager_control_db
export DB_URL=postgresql://app_rw:apprwpass@localhost:5432/manager_control_db
export APP_RW_PASSWORD=aprwpass
export OPERATION_SYSTEM_USERNAME=sysadmin
export OPERATION_SYSTEM_PASSWORD=changeme-me
```

server 依赖：`cd server && pip install -r requirements.txt pytest pytest-timeout`。

### G1
```bash
cd server && pytest -q -m "integration and pr_quick" --timeout=300
```

### G2
```bash
cd server && pytest -v -m integration --timeout=600
# 改动分支覆盖门（本卡 diff）：
pip install diff-cover pytest-cov
pytest --cov=operation_service --cov=manager_service --cov=agent_service --cov=agent_gateway --cov=shared \
       --cov-branch --cov-report=xml
diff-cover coverage.xml --compare-branch=feature/v1.0.0 --fail-under=90
```

### G3
```bash
cd web
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @aiteam/shared run build
pnpm exec playwright install --with-deps chromium
pnpm e2e                 # chromium gate（全部 smoke project）
# 限定单端：pnpm e2e --project=agent-smoke
```
> 本地跑 G3 需同时具备：真 PG（manager 后端）+ 三端后端可启 + 三端前端 dev server。`web/playwright.config.ts` 的 webServer 会自动拉起它们，前提是 `server/requirements.txt` 已装到仓库根 `.venv/`（`python -m venv .venv && .venv/bin/pip install -r server/requirements.txt`）。

### G4（本地手跑多浏览器）
```bash
cd web
pnpm exec playwright install              # 装全部浏览器
node ../.github/scripts/write-nightly-playwright-config.mjs chromium && pnpm exec playwright test --config=playwright.nightly.config.ts
node ../.github/scripts/write-nightly-playwright-config.mjs firefox && pnpm exec playwright test --config=playwright.nightly.config.ts
node ../.github/scripts/write-nightly-playwright-config.mjs webkit && pnpm exec playwright test --config=playwright.nightly.config.ts
```
big-data：`cd server && AITEAM_NIGHTLY_BIG_DATA=1 pytest -q -m integration --timeout=600`。

### G5
```bash
# staging smoke（pr_quick 子集 + endpoint 探测）
cd server && pytest -q -m "integration and pr_quick" --timeout=300
AITEAM_STAGING_URL=https://staging.example python3 - <<'PY'
import os,urllib.request
base=os.environ["AITEAM_STAGING_URL"].rstrip("/")
for p in ("/healthz","/docs"):
    assert urllib.request.urlopen(base+p,timeout=10).status==200
print("ok")
PY
# production readonly smoke（GET-only，绝不写）
AITEAM_PRODUCTION_URL=https://prod.example python3 - <<'PY'
import os,urllib.request
base=os.environ["AITEAM_PRODUCTION_URL"].rstrip("/")
for p in ("/healthz","/docs"):
    req=urllib.request.Request(base+p,method="GET")
    assert urllib.request.urlopen(req,timeout=10).status==200
print("ok")
PY
```

## 升级路径

### G4 连续失败升级 P0
- nightly 所有 job `continue-on-error: true`，单次失败不阻断 PR。
- **连续 3 个 nightly run 失败 → 升级 P0**：在 Multica 建阻塞 issue（或更新当前卡 `blocked_reason`），指派负责 squad，阻断下一次 `feature/v1.0.0` 合并直到修绿。
- 判定依据：nightly workflow 历史连续 3 次 🔴。`gh run list --workflow=nightly.yml --repo xiaohei-info/aiteam -L 5`。
- 升级后，把对应 nightly job 暂时镜像进 PR gate（临时降级为阻断）直到修复，修绿后移除——避免 nightly-only 长期变成 PR-quick 阻断（违反 non-goal）。

### G5 部署阻断
- staging smoke 失败 → 不进 production。先修 staging。
- production readonly smoke 失败 → 部署回滚 / 不上线。readonly smoke 只读，失败通常意味着 `/healthz`、`/docs` 退化或环境凭据缺失。

### 门禁阈值调整
- 改动分支覆盖阈值（缺省 90%）经 manifest `gate` 覆盖时须在 gate 文本写明理由。
- 调整 `server/pytest.ini` 的 marker / `testpaths`、或 `web/playwright.config.ts` 的 project，须同步更新 `troubleshooting.md` 与本 runbook。

## G2 覆盖（三条闭环）

- G2 跑 `pytest -v -m integration`，覆盖所有 `@pytest.mark.integration` 用例。
- 三条闭环对应 `server/tests/integration/loops/`：
  - Loop A 企业开通：`loop_a_open_enterprise/`
  - Loop B 授权同步：`loop_b_authorization/`
  - Loop C usage/audit/quota：`loops/loop_c_usage_audit/`（经 `server/pytest.ini` 的 `testpaths = tests loops` 纳入采集）
- pr_quick 子集（G1）从这三条闭环各取 release-blocking 主断言 + cross_tier 负向矩阵，清单见 `server/PR_QUICK_MANIFEST.md`（唯一口径）。
- 无 `DB_URL`/`ADMIN_DB_URL` 时整组 integration **skip**——本地复现务必先起 PG，否则看到的是"0 ran / 全 skip"的假绿。

## 不在生产写入数据

G5 production readonly smoke 只发 GET（`/healthz`、`/docs`）。任何往 production 发写请求（POST/PUT/PATCH/DELETE）的 smoke 都是违反 non-goal 的 bug。
