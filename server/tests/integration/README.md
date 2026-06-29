# Wave0 测试底座（P1-F1~F7）— reviewer / 本地复跑指南

后续三端 Service Integration 与 Browser E2E 的共享测试底座。fixtures 注册在
`tests/integration/conftest.py`（作用域覆盖整个 `tests/integration/` 树，sibling 子目录可直接消费）。

## 1. 目录

| 文件 | 节点 | 内容 |
|---|---|---|
| `fixtures/postgres.py` | P1-F1 | 真 PG + 迁移 + 隔离 tenant scope + RLS（`tenant_scope` / `tenant_scope_factory`） |
| `fixtures/identities.py` | P1-F2 | operator/manager-owner/member/agent/service-token/cross-tenant 身份；service token 不 fail-open |
| `fixtures/data_lifecycle.py` | P1-F3 | seed/cleanup（`seeded_enterprise`、`seed_full_enterprise`、`cleanup_test_scope`） |
| `fixtures/eventual.py` | P1-F4 | 统一等待窗口 30/60/120/300s（`wait_for_condition`） |
| `fixtures/diagnostics.py` | P1-F7 | 失败诊断脱敏（无 secret/会话/文件/工具 I/O） |
| `_foundation_consumers/` | — | sibling 可见性回归（证明 fixtures 在 `fixtures/` 之外可注入） |
| `../../../web/e2e/support/{artifacts,diagnostics}.ts` | P1-F5/F7 | Browser artifact 基线 + 端侧诊断脱敏 |

## 2. 起一个测试 PG（与 CI 同口径）

```bash
# 仓库根目录
docker compose -f server/tests/integration/docker-compose.test-pg.yml up -d
# 等待 healthy：
docker compose -f server/tests/integration/docker-compose.test-pg.yml ps
```

> 无 docker 时，任意 PostgreSQL 16 实例均可，只要库名 `manager_control_db`、超管可建角色。

## 3. 环境变量（两类连接，#60）

**直接 source 仓库里的脚本（推荐）**——它把口令按 shell 变量真实展开，**不要 copy-paste 本节里的 URL**，
因为很多文档/日志展示层会把 URL 的 `:口令@` 位（哪怕是 `${变量}`）遮成 `***`；source 真实文件不受影响：

```bash
# 仓库根目录；默认端口 5432（同 docker-compose.test-pg.yml）
source server/tests/integration/setup-test-env.sh
# 若本机 5432 被占用，换端口：
PG_PORT=5440 source server/tests/integration/setup-test-env.sh
```

脚本会 export `ADMIN_DB_URL` / `DB_URL` / `APP_RW_PASSWORD` / 运营端凭据，并打印**口令脱敏后**的
URL 供你核对已真实展开。口令/连接对照（一次性本地测试值，与 `docker-compose.test-pg.yml`、`ci.yml` 完全一致）：

| 连接 | 角色 | 口令 | 形态 |
|---|---|---|---|
| 管理连接 `ADMIN_DB_URL` | `postgres`（超管） | `postgres` | `postgresql://postgres:<口令>@localhost:5432/manager_control_db` |
| 业务连接 `DB_URL` | `app_rw`（受 RLS） | `apprwpass` | `postgresql://app_rw:<口令>@localhost:5432/manager_control_db` |

> 文档/日志里把 `<口令>` 显示成 `***` 属正常脱敏，**仅展示用**；真实值见上表第三列，或直接 source 脚本。

迁移在首次连接由 `apply_migrations(ADMIN_DB_URL, app_rw_password=APP_RW_PASSWORD)` 自动应用，无需手动建表。
**注意顺序**：`app_rw` 的 LOGIN 口令是迁移幂等下发的，所以 `DB_URL`（app_rw 身份）只有在
**第 4 步任一 integration 测试跑过一次后**才能直接连——首次连接由 fixture `migrated_pg` 触发下发。

## 4. 复跑 5 条契约（base = `feature/v1.0.0`）

```bash
cd server
pip install -r requirements.txt pytest        # 含 psycopg/pytest-cov/diff-cover
python -m pytest -q -m integration tests/integration/fixtures/test_postgres_fixture_contract.py
python -m pytest -q -m integration tests/integration/fixtures/test_identity_fixture_contract.py
python -m pytest -q -m integration tests/integration/fixtures/test_data_lifecycle_contract.py
python -m pytest -q tests/integration/fixtures/test_eventual_helper_contract.py
python -m pytest -q tests/integration/fixtures/test_diagnostics_fixture_contract.py
# sibling 可见性：
python -m pytest -q tests/integration/_foundation_consumers/
```

## 5. 改动分支覆盖门（≥90%）

```bash
cd server
python -m pytest -q \
  --cov=tests/integration/fixtures --cov=tests/integration/_foundation_consumers \
  --cov-branch --cov-report=xml:coverage.xml \
  tests/integration/fixtures/ tests/integration/_foundation_consumers/
cd ..
diff-cover server/coverage.xml --compare-branch=origin/feature/v1.0.0 --fail-under=90
```

> PG 缺失时 P1-F1/F3 与身份/sibling 的 DB 用例会 `skip`，diff-cover 会因 PG 路径未执行而**低于 90%**——
> 这是预期：本底座的 PG 真路径**必须**在真 PG 上复跑（CI integration job 即如此），diff-cover 也需在
> 有 PG 的环境取数。务必先完成第 2/3 步再跑覆盖门。

## 6. Browser 诊断脱敏自检（无需浏览器，node ≥ 22）

```bash
node web/e2e/support/__checks__/diagnostics-redaction.check.mjs
```
