---
created: 2026-08-21
status: superseded-by-stage-b
scope: hindsight-production-lease
---

# Hindsight Manager Lease 持久化切片（历史）

> 2026-09-07 当前契约：Manager 按 JWT/TenantContext 服务多个 tenant；bank identity 为 tenant + employee（不含 member），member 仅用于当前请求/lease 鉴权。本文保留 lease 持久化、expiry/revoke、secret redaction 原则，旧 bank 派生文字不再作为实现依据。

## 目标

将当前 Manager 进程内 Hindsight opaque lease registry 升级为 PostgreSQL 持久化 registry，保证 Manager 重启后 lease 状态、expiry、revoke、rotation 可恢复；不存储明文 lease token，只存 hash。

## 约束

- 历史 bank 派生曾包含 member；当前由 Manager 从 tenant/employee 派生，Agent/模型不得传 bank_id，member 仅参与请求/lease 鉴权。
- raw lease token 只在签发响应和 Agent 进程内存在，不进 DB、snapshot、SQLite、Session、SSE、日志。
- Hindsight 0.12.0 没有 native scoped token；当前 lease 仍是 Manager facade authorization，不能宣称 upstream token revoke。
- Manager 业务连接使用 app_rw + TenantContext；lease token lookup 需要不依赖 caller tenant 的受控管理读路径，结果必须显式校验 tenant/member/employee/bank。
- 旧 taiyi test runtime-config/facade API 兼容，Manager restart 后已签发 lease 可按 expiry/revoke 语义恢复，而非无理由全部丢失。

## 实施

- 新增 migration：lease id/hash、tenant/member/employee、snapshot/policy fingerprint、bank_id、version、issued/expires/revoked、unique active scope。
- 将 HindsightLeaseStore 抽象为 memory/test 与 Pg store；PG store 只存 token SHA-256 hash，使用原子 rotation/revoke/upsert。
- runtime-config issue/reuse/rotate、facade resolve、revoke 走同一 repository；opaque token lookup 恒时比较 hash。
- 增加 startup cleanup/expiry query、cross-tenant/member negative tests、restart persistence test、secret redaction。

## 不做

- 不把 Hindsight service key 下发 Agent；
- 不修改 RAG/Skill/Provider；
- 不伪造 Hindsight upstream 的 token/revoke 能力；
- 不把 lease registry 放入 Agent SQLite。

## 验收

- Manager full tests、Agent tsc/tests 通过；
- same scope reuse、rotate invalidates old、revoke、expiry、restart persistence 通过；
- taiyi Manager restart 后新 Session 可拿到有效 lease，旧 lease 按 DB 状态处理；
- Hindsight retain smoke 仍通过。
