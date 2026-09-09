# Hindsight Manager facade lease（P1.1）

## 边界

**当前架构（2026-09-07）**：一个 Manager 进程可服务多个企业会话；每个浏览器 session/JWT/request 由 TenantContext 固定一个 tenant。Hindsight bank 按 tenant 内 employee-private scope 派生，member 只参与当前请求/lease 鉴权，不参与 bank 身份。历史租约/银行迁移按部署 runbook 处理。

> 旧版本 member-private bank 不会被新 scope 自动读取。v1 全新部署不迁移旧会话/记忆；已有环境切换前必须先用 Hindsight 导出/重新 retain 完成一次性 bank migration，并在切换后验证 employee memory recall。

`@luxusai/pi-hindsight@0.12.0` 只支持把一个 API key 放进
`Authorization: Bearer ...`，当前 Hindsight API 没有真正的 bank-scoped token、租约或
revoke API。AI Team 因此**不伪造 native scoped token**：Manager 保留
`HINDSIGHT_SERVICE_TOKEN`，Agent 只拿 Manager 签发的短期 opaque lease，并通过
`/api/manager/hindsight/*` facade 访问。

facade 在每个请求校验 lease 的 tenant/member/employee/bank/expiry/revoke，再用 Manager
私有 service token 转发到固定 Hindsight upstream。Agent 不能直连 upstream，也不能把
`bank` 或 `bank_id` 作为模型工具参数；bank identity 只由 Manager 根据当前企业绑定的
`tenant_id`、employee 和已授权 memory policy 派生，member 仅用于请求/lease 鉴权。

## 配置

Manager：

```dotenv
# API 用于 facade/lease；Manager-only
HINDSIGHT_URL=https://hindsight.example.com:9290
HINDSIGHT_SERVICE_TOKEN=<manager-only-secret>
HINDSIGHT_FACADE_URL=/api/manager/hindsight
HINDSIGHT_LEASE_TTL_SECONDS=300
```

Hindsight Control Plane 原生 UI 使用独立的访问密钥；该变量只配置给 Hindsight
服务，不配置给 Manager 或 Agent：

```dotenv
HINDSIGHT_ENABLE_CP=true
HINDSIGHT_CP_ACCESS_KEY=<secret-store>
# UI 默认端口 9999；需要远程浏览器访问时，将 UI 绑定在受保护的 host:9999。
# Manager「记忆管理」页会打开当前 Manager host:9999/dashboard。
```

原生 UI 登录密钥不放入超链接、前端 bundle 或页面文案；管理员应从部署 secret
store 获取并在 Hindsight 登录页输入。

`HINDSIGHT_RECALL_PATH`、`HINDSIGHT_RETAIN_PATH`、`HINDSIGHT_DELETE_PATH` 仍只供
Manager 管理面 facade/client 使用。Agent 不设置 `AITEAM_HINDSIGHT_URL`、
`HINDSIGHT_API_TOKEN`、`HINDSIGHT_API_KEY` 或 `HINDSIGHT_API_KEY_REF`。

## Wire contract

`POST /api/manager/hindsight/runtime-config`（Manager JWT）接受：

```json
{
  "employee_id": "<authorized-employee-id>",
  "client_protocol": "aiteam-memory-v1",
  "rotate": false
}
```

`client_protocol` 是受控 Agent 的协商标识，不是用户认证、人工同意或权限提升凭据。
缺失或未知协议只获得当前策略交集中的 `recall` 只读 lease；如果当前策略只有
`retain`，Manager 返回 `409 hindsight_client_upgrade_required`，不会以旧请求重试写入。
返回 `Cache-Control: no-store`，当前 wire shape 为：

```json
{
  "data": {
    "base_url": "/api/manager/hindsight",
    "bank_id": "aiteam-<sha256-prefix>",
    "token": "<opaque-lease-secret>",
    "lease_id": "<non-secret-handle>",
    "version": 1,
    "issued_at": "2026-08-21T00:00:00Z",
    "expires_at": "2026-08-21T00:05:00Z",
    "allowed_operations": ["recall", "retain"],
    "policy_revision": 3,
    "client_protocol": "aiteam-memory-v1",
    "explicit_auto_retain": false,
    "retention_mode": "unlimited"
  }
}
```

`allowed_operations` 是精确 allowlist，只能包含 `recall` 和 `retain`；空列表拒绝记忆
操作。`policy_revision` 是当前 employee memory policy 的正向版本证据；retain lease
必须携带正版本且与当前策略一致。`explicit_auto_retain` 只有当前策略、快照和受支持
协议同时明确允许时才为 `true`。`retention_mode` 为 `unlimited` 或 `fact_only`；后者
只返回有可信来源的 world/experience facts，不代表 Hindsight 物理硬擦除。

`token` 只存在 Agent 进程内的 extension config 装配期间（配置文件仅保存一次性
`apiKeyRef`，不保存 token）；不得进入 snapshot、SQLite、Pi Session JSONL、SSE、日志
或 trace。`POST /api/manager/hindsight/leases/{lease_id}/revoke` 返回不含 secret 的
`lease_id/bank_id/version/status/revoked_at`。

### Facade operation allowlist

Agent 只能使用 Manager facade 的以下三条 upstream-compatible 路径，且 bank ID 必须
来自 Manager 返回的当前 lease：

| Lease operation | Method + facade path | 说明 |
|---|---|---|
| profile | `GET /api/manager/hindsight/v1/default/banks/{bank_id}/profile` | 仅用于 pinned extension 的最小初始化响应；不授予 bank 管理权 |
| recall | `POST /api/manager/hindsight/v1/default/banks/{bank_id}/memories/recall` | 读取当前允许的记忆；每次请求重新检查 member/employee/grant/policy |
| retain | `POST /api/manager/hindsight/v1/default/banks/{bank_id}/memories` | 仅在协议、正 policy revision 和 retain allowlist 同时满足时写入 |

PUT/PATCH/DELETE、bank/config/template/reflect/mental-model/list 管理路径、未知 query
或 body 字段、编码路径和超限 body 一律拒绝。`profile` 的成功响应由 Manager facade
生成，运行 lease 不需要 bank PUT。Manager 可信代码只在首次确认 profile 为 404 时
初始化 bank；不会在每次 Agent 请求中覆盖已有 bank 配置。

策略收紧或成员/员工撤权会立即使旧 lease 的对应操作失效；放宽必须重新协商 lease。
已跨过 Manager 最后一次写授权围栏的 native 异步请求可能已经被 Hindsight 接受，后续
403 不等于回滚，也不能用新 lease 盲目重放。Agent 对 401/403/升级错误不自动降级或
重试旧无协议请求；同一有效 lease 的普通瞬时网络失败才保留 pinned SDK 原有重试。
同一 snapshot/policy 的 active lease 可复用；`rotate=true`、snapshot/policy 变化或
revoke 后会递增 `version`。旧 lease 在 revoke/expiry 后由 facade 拒绝，新 Session 每次
从 Manager 拉取当前 lease。正常 shutdown/child disposal 仍先调用 Hindsight lifecycle
flush；队列失败保留在 Agent state 供后续重试。

Manager 将 lease metadata 与 token SHA-256 digest 持久化到业务库：明文 token 不入库。
业务写路径使用 app_rw + TenantContext；facade bearer digest lookup 使用受控管理读路径并
重新校验 tenant/member/employee/bank scope。Manager 重启后旧 digest 会按 expiry/revoke
状态继续生效；由于明文 token 不可重建，重启后的同 scope runtime-config 请求会安全轮换
新 token，旧 token 仍只按其持久化状态处理。

## 已知阻塞

这只是 Manager facade/lease seam，不等于 Hindsight 原生 bank credential。多进程
Manager 仍不具备 Hindsight upstream 的 native token/revoke 能力；数据库中的 lease revoke
只是 Manager facade authorization。若 Hindsight 提供原生 scoped token + revoke，应替换
facade 的 upstream auth 适配并保留 wire contract；在此之前禁止把 Manager service token
下发给 Agent。
