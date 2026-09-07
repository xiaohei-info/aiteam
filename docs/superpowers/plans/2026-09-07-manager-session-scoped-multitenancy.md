# Manager 会话级单企业、多企业复用实施计划

- 日期：2026-09-07
- 状态：已获用户语义确认；实现前计划收口
- 基线：`origin/main`（Wave1 + 部署修复）；当前 taiyi TEST 在缺少有效登录配置时保持 fail-closed

## 1. 目标与边界

Manager 进程可以承载多个企业，但每个浏览器会话 / JWT / 请求只属于一个企业：

- 用户在 Manager 页面输入企业名称或代码、账号、密码；不输入 tenant UUID。
- Manager 先按企业代码/名称定位 tenant，再在该 tenant 内校验账号并签发带 `tenant_id` 的 JWT。
- 同一 JWT 不允许切换企业；退出后可以用同企业其他成员账号或另一企业账号重新登录。
- 每个请求从已验签 JWT 建立 `TenantContext`，所有租户业务 SQL 仍经 `SET LOCAL app.tenant_id` 和 RLS。
- F01/F02/F17 的 service call 使用已认证服务身份和请求 body 的 tenant；F01 可创建新 tenant，F02/F17 对未知 tenant fail-closed。
- 禁止从 Host、X-Forwarded-Host、body 中猜测当前服务企业；禁止 first/only `tenant_registry` fallback；禁止把 `MANAGER_TENANT_ID` 作为隐式 pin。
- `MANAGER_TENANT_ID` 若遗留在环境中只记录兼容告警并忽略；它不能进入 `Settings.manager_tenant_id`、verifier、AuthService、MFA/OAuth、intake、notification、retention 或任何 workspace 选择。`/readyz` 只检查本端 DB/schema。

## 2. 非目标

- 不在本计划实现 in-token tenant switcher。
- 不删除 JWT/RLS 的 tenant_id。
- 不处理 Wave2 的每企业 Manager deployment URL、签名 service identity、Operator trust registration；保留当前窄通信面，另行推进。
- 不恢复旧 `app/`、不修改 `.hermes/hermes-agent/`、不上传会话正文。
- 不把企业 A 的 LightRAG workspace 复制给企业 B；不进行历史正文迁移或猜测绑定。

## 3. 不可违反的不变量

1. **租户权威**：用户路由只信已验签 JWT `claims.tenant_id`；F01 由已认证服务身份提交格式合法的新 `body.tenant_id` 创建租户；F02/F17 由服务身份提交已存在的 `body.tenant_id`，并在 registry 存在性与服务 scope 下执行。业务 user body 的 tenant 只作与 JWT 一致性校验，不选择权限范围。绝不信 Host、`X-Forwarded-Host`、环境 UUID、第一行 registry。
2. **单请求单租户**：一个 request、一个 `TenantContext`、一个 RLS `SET LOCAL app.tenant_id`；活跃 token 不变更 tenant。
3. **登录唯一性**：企业代码优先精确匹配；名称/slug 必须收集全部匹配并在多行时返回明确冲突，不使用 `LIMIT 1` 猜测。账号可以跨企业重复；无企业且账号多租户时返回 `tenant_selection_required` 409，带企业后按该企业继续登录。
4. **RAG workspace**：优先读取当前 tenant 的持久化 `rag_workspace.workspace`，不存在则由 `derive_workspace(tenant_id, enterprise_shared)` 派生；HTTP `LIGHTRAG-WORKSPACE` 必须等于该值，不能使用静态 `registry.instances[0].workspace`，客户端不能提交 workspace。
5. **现有部署保护**：taiyi 当前已有 workspace 只归属于其实际企业；切换代码不更新旧 workspace，不把它写给新企业。
6. **后台隔离**：摄取恢复、retention、通知等按表内 tenant_id 分批 claim，在对应 TenantContext 下运行；空集合 no-op，不从 registry 猜租户。
7. **部署 readiness**：Manager 无 tenant 环境仍能启动并在本端 DB/schema 正常时 ready；遗留 `MANAGER_TENANT_ID` 不参与认证或 pin。

## 4. 分阶段实施顺序

### Stage A：取消全部进程 binding，完成会话级认证（A–E 未全部通过前不得打开第二 tenant F01）

修改：

- `server/manager_service/active_principal.py`：删除 `require_bound_tenant` 作为 process pin，删除 `ActivePrincipalVerifier.verify` 中 `require_binding` 和 deployment-tenant compare 分支；保留 JWT/active principal/claims 校验。
- `server/shared/config.py`：删除 `Settings.manager_tenant_id` 的业务字段；若兼容读取环境，只 warn-and-ignore，不写入 Settings/路由/服务。
- `server/shared/app_factory.py`：`/readyz` 只检查本端 DB/schema；无 `MANAGER_TENANT_ID` 仍可 ready。
- `server/manager_service/app.py`：verifier/AuthService/MFA/RAG 组装不传 process tenant；删除 `_manager_binding_ready` registry pin 和 `_initialize_enterprise_knowledge_spaces` 的 env tenant 要求。
- 同一阶段删除 F01/F02/F17、intake、notification、Hindsight、retention、MFA/OAuth 中所有 `settings.manager_tenant_id` / `deployment_tenant_id` 的 compare 或 missing-binding 分支；不得先保留旧 pin 再在 Stage D“打开”。A–E 完成后一次性发布多租户语义。
- `server/manager_service/auth_service.py`：删除 `_bound_tenant`/`require_binding` password/MFA pin；`resolve_tenant` 全量匹配并拒绝歧义；`resolve_tenant_by_account(account, enterprise=None)` 支持显式企业。
- `server/manager_service/routes_auth.py`：resolve/login/reset 采用企业标识协议；更新 schema/OpenAPI 422/404/409 示例。
- `server/manager_service/routes_mfa.py`、`server/manager_service/oauth_service.py`：删除所有 `require_bound_tenant(...settings.manager_tenant_id)`。公开 Passkey/OAuth 仍使用内部 tenant UUID handshake（Stage C 再改为企业标识）；受保护 MFA 使用 JWT TenantContext。禁止从 origin/body 推断可信 origin。
- 同阶段纳入并清除进程 pin 的文件：`server/manager_service/routes_tenant.py`、`routes_bootstrap.py`、`routes_in_app_notification.py`、`in_app_notification_service.py`、`routes_hindsight.py`、`hindsight_facade.py`、`knowledge_intake_service.py`、`routes_knowledge_intake.py`、`knowledge_intake_recovery.py`、`memory_retention_service.py`、`memory_retention_repository.py`。

要点：

- `ActivePrincipalVerifier` 不再 `require_binding=True`；仍检查 JWT 结构、签名、active principal、claims tenant。
- `AuthService` password login/reset/jwks/resolve 不再调用进程级 `_bound_tenant`；企业定位查询严格使用输入 enterprise，返回明确 tenant。
- `/readyz` 只检查 DB/schema，不检查 `MANAGER_TENANT_ID`。
- Stage A 的源码不能再保留进程 binding；第二 tenant 的 F01 在 Stage B/C/E 的 RAG、登录和后台隔离完成前不发布、不在 taiyi 执行。
- 公开 MFA/OAuth 的 tenant UUID 是内部兼容 handshake，Stage C 才改为企业标识；本阶段只移除进程 pin。禁止从 origin/body 推断可信 origin。

同步测试：

- `server/tests/manager/test_active_principal.py`
- `server/tests/manager/test_auth_routes.py`
- `server/tests/manager/test_auth_factors_pg.py`
- `server/tests/manager/test_routes_auth.py`
- `server/tests/shared/test_app_factory.py`
- `server/tests/app/test_tier_apps.py`
- `server/tests/manager/test_resolve_tenant.py`
- `server/tests/manager/test_resolve_tenant_by_account.py`
- `server/tests/manager/test_provision_bootstrap.py`
- `server/tests/manager/test_employee_bindings_e2e.py`
- `server/tests/manager/test_memory_policy_pg.py`
- `server/tests/manager/test_knowledge_policy_pg.py`
- 同企业第二账号登录、另一企业重新登录、未知企业、多企业同账号、Host/X-Forwarded-Host 不得选租户的 401/404/409 语义。

### Stage B：RAG/知识空间按 tenant 隔离（打开第二 F01 前置）

修改：

- `server/manager_service/rag.py`：`PgManagerRagService.__init__` 删除 `_enterprise_workspace = enterprise_workspace or instances[0].workspace` 强制覆盖；`get`/query workspace 只来自当前 tenant 的持久化 row/derive。
- `server/manager_service/rag_instances.py`：instance pool 只保存 URL/key，不以 workspace 作为进程身份。
- `server/manager_service/rag_mcp.py`：`LightRagSettings.from_env` 不保存 `first.workspace` 为 tenant 默认；`instance_for_workspace`、`query`/search header 必须使用传入 derived workspace；`get` 的本地存储路径也必须按 tenant。
- `server/manager_service/rag_ingestion.py`：`LightRagIngestionSettings.from_env` 不保存 `first.workspace` 为 tenant 默认；`instance_for_workspace`、`submit_text`、`ingest_text`、`reconcile_ingestion`、`delete_document`、`list_documents`、`resolve_document_ids`、`document_ids_present`、`_recovery_request`、`_paginated_documents` 的所有 header/请求 workspace 必须使用 derived workspace，不得回填 `instance.workspace`。
- `server/manager_service/routes_knowledge_space.py`：不得缓存 `registry.instances[0].workspace`。
- `server/manager_service/knowledge_space_service.py`：不得以 `_enterprise_workspace` 覆盖 derive。
- `server/manager_service/knowledge_space_repository.py`：删除/不再使用 `_enterprise_workspace`，tenant row 优先，否则 derive，不接受客户端 workspace。
- `server/manager_service/routes_knowledge_intake.py`：不得把 `registry.instances[0].workspace` 注入 service。
- `server/manager_service/knowledge_intake_service.py`：不再从 env 构造 `bound_tenant_id` gate；claim/job tenant 仍强制 TenantContext（进程 pin 的删除在 Stage A 完成）。
- `server/manager_service/knowledge_intake_repository.py`
- `server/manager_service/routes_tenant.py`：F01 用 body tenant 创建/确保自身 workspace，不使用 `instances[0]`。
- `server/manager_service/app.py`：删除 startup 固定 workspace/tenant 物化路径；`PgManagerRagService(... enterprise_workspace=_rag_settings.workspace)` 也必须删除，F01/首次明确 tenant 请求负责 ensure。
- `server/shared/db/__init__.py`（文档/派生 workspace 口径）

要点：

- 静态 instance pool 只保存 URL/key/健康信息，不把 workspace 当作进程身份。
- query、ingestion POST/track/delete 都使用当前 TenantContext 派生/持久化 workspace，并把该值放入 `LIGHTRAG-WORKSPACE`。
- 知识空间 service/repository 不缓存单一 enterprise workspace；F01/首次访问按 tenant 确保固定空间。
- startup 不扫描 registry 逐个假设空间；F01/显式 tenant 请求负责物化，恢复任务按 tenant 记录执行。
- 删除/重建/绑定动作不复活旧 deny/tombstone，不改已有企业 workspace。

测试：

- `server/tests/manager/test_rag_enterprise.py`：替换“两个 tenant 共用 enterprise-workspace”旧断言。
- `server/tests/manager/test_rag_instances.py`
- `server/tests/manager/test_rag_ingestion.py`
- `server/tests/manager/test_rag_mcp.py`
- `server/tests/manager/test_rag_workspace.py`
- `server/tests/manager/test_repo_rag.py`
- `server/tests/manager/test_routes_knowledge_space.py`
- `server/tests/manager/test_knowledge_space.py`
- `server/tests/manager/test_knowledge_space_e2e.py`
- `server/tests/manager/test_knowledge_intake_unit.py`
- `server/tests/manager/test_knowledge_intake_e2e.py`
- `server/tests/manager/test_knowledge_intake_recovery.py`
- `server/tests/manager/test_knowledge_intake_recovery_pg.py`
- `server/tests/manager/test_manager_analytics.py`
- 两 tenant workspace/header/RLS/ingest query isolation tests。
- 两 tenant：workspace 不同；A 的 ingest/query 在 B 不可见；HTTP header 不等于静态环境 workspace；并发/重启保持隔离。

### Stage C：Manager/Agent 登录企业选择

修改：

- `web/manager/src/pages/LoginPage.tsx`、`web/manager/src/pages/LoginPage.test.tsx`
- `web/manager/src/auth/session.ts`、`RequireAuth.tsx`、`factors.ts`、`factors.test.ts`、`passkey.ts`、`passkey.test.ts`
- `web/agent/src/pages/LoginPage.tsx`
- `web/agent/src/lib/api-client.ts`：resolve/login/reset 都带 enterprise；不要保留只传 account 或绕过企业选择的 `tenant_id` skip-resolve。
- `server/agent_service/src/http/server.ts`：resolve/login/reset request schema 带 enterprise，409 时返回可展示的企业选择错误；`AgentResetPasswordRequest` 不再只依赖 UUID。
- `server/agent_service/src/manager-client.ts`：`resolveTenantByAccount(account, enterprise?)`、login handoff、`ManagerOwnerResetInput` 都保持企业语义。
- `web/e2e/support/auth.ts`、`web/e2e/support/globalSetup.ts`、`web/e2e/support/__tests__/harness.test.ts`、`web/playwright.config.ts`
- `web/e2e/cross-tier/loop-a-enterprise-onboarding.spec.ts`
- `server/agent_service/src/http/employee-display.test.ts`、`server/agent_service/src/http/server.test.ts`、`web/agent/src/pages/LoginPage.test.tsx`、`web/agent/src/lib/api-client.test.ts`。
- `web/e2e/cross-tier/loop-a-enterprise-onboarding.spec.ts` 的 login/reset 两条真实企业链。

要点：

- Manager 和 Agent 页面都发送企业名称/代码 + account + password；客户端不展示 tenant UUID。
- `resolve-tenant-by-account` 在账号跨企业时返回需要企业选择的明确 409；带企业后继续正常登录。
- `localStorage` 只保存当前 session token/claims；登出清理并允许下一企业重新登录。
- 不能通过保留上次 enterprise/tenant 隐式切换。

### Stage D：F01/F02/F17 多 tenant service calls（与 Stage E 一起作为第二 tenant 开放门）

修改：

- `server/manager_service/routes_tenant.py`
- `server/manager_service/routes_bootstrap.py`
- `server/manager_service/routes_in_app_notification.py`
- `server/manager_service/in_app_notification_service.py`
- `server/manager_service/routes_grants.py`
- `server/manager_service/routes_usage_audit_quota.py`（`UsageSummaryUploadIn.tenant_id` 仅兼容字段，改为服务身份 target 约束）
- `server/shared/service_client.py`
- `server/shared/contracts/crosstier.py`
- 测试：`server/tests/manager/test_routes_tenant.py`、`test_routes_bootstrap.py`、`test_provision_bootstrap.py`、`test_routes_in_app_notification.py`、`server/tests/manager/test_routes_grants.py`、`test_routes_usage_audit_quota.py`，以及 `server/tests/integration/loops/loop_a_open_enterprise/test_provision.py`、`test_owner_login.py`、`test_negative.py`、`server/tests/integration/fixtures/manager_binding.py`、`server/tests/integration/fixtures/test_manager_binding.py`、`server/tests/integration/conftest.py`。
- `routes_billing.py` / `routes_audit_schemas.py` 无 body tenant，不把它们混进 body-tenant 契约。

语义：

- F01 接受格式合法的新 tenant UUID，幂等创建 registry/key/空间，不依赖进程绑定；service token 认证服务身份，body tenant 是 F01 的明确目标，不是用户 JWT 选择器。
- F02/F17 先确认 tenant registry 存在；未知返回 404，不返回 binding mismatch 503；body tenant 只在服务身份允许的 control-plane route 中生效。
- 用户业务请求的 tenant 必须与 JWT/TenantContext 一致；任何用户请求 body/path tenant 不一致统一 403（不混用 ignore 语义）。
- 当前 shared service token 仍是已配置的 control-plane 身份边界；更细的 per-deployment signed service scope 属 Wave2，不作为本阶段伪造完成，但不能让用户 JWT/Host/body 升级权限。
- 正向与负向测试使用两个独立 tenant，禁止 `bind_manager_app` 作为生产语义。
- 测试：`server/tests/manager/test_routes_tenant.py`、`test_routes_bootstrap.py`、`test_provision_bootstrap.py`、`test_routes_in_app_notification.py`，以及 `server/tests/integration/loops/loop_a_open_enterprise/test_provision.py`、`test_owner_login.py`、`test_negative.py`、`fixtures/manager_binding.py`、`fixtures/test_manager_binding.py`、`conftest.py`。

### Stage E：Hindsight、memory retention、intake recovery、通知后台任务（第二 tenant F01 的强制前置）

修改：

- `server/manager_service/hindsight_facade.py`、`server/manager_service/routes_hindsight.py`、`server/manager_service/hindsight_lease_repository.py`
- `server/manager_service/memory_retention_service.py`、`server/manager_service/memory_retention_repository.py`
- `server/manager_service/knowledge_intake_recovery.py`
- `server/manager_service/routes_in_app_notification.py`
- `server/manager_service/app.py`：`install_memory_retention_lifespan` / `install_knowledge_intake_lifespan` 不能按 env tenant no-op。
- app lifespan/startup maintenance assembly：验证 Stage A 已删除 `if not settings.manager_tenant_id: return` 单租户 no-op；枚举 due 表中的 tenant_id 并逐租户 claim。

要点：

- lease tenant 由 lease record + 当前授权 principal 共同决定，移除 env tenant gate；跨 tenant 的有效 lease 是 403，伪造/失效 lease 是 401。
- retention/recovery 逐租户 claim，维护失败不跨租户重试；没有 due rows 时 no-op。
- `server/tests/manager/test_hindsight_facade.py`
- `server/tests/manager/test_routes_hindsight.py`
- `server/tests/manager/test_hindsight_lease_repository.py`
- `server/tests/manager/test_hindsight_operation_policy.py`
- `server/tests/manager/test_hindsight_consent.py`
- `server/tests/manager/test_memory_retention_service.py`
- `server/tests/manager/test_memory_retention_native.py`
- `server/tests/manager/test_memory_retention_pg.py`
- `server/tests/manager/test_knowledge_intake_recovery.py`
- `server/tests/manager/test_knowledge_intake_recovery_pg.py`
- `server/tests/manager/test_routes_in_app_notification.py`
- 双 tenant lease/recovery/retention、empty-due no-op、跨 tenant 不可读取测试。
- 所有缓存按 tenant/member/employee/generation 隔离，重启不从进程 tenant 恢复。

### Stage F：文档、测试、部署恢复

更新：

- `docs/v1正式版本/技术设计/概要设计/00-架构总纲与裁决索引.md`
- `docs/v1正式版本/技术设计/概要设计/02-北向API与接口契约规范.md`
- `docs/v1正式版本/技术设计/概要设计/03-认证与身份设计.md`
- `docs/v1正式版本/技术设计/概要设计/04-数据架构与多租户隔离.md`
- `docs/v1正式版本/技术设计/概要设计/05-通信架构与跨端契约.md`
- `docs/v1正式版本/技术设计/概要设计/09-部署分发与入户绑定.md`
- `docs/v1正式版本/技术设计/概要设计/10-重建验证与阶段实施.md`
- `docs/v1正式版本/技术设计/概要设计/11-开发实施与并行编排.md`
- `AGENTS.md`、`CLAUDE.md` 中对应架构口径
- `server/manager_service/README.md`
- `server/tests/integration/README.md`
- `deploy/ci/README.md`
- `deploy/docker/README.md`
- `deploy/docker/docker-compose.yml`
- `.env.example`
- `.github/workflows/deploy-main.yml`
- `.github/workflows/web-ci.yml`
- `scripts/ctl.sh`
- `scripts/validate-lightrag-env.sh`
- `docs/部署运维/LightRAG-PostgreSQL-PGVector-部署运维Runbook.md`
- `docs/部署运维/2026-06-15-AI Team-当前单机部署SOP.md`

taiyi TEST 顺序：

1. 先以维护窗口停应用 writers，保留 PG/NewAPI 卷；
2. 部署代码/迁移，遗留 `MANAGER_TENANT_ID` 只告警不 pin；
3. `/readyz` 200 只证明 Manager DB/schema；
4. 先验证原企业 enterprise_code 登录及同企业另一账号；
5. Stage B/C/D/E 全部发布并验证后，再创建第二企业；
6. 验证两个 tenant 的签名 key、workspace、RLS，以及两个独立会话的登录/登出互不混淆；不得用 registry 第一行或 synthetic tenant。

## 5. 完成标准

- same-enterprise alternate account login succeeds。
- two enterprises can log in sequentially and concurrently in separate sessions。
- a token issued for A cannot access B path/body/resource; B token remains valid after A logout。
- Manager starts/readyz without `MANAGER_TENANT_ID` when local DB/schema is healthy。
- F01 creates A/B; F02/F17 target the correct existing tenant only。
- RAG workspace/header/storage and background jobs are tenant-isolated；no static workspace bleed。
- Server non-integration、real PostgreSQL/RLS、Agent/Web tests、OpenAPI、deployment static checks all pass。
- taiyi maintenance deployment confirms actual checkout SHA、health/ready/OpenAPI、old enterprise login and second-tenant session isolation。

## 6. 风险与回退

- 若任一 RAG/tenant isolation gate 未通过，不打开第二 tenant F01；保留服务 fail-closed。
- 代码回退不通过 registry 第一行恢复，不修改/删除现有 workspace 或记忆正文。
- 若 taiyi 依赖/配置失败，停止应用并记录非秘密错误；不得手工删除容器/卷或填 synthetic tenant。
