# Shared Crypto Module - Production Key Management

生产级密钥管理和凭据加密模块，用于 AI Team v1 架构。

## 核心原则

遵循 v1 概要设计 §3.6（多租户认证）和 D18（禁止明文密钥）：

- ✅ 不在源代码中硬编码密钥
- ✅ 从环境变量或密钥管理服务加载密钥
- ✅ 支持密钥轮换和版本管理
- ✅ 使用 Fernet 对称加密保护 provider 凭据
- ✅ 明确区分加密密钥和签名密钥

## 快速开始

### 1. 生成密钥

```bash
python -m server.shared.crypto.rotation generate
```

输出：
```
Generated new Fernet encryption key:

export AITEAM_ENCRYPTION_KEY='dGVzdC1rZXktZm9yLWRlbW8tZG9udC11c2UtaW4tcHJvZHVjdGlvbg=='

Store this key securely. It cannot be recovered if lost.
```

### 2. 配置密钥

**简单模式**（单个密钥，适合开发环境）：

```bash
export AITEAM_ENCRYPTION_KEY='dGVzdC1rZXk...'
```

**生产模式**（多版本密钥，支持轮换）：

```bash
export AITEAM_ENCRYPTION_KEYS='{"1":"old-key==","2":"new-key=="}'
export AITEAM_ENCRYPTION_KEY_VERSION=2
```

### 3. 使用加密

```python
from server.shared.crypto import KeyManager, CredentialEncryptor

# 初始化
key_manager = KeyManager()
encryptor = CredentialEncryptor(key_manager)

# 加密凭据
api_key = "sk-1234567890abcdef"
encrypted = encryptor.encrypt(api_key)
# 结果: "v2:gAAAAABh..."

# 解密凭据（自动使用正确的密钥版本）
decrypted = encryptor.decrypt(encrypted)
# 结果: "sk-1234567890abcdef"
```

## 模块组成

### KeyManager

密钥管理器，负责加载和管理多版本加密密钥。

**主要功能**：
- 从环境变量加载密钥
- 管理多个密钥版本
- 支持密钥轮换
- 生成新密钥

**示例**：

```python
from server.shared.crypto import KeyManager

# 初始化（自动从环境变量加载）
km = KeyManager()

# 查看当前配置
print(f"Primary version: {km.get_primary_version()}")
print(f"Available versions: {km.list_versions()}")

# 添加新密钥版本（用于轮换）
new_key = KeyManager.generate_key().encode('utf-8')
km.add_key_version(3, new_key)

# 提升新版本为主密钥
km.promote_version(3)
```

### CredentialEncryptor

凭据加密器，负责加密和解密 provider 凭据。

**加密格式**：
```
v{version}:{base64_ciphertext}

示例:
v1:gAAAAABh...  (使用密钥版本 1 加密)
v2:gAAAAABi...  (使用密钥版本 2 加密)
```

**示例**：

```python
from server.shared.crypto import KeyManager, CredentialEncryptor

km = KeyManager()
encryptor = CredentialEncryptor(km)

# 加密新凭据
encrypted = encryptor.encrypt("my-secret-key")

# 解密凭据（自动识别版本）
plaintext = encryptor.decrypt(encrypted)

# 检查是否需要轮换
if encryptor.needs_rotation(encrypted):
    # 使用当前主密钥重新加密
    new_encrypted = encryptor.re_encrypt(encrypted)
```

## 密钥轮换

### 零停机轮换流程

1. **准备阶段**：生成新密钥
   ```bash
   python -m server.shared.crypto.rotation generate
   ```

2. **部署阶段**：添加新密钥到环境变量
   ```bash
   # 原有配置
   export AITEAM_ENCRYPTION_KEYS='{"1":"old-key=="}'
   export AITEAM_ENCRYPTION_KEY_VERSION=1

   # 添加新密钥（保留旧密钥）
   export AITEAM_ENCRYPTION_KEYS='{"1":"old-key==","2":"new-key=="}'
   export AITEAM_ENCRYPTION_KEY_VERSION=2
   ```

3. **迁移阶段**：重新加密所有凭据
   ```python
   from server.shared.crypto import KeyManager, CredentialEncryptor
   from server.shared.crypto.rotation import KeyRotationService

   km = KeyManager()
   service = KeyRotationService(km)

   # 检查轮换状态
   status = service.check_rotation_status(all_encrypted_credentials)
   print(f"需要轮换的凭据数: {status['needs_rotation']}")

   # 执行轮换
   result = service.rotate_credentials(all_encrypted_credentials)
   print(f"已轮换: {result['rotated']}")
   print(f"失败: {result['failed']}")
   ```

4. **观察期**：保持旧密钥 30 天
   - 监控解密失败率
   - 确保所有凭据已迁移

5. **清理阶段**：移除旧密钥
   ```bash
   export AITEAM_ENCRYPTION_KEYS='{"2":"new-key=="}'
   export AITEAM_ENCRYPTION_KEY_VERSION=2
   ```

### 轮换计划生成

```python
from server.shared.crypto.rotation import KeyRotationService

service = KeyRotationService(key_manager)
plan = service.plan_rotation(
    current_primary=1,
    new_primary=2,
    grace_period_days=30
)

print(json.dumps(plan, indent=2))
```

输出：
```json
{
  "current_state": {
    "primary_version": 1,
    "available_versions": [1, 2]
  },
  "target_state": {
    "primary_version": 2
  },
  "timeline": {
    "preparation": "2026-06-22T10:00:00",
    "cutover": "2026-06-23T10:00:00",
    "deprecation": "2026-07-23T10:00:00"
  },
  "steps": [
    {
      "phase": "preparation",
      "action": "Generate and deploy new key version 2",
      "deadline": "2026-06-22T10:00:00"
    },
    {
      "phase": "cutover",
      "action": "Promote version 2 to primary",
      "deadline": "2026-06-23T10:00:00"
    },
    ...
  ]
}
```

## 数据库集成

### Manager Service 中使用

在 Manager Service 中加密存储 enterprise_connector 的凭据：

```python
from server.shared.crypto import KeyManager, CredentialEncryptor

class ConnectorService:
    def __init__(self):
        self._key_manager = KeyManager()
        self._encryptor = CredentialEncryptor(self._key_manager)

    def create_connector(self, enterprise_id: str, provider_code: str, api_key: str):
        # 加密 API key
        encrypted_key = self._encryptor.encrypt(api_key)

        # 存储到数据库
        connector = EnterpriseConnector(
            enterprise_id=enterprise_id,
            provider_code=provider_code,
            credential_ref=encrypted_key,  # 存储加密后的凭据
            credential_mask="sk-***abc",   # 显示用的掩码
            credential_state="configured",
        )
        repo.create(connector)

    def get_decrypted_credential(self, connector_id: str) -> str:
        connector = repo.get_by_id(connector_id)

        # 解密凭据
        return self._encryptor.decrypt(connector.credential_ref)
```

### 数据库迁移

在密钥轮换时批量更新数据库中的加密凭据：

```python
import psycopg2
from server.shared.crypto import KeyManager, CredentialEncryptor

def migrate_encrypted_credentials(database_url: str):
    """Re-encrypt all credentials with current primary key."""
    km = KeyManager()
    encryptor = CredentialEncryptor(km)

    conn = psycopg2.connect(database_url)
    cur = conn.cursor()

    # 查询所有加密凭据
    cur.execute("""
        SELECT id, credential_ref
        FROM enterprise_connector
        WHERE credential_ref IS NOT NULL
          AND credential_ref != ''
          AND deleted_at IS NULL
    """)

    rotated = 0
    failed = 0

    for connector_id, encrypted_cred in cur.fetchall():
        try:
            if encryptor.needs_rotation(encrypted_cred):
                # 重新加密
                new_encrypted = encryptor.re_encrypt(encrypted_cred)

                # 更新数据库
                cur.execute("""
                    UPDATE enterprise_connector
                    SET credential_ref = %s,
                        rotation_version = rotation_version + 1,
                        updated_at = now()
                    WHERE id = %s
                """, (new_encrypted, connector_id))

                rotated += 1
        except Exception as e:
            print(f"Failed to rotate {connector_id}: {e}")
            failed += 1

    conn.commit()
    cur.close()
    conn.close()

    print(f"Rotated: {rotated}, Failed: {failed}")
```

## 安全最佳实践

### 1. 密钥存储

**开发环境**：
- 使用 `.env` 文件（添加到 `.gitignore`）
- 或使用环境变量

**生产环境**：
- 使用密钥管理服务（AWS KMS, Azure Key Vault, HashiCorp Vault）
- 通过 Kubernetes Secrets 或类似机制注入
- 启用审计日志
- 定期轮换（建议每 90 天）

### 2. 访问控制

- 限制对密钥环境变量的访问
- 使用 IAM 角色而非长期凭据
- 记录所有密钥访问和使用

### 3. 轮换策略

- **定期轮换**：每 90 天轮换一次密钥
- **事件触发轮换**：
  - 员工离职
  - 安全事件
  - 凭据泄露怀疑
- **观察期**：保留旧密钥 30 天后再删除

### 4. 监控告警

监控指标：
- 解密失败率（应该 < 0.01%）
- 使用旧密钥版本的凭据数量
- 密钥轮换延迟

告警条件：
- 解密失败率突增
- 密钥版本分布异常
- 轮换计划超期

## 测试

运行测试：

```bash
cd /path/to/aiteam
pytest server/shared/crypto/test_crypto.py -v
```

测试覆盖：
- ✅ 密钥生成和验证
- ✅ 单密钥和多版本密钥加载
- ✅ 加密/解密往返
- ✅ 密钥轮换
- ✅ 错误处理（无效格式、缺失密钥等）
- ✅ Unicode 凭据支持

## 故障排除

### 问题：KeyRotationError: No encryption keys found

**原因**：未设置环境变量

**解决**：
```bash
# 生成新密钥
python -m server.shared.crypto.rotation generate

# 设置环境变量
export AITEAM_ENCRYPTION_KEY='your-generated-key'
```

### 问题：InvalidToken: Failed to decrypt credential

**原因**：
1. 使用了错误的密钥
2. 数据损坏
3. 密钥版本不匹配

**解决**：
```python
# 检查密钥版本
version = encryptor.get_version(encrypted_value)
print(f"Credential version: {version}")
print(f"Available versions: {key_manager.list_versions()}")

# 如果版本缺失，需要恢复旧密钥
```

### 问题：解密成功但解密后是乱码

**原因**：密钥正确但加密时使用了错误的编码

**解决**：检查加密时是否正确使用了 UTF-8 编码

## 与旧系统的区别

### MVP 阶段（app/）

旧实现存在的问题：
- ❌ `credential_ref` 字段直接存储明文凭据
- ❌ 没有密钥管理机制
- ❌ 没有轮换支持
- ❌ `_sanitize_connector_config_json` 只做显示脱敏，不加密存储

### v1 架构（server/）

新实现的改进：
- ✅ `credential_ref` 存储加密后的凭据（格式：`v{version}:{ciphertext}`）
- ✅ 生产级密钥管理（KeyManager）
- ✅ 支持零停机密钥轮换
- ✅ 明确的版本控制和迁移路径
- ✅ 完整的测试覆盖

## 后续规划

### Phase 1: 基础设施（已完成）
- ✅ KeyManager 和 CredentialEncryptor
- ✅ 密钥轮换服务
- ✅ 单元测试
- ✅ 文档

### Phase 2: Manager Service 集成（待实施）
- 🔲 在 ConnectorService 中集成加密
- 🔲 数据库迁移脚本
- 🔲 API 端点（创建/更新 connector 时自动加密）

### Phase 3: 运维工具（待实施）
- 🔲 完善 CLI 工具的数据库集成
- 🔲 自动化轮换定时任务
- 🔲 监控和告警集成

### Phase 4: KMS 集成（可选）
- 🔲 AWS KMS adapter
- 🔲 Azure Key Vault adapter
- 🔲 HashiCorp Vault adapter

## 参考文档

- v1 概要设计 §3.6: 多租户认证
- v1 概要设计 D18: 禁止明文密钥裁决
- [Cryptography library documentation](https://cryptography.io/en/latest/fernet/)
- [NIST SP 800-57: Key Management](https://csrc.nist.gov/publications/detail/sp/800-57-part-1/rev-5/final)
