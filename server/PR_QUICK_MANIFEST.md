# PR Quick 子集清单（CI G1 输入）

本文档定义 PR quick marker 覆盖的 release-blocking 最小测试集合，作为 CI G1 gate 的输入。

## 验收口径

来自 AITEAM-211 Phase5 最终执行 DAG 与 AITEAM-225 验收条目：

- ✅ PR quick 覆盖闭环 A create/bootstrap/whoami 正负例
- ✅ PR quick 覆盖闭环 B grant 裁剪、snapshot 冻结、403 negative
- ✅ PR quick 覆盖闭环 C outbox + 脱敏摘要主断言、quota soft
- ✅ PR quick 覆盖 API problem+json、非 SPA fallback、cross-tenant、service-token 负例
- ✅ 不包含 nightly-only 大数据/多浏览器/300s rollup

## 运行命令

```bash
# 在 server/ 目录下
pytest -q -m "integration and pr_quick"
```

> **采集口径说明**：`server/pytest.ini` 的 `testpaths = tests loops`，因此 `pytest` 默认会同时收集 `server/tests/` 与 `server/loops/`。Loop C 测试实际位于 `loops/loop_c_usage_audit/`（不在 `tests/` 下），由 `testpaths` 显式纳入采集范围——单跑 `pytest -m "integration and pr_quick"`（不带路径参数）即可覆盖 Loop C 全部 3 项，无需额外 `-p` 或显式路径。

## 覆盖矩阵

### 闭环 A：企业开通 (Loop A - Enterprise Onboarding)

| 测试用例 | 路径 | 验收覆盖 |
|---------|------|---------|
| `test_tenant_provision_creates_tenant_registry` | `tests/integration/loops/loop_a_open_enterprise/test_provision.py` | F01 create tenant 正例 |
| `test_owner_bootstrap_creates_identity` | `tests/integration/loops/loop_a_open_enterprise/test_provision.py` | F02 bootstrap owner 正例 |
| `test_owner_whoami_after_login` | `tests/integration/loops/loop_a_open_enterprise/test_owner_login.py` | whoami 返回正确 tenant_id |
| `test_manager_whoami_without_auth_returns_401` | `tests/integration/loops/loop_a_open_enterprise/test_owner_login.py` | whoami 未认证 401 负例 |
| `test_bootstrap_to_nonexistent_tenant_rejected` | `tests/integration/loops/loop_a_open_enterprise/test_negative.py` | bootstrap 不存在 tenant 404 负例 |

### 闭环 B：授权同步 (Loop B - Authorization Sync)

| 测试用例 | 路径 | 验收覆盖 |
|---------|------|---------|
| `test_manager_config_owner_create_employee_and_grant_to_member_then_pull_authorized` | `tests/integration/loops/loop_b_authorization/test_manager_config.py` | Manager 配置链 + grant 裁剪正例 |
| `test_agent_sync_freeze_snapshot_via_manager_http_then_local_loadable` | `tests/integration/loops/loop_b_authorization/test_agent_sync.py` | F11 snapshot 冻结 + 离线装载 |
| `test_negative_snapshot_unauthorized_member_403_and_audit_recorded` | `tests/integration/loops/loop_b_authorization/test_negative.py` | 未授权拉 snapshot 403 + F16 审计 |

### 闭环 C：Usage/Audit/Quota Rollup (Loop C)

| 测试用例 | 路径 | 验收覆盖 |
|---------|------|---------|
| `test_outbox_flush_delivers_usage_summary_to_manager` | `loops/loop_c_usage_audit/test_outbox_to_manager.py` | outbox → Manager 正例 |
| `test_manager_ingested_usage_has_no_conversation_content` | `loops/loop_c_usage_audit/test_outbox_to_manager.py` | D13 脱敏摘要主断言（无会话内容） |
| `test_quota_soft_default_does_not_block_run` | `loops/loop_c_usage_audit/test_usage_audit_negative.py` | D24 软配额不阻断本地 run |

### API/Security 负向矩阵 (Cross-Tier)

| 测试用例 | 路径 | 验收覆盖 |
|---------|------|---------|
| `test_api_404_returns_problem_json_not_spa_html` | `tests/integration/cross_tier/test_api_envelope_problem_json_live.py` | /api/* 404 返回 problem+json（非 SPA fallback） |
| `test_manager_whoami_accepts_valid_cross_tenant_token_but_token_has_different_tenant` | `tests/integration/cross_tier/test_cross_tenant_negative_suite.py` | 跨租户 token 验签通过但数据隔离 |
| `test_service_token_guard_missing_returns_401` | `tests/integration/cross_tier/test_service_token_negative_suite.py` | service-token 缺失 401 fail-closed |

## 统计

- **总计**：14 个测试函数（覆盖 A/B/C + API/security 四组）
- **Loop A**：5 个测试（provision 正负例 + login/whoami 正负例）
- **Loop B**：3 个测试（config/grant + snapshot + 403 negative）
- **Loop C**：3 个测试（outbox + 脱敏 + quota soft）
- **API/Security**：3 个测试（problem+json + cross-tenant + service-token）

## 预算验证

目标：5-10 分钟（带真实 PG + 真实三端服务 + 真实 service-token transport）

**排除项**（归入 nightly/merge-full）：
- 300s 等待窗口测试（eventual fixture 的 300s 上限仅用于 nightly 长链路）
- 多浏览器矩阵（browser e2e 的 webkit/firefox 变体）
- 大数据 rollup（operator 跨企业聚合的批量场景）
- 全量回归（merge full 运行全部 integration 测试）

## 路径差异说明

Loop C 测试位于 `server/loops/loop_c_usage_audit/`（不在 `tests/integration/` 下），这是实际仓库路径与计划路径的已知差异（issue body 已说明"若实际路径不同，保留等价路径并映射"）。

路径映射：
- 计划路径（issue body）：`tests/integration/loops/loop_c_*`
- 实际路径（仓库）：`loops/loop_c_usage_audit/`
- 等价性：两者均为 Loop C 服务集成测试，同样使用 `@pytest.mark.integration` 与 Wave0 共享 fixtures
- **采集保证**：`pytest.ini` 已将 `loops` 纳入 `testpaths = tests loops`，默认 `pytest` 即采集 Loop C，无需 CI 命令额外指定路径

## 复跑证据（真实 PG + 完整依赖环境）

```text
# 采集（证明 nodeid 清单含 Loop C 三项）
$ pytest --collect-only -q -m "integration and pr_quick"
loops/loop_c_usage_audit/test_outbox_to_manager.py::test_outbox_flush_delivers_usage_summary_to_manager
loops/loop_c_usage_audit/test_outbox_to_manager.py::test_manager_ingested_usage_has_no_conversation_content
loops/loop_c_usage_audit/test_usage_audit_negative.py::test_quota_soft_default_does_not_block_run
tests/integration/cross_tier/test_api_envelope_problem_json_live.py::test_api_404_returns_problem_json_not_spa_html
tests/integration/cross_tier/test_cross_tenant_negative_suite.py::test_manager_whoami_accepts_valid_cross_tenant_token_but_token_has_different_tenant
tests/integration/cross_tier/test_service_token_negative_suite.py::test_service_token_guard_missing_returns_401
tests/integration/loops/loop_a_open_enterprise/test_negative.py::test_bootstrap_to_nonexistent_tenant_rejected
tests/integration/loops/loop_a_open_enterprise/test_owner_login.py::test_manager_whoami_without_auth_returns_401
tests/integration/loops/loop_a_open_enterprise/test_owner_login.py::test_owner_whoami_after_login
tests/integration/loops/loop_a_open_enterprise/test_provision.py::test_owner_bootstrap_creates_identity
tests/integration/loops/loop_a_open_enterprise/test_provision.py::test_tenant_provision_creates_tenant_registry
tests/integration/loops/loop_b_authorization/test_agent_sync.py::test_agent_sync_freeze_snapshot_via_manager_http_then_local_loadable
tests/integration/loops/loop_b_authorization/test_manager_config.py::test_manager_config_owner_create_employee_and_grant_to_member_then_pull_authorized
tests/integration/loops/loop_b_authorization/test_negative.py::test_negative_snapshot_unauthorized_member_403_and_audit_recorded
14 collected

# 运行（真实 PG，带真 service-token transport）
$ pytest -q -m "integration and pr_quick"
14 passed in ~13s
```

预算：13–14 秒（远低于 5-10 分钟上限），含真实 PG + RLS + 三端 TestClient + service-token transport。

## 后续扩展

本清单是 **release-blocking 最小集合**，不替代：
- `merge full`：全量 integration 测试（覆盖所有闭环的全部测试）
- `nightly`：长运行链路、多浏览器矩阵、跨企业批量聚合
- `pre-deploy`：生产预演环境的冒烟测试

CI 分层闸门设计见 AITEAM-211 Phase5 DAG §5.3。
