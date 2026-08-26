# Hindsight Manager facade lease（P1.1）

## 边界

**架构修订（2026-08-26）**：一个 Manager 部署服务一个企业；Hindsight bank 按企业内 employee-private scope 派生，member 只参与当前请求/lease 鉴权，不参与 bank 身份。历史租约/银行迁移按部署 runbook 处理。

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
HINDSIGHT_URL=https://hindsight.example.com
HINDSIGHT_SERVICE_TOKEN=<manager-only-secret>
HINDSIGHT_FACADE_URL=/api/manager/hindsight
HINDSIGHT_LEASE_TTL_SECONDS=300
```

`HINDSIGHT_RECALL_PATH`、`HINDSIGHT_RETAIN_PATH`、`HINDSIGHT_DELETE_PATH` 仍只供
Manager 管理面 facade/client 使用。Agent 不设置 `AITEAM_HINDSIGHT_URL`、
`HINDSIGHT_API_TOKEN`、`HINDSIGHT_API_KEY` 或 `HINDSIGHT_API_KEY_REF`。

## Wire contract

`POST /api/manager/hindsight/runtime-config`（Manager JWT；body 只允许
`employee_id` 与可选 `rotate=true`）返回 `Cache-Control: no-store`：

```json
{
  "data": {
    "base_url": "/api/manager/hindsight",
    "bank_id": "aiteam-<sha256-prefix>",
    "token": "<opaque-lease-secret>",
    "lease_id": "<non-secret-handle>",
    "version": 1,
    "issued_at": "2026-08-21T00:00:00Z",
    "expires_at": "2026-08-21T00:05:00Z"
  }
}
```

`token` 只存在 Agent 进程内的 extension config 装配期间（配置文件仅保存一次性
`apiKeyRef`，不保存 token）；不得进入 snapshot、SQLite、Pi Session JSONL、SSE、日志
或 trace。`POST /api/manager/hindsight/leases/{lease_id}/revoke` 返回不含 secret 的
`lease_id/bank_id/version/status/revoked_at`。

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
