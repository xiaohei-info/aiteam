# Skill 签名密钥轮换 Runbook

## 目标

Skill 包只由 Manager 使用专用 Ed25519 私钥签名，Agent 只接收并缓存公开 `key_id`/公钥元数据。Skill 签名密钥不得复用 JWT 密钥，不得向 Agent、Compose Agent 容器或快照下发 private key/HMAC secret。

## 双 key overlap

1. 生成新的 Ed25519 PKCS8 DER 私钥，并把 base64 值写入 Manager secret store。
2. 保留当前配置，同时设置：

   ```dotenv
   AITEAM_SKILL_SIGNING_PRIVATE_KEY=<current base64 DER PKCS8>
   AITEAM_SKILL_SIGNING_KEY_ID=skills-2026-current
   AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY=<next base64 DER PKCS8>
   AITEAM_SKILL_SIGNING_NEXT_KEY_ID=skills-2026-next
   ```

3. 重启/滚动 Manager。Manager 的 authorized-config 与 snapshot 响应会发布 current + next 的 `public_key`、`key_id`、`algorithm=Ed25519` 及生命周期元数据；Manager 仍只使用 current 签名。
4. Agent 收到响应后按 envelope 的 `key_id` 选择公钥，先验证签名再写入本地 projection/skill cache。双 key overlap 期间旧包和新包均可按对应 key 验证。

## 撤销与过期

- 设置 `AITEAM_SKILL_SIGNING_REVOKED_KEY_IDS=skills-2025-old`，或通过 `AITEAM_SKILL_SIGNING_REVOKED_KEYS_JSON` 提供带 `status=revoked`、`revoked_at` 的公开 metadata。
- 设置 `AITEAM_SKILL_SIGNING_CURRENT_EXPIRES_AT` / `AITEAM_SKILL_SIGNING_NEXT_EXPIRES_AT`（RFC3339）进行过期控制。
- Agent 在线同步到新的 key set 后会替换 tenant/member scoped key cache；已撤销/过期 key 的缓存包重新验证失败，不能继续执行。未知 `key_id`、篡改包、tenant/member 不匹配均 fail closed。

## Manager 离线策略

Agent 本地 key cache 默认只允许离线重验证 24 小时，可通过 `AITEAM_SKILL_SIGNING_OFFLINE_TTL_SECONDS` 调整（不超过 365 天）。离线期间仍强制检查 key 的 `not_before`、`expires_at` 和 `revoked` 状态；超过 TTL、缺少 key metadata 或验签失败时不加载缓存 Skill。重新连上 Manager 后必须 pull 新 key set，不能靠离线缓存绕过撤销。

## 部署检查

```bash
bash scripts/check-deploy.sh
python -m pytest server/tests/manager/test_skill_signing.py -q
pnpm --dir server/agent_service exec tsc --noEmit
```

静态检查应确认：Agent service environment 仅有 `AITEAM_SKILL_SIGNING_PUBLIC_KEYS`/legacy public key，绝不出现 `AITEAM_SKILL_SIGNING_PRIVATE_KEY` 或 `AITEAM_SKILL_SIGNING_NEXT_PRIVATE_KEY` 的实际注入；仓库中不提交 DER/PEM private key。
