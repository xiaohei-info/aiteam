# Integration Guide: Using shared/crypto in Manager Service

本文档说明如何在 Manager Service 中集成 `shared/crypto` 模块来加密存储 provider 凭据。

## 目标

将 `enterprise_connector` 表中的 `credential_ref` 字段从明文存储改为加密存储。

## 集成步骤

### 1. 在 Manager Service 中添加依赖

在 `server/manager_service/requirements.txt` 中添加：

```
../shared/crypto
```

或直接依赖 cryptography：

```
cryptography>=41.0.0
```

### 2. 初始化密钥管理器

在 Manager Service 启动时初始化全局密钥管理器：

```python
# server/manager_service/app.py

from server.shared.crypto import KeyManager, CredentialEncryptor

# 全局单例
_key_manager = None
_credential_encryptor = None

def get_credential_encryptor() -> CredentialEncryptor:
    """获取凭据加密器单例（支持依赖注入）"""
    global _key_manager, _credential_encryptor
    
    if _credential_encryptor is None:
        _key_manager = KeyManager()
        _credential_encryptor = CredentialEncryptor(_key_manager)
    
    return _credential_encryptor


@app.on_event("startup")
async def startup_event():
    """验证加密密钥配置"""
    try:
        encryptor = get_credential_encryptor()
        print(f"Encryption key initialized (version: {encryptor._key_manager.get_primary_version()})")
    except KeyRotationError as e:
        print(f"ERROR: Failed to initialize encryption: {e}")
        raise
```

### 3. 修改 ConnectorService 以加密凭据

```python
# server/manager_service/services/connector_service.py

from server.shared.crypto import CredentialEncryptor
from ..app import get_credential_encryptor

class ConnectorService:
    def __init__(self, tenant_context, connector_repo):
        self._tenant_context = tenant_context
        self._connector_repo = connector_repo
        self._encryptor = get_credential_encryptor()

    def create_connector(
        self,
        enterprise_id: str,
        name: str,
        provider_code: str,
        connector_type: str,
        api_key: str,
        config_json: dict = None,
        created_by: str = None,
    ) -> EnterpriseConnector:
        """创建连接器（自动加密凭据）"""
        
        # 加密 API key
        encrypted_credential = self._encryptor.encrypt(api_key)
        
        # 生成显示用掩码
        mask = self._generate_mask(api_key)
        
        connector = EnterpriseConnector(
            id=generate_id(),
            enterprise_id=enterprise_id,
            name=name,
            provider_code=provider_code,
            connector_type=connector_type,
            credential_ref=encrypted_credential,  # 存储加密凭据
            credential_mask=mask,
            credential_state="configured",
            rotation_version=self._encryptor._key_manager.get_primary_version(),
            status="draft",
            config_json=json.dumps(config_json or {}),
            created_by=created_by,
        )
        
        return self._connector_repo.create(connector)

    def update_connector_credential(
        self,
        connector_id: str,
        new_api_key: str,
        updated_by: str = None,
    ) -> EnterpriseConnector:
        """更新连接器凭据"""
        
        connector = self._connector_repo.get_by_id(connector_id)
        if not connector:
            raise ValueError(f"Connector {connector_id} not found")
        
        # 加密新凭据
        encrypted_credential = self._encryptor.encrypt(new_api_key)
        mask = self._generate_mask(new_api_key)
        
        connector.credential_ref = encrypted_credential
        connector.credential_mask = mask
        connector.credential_state = "configured"
        connector.rotation_version = self._encryptor._key_manager.get_primary_version()
        connector.updated_by = updated_by
        
        return self._connector_repo.update(connector)

    def get_decrypted_credential(self, connector_id: str) -> str:
        """获取解密后的凭据（供 Agent 使用）"""
        
        connector = self._connector_repo.get_by_id(connector_id)
        if not connector:
            raise ValueError(f"Connector {connector_id} not found")
        
        if not connector.credential_ref:
            raise ValueError(f"Connector {connector_id} has no credential")
        
        # 解密凭据
        return self._encryptor.decrypt(connector.credential_ref)

    def _generate_mask(self, api_key: str) -> str:
        """生成凭据显示掩码"""
        if not api_key:
            return "未配置"
        
        if len(api_key) <= 8:
            return "***"
        
        prefix = api_key[:4]
        suffix = api_key[-4:]
        return f"{prefix}***{suffix}"
```

### 4. 数据库迁移脚本

创建迁移脚本将现有明文凭据加密：

```python
# server/manager_service/migrations/014_encrypt_existing_credentials.py

"""
Encrypt existing plaintext credentials in enterprise_connector table.

This migration:
1. Loads all connectors with non-empty credential_ref
2. Encrypts each credential with current primary key
3. Updates credential_ref with encrypted value
4. Sets rotation_version to current key version
"""

import psycopg2
from server.shared.crypto import KeyManager, CredentialEncryptor

def migrate(conn):
    """Encrypt existing plaintext credentials."""
    
    # Initialize encryptor
    key_manager = KeyManager()
    encryptor = CredentialEncryptor(key_manager)
    primary_version = key_manager.get_primary_version()
    
    cur = conn.cursor()
    
    # Find all connectors with credentials
    cur.execute("""
        SELECT id, credential_ref
        FROM enterprise_connector
        WHERE credential_ref IS NOT NULL
          AND credential_ref != ''
          AND deleted_at IS NULL
    """)
    
    connectors = cur.fetchall()
    print(f"Found {len(connectors)} connectors to encrypt")
    
    encrypted_count = 0
    skipped_count = 0
    
    for connector_id, credential_ref in connectors:
        # Check if already encrypted (has version prefix)
        if credential_ref.startswith('v') and ':' in credential_ref:
            print(f"  Skipping {connector_id}: already encrypted")
            skipped_count += 1
            continue
        
        try:
            # Encrypt plaintext credential
            encrypted = encryptor.encrypt(credential_ref)
            
            # Update database
            cur.execute("""
                UPDATE enterprise_connector
                SET credential_ref = %s,
                    rotation_version = %s,
                    updated_at = now()
                WHERE id = %s
            """, (encrypted, primary_version, connector_id))
            
            encrypted_count += 1
            print(f"  ✓ Encrypted {connector_id}")
            
        except Exception as e:
            print(f"  ✗ Failed to encrypt {connector_id}: {e}")
            raise
    
    conn.commit()
    cur.close()
    
    print(f"\nMigration complete:")
    print(f"  Encrypted: {encrypted_count}")
    print(f"  Skipped: {skipped_count}")
    print(f"  Total: {len(connectors)}")


if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 2:
        print("Usage: python 014_encrypt_existing_credentials.py <database_url>")
        sys.exit(1)
    
    database_url = sys.argv[1]
    conn = psycopg2.connect(database_url)
    
    try:
        migrate(conn)
    finally:
        conn.close()
```

### 5. 添加密钥轮换定时任务

```python
# server/manager_service/tasks/key_rotation.py

"""
Periodic key rotation task for credentials.

Should be run via cron or task scheduler:
  0 2 * * 0  # Weekly on Sunday at 2 AM
"""

import psycopg2
from server.shared.crypto import KeyManager, CredentialEncryptor
from server.shared.crypto.rotation import KeyRotationService

def rotate_credentials(database_url: str, dry_run: bool = False):
    """Rotate all credentials to current primary key version."""
    
    key_manager = KeyManager()
    service = KeyRotationService(key_manager)
    encryptor = CredentialEncryptor(key_manager)
    
    conn = psycopg2.connect(database_url)
    cur = conn.cursor()
    
    # Find all encrypted credentials
    cur.execute("""
        SELECT id, credential_ref, rotation_version
        FROM enterprise_connector
        WHERE credential_ref IS NOT NULL
          AND credential_ref != ''
          AND deleted_at IS NULL
    """)
    
    connectors = cur.fetchall()
    print(f"Checking {len(connectors)} connectors for rotation")
    
    needs_rotation = 0
    rotated = 0
    failed = 0
    
    for connector_id, encrypted_cred, current_version in connectors:
        try:
            if encryptor.needs_rotation(encrypted_cred):
                needs_rotation += 1
                
                if not dry_run:
                    # Re-encrypt with current primary key
                    new_encrypted = encryptor.re_encrypt(encrypted_cred)
                    new_version = key_manager.get_primary_version()
                    
                    cur.execute("""
                        UPDATE enterprise_connector
                        SET credential_ref = %s,
                            rotation_version = %s,
                            updated_at = now()
                        WHERE id = %s
                    """, (new_encrypted, new_version, connector_id))
                    
                    rotated += 1
                    print(f"  ✓ Rotated {connector_id}: v{current_version} -> v{new_version}")
                else:
                    print(f"  [DRY RUN] Would rotate {connector_id}: v{current_version}")
        
        except Exception as e:
            print(f"  ✗ Failed to rotate {connector_id}: {e}")
            failed += 1
    
    if not dry_run:
        conn.commit()
    
    cur.close()
    conn.close()
    
    print(f"\nRotation summary:")
    print(f"  Needs rotation: {needs_rotation}")
    print(f"  Rotated: {rotated}")
    print(f"  Failed: {failed}")
    
    return {
        "needs_rotation": needs_rotation,
        "rotated": rotated,
        "failed": failed,
    }


if __name__ == "__main__":
    import sys
    import os
    
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("ERROR: DATABASE_URL environment variable not set")
        sys.exit(1)
    
    dry_run = "--dry-run" in sys.argv
    
    rotate_credentials(database_url, dry_run=dry_run)
```

## 部署清单

### 开发环境

1. 生成密钥：
   ```bash
   python -m server.shared.crypto.rotation generate
   ```

2. 配置环境变量：
   ```bash
   export AITEAM_ENCRYPTION_KEY='generated-key-here'
   ```

3. 运行迁移：
   ```bash
   python server/manager_service/migrations/014_encrypt_existing_credentials.py "postgresql://..."
   ```

### 生产环境

1. **准备阶段**（提前部署新密钥）：
   ```bash
   # 生成新密钥
   KEY2=$(python -m server.shared.crypto.rotation generate | grep export | cut -d"'" -f2)
   
   # 更新配置（保留旧密钥）
   export AITEAM_ENCRYPTION_KEYS='{"1":"old-key","2":"'$KEY2'"}'
   export AITEAM_ENCRYPTION_KEY_VERSION=2
   ```

2. **部署新代码**：
   - 部署包含 shared/crypto 集成的 Manager Service
   - 新凭据将使用 v2 加密
   - 旧凭据仍可用 v1 解密

3. **迁移阶段**（重新加密旧凭据）：
   ```bash
   # 先测试
   python server/manager_service/tasks/key_rotation.py --dry-run
   
   # 执行轮换
   python server/manager_service/tasks/key_rotation.py
   ```

4. **观察期**（30 天）：
   - 监控解密失败率
   - 确认所有凭据已迁移到 v2
   - 保留 v1 密钥作为备份

5. **清理阶段**（30 天后）：
   ```bash
   # 移除旧密钥
   export AITEAM_ENCRYPTION_KEYS='{"2":"new-key"}'
   export AITEAM_ENCRYPTION_KEY_VERSION=2
   ```

## 监控指标

建议监控以下指标：

- `aiteam_credential_decrypt_success_total`: 成功解密次数
- `aiteam_credential_decrypt_failure_total`: 解密失败次数
- `aiteam_credential_key_version`: 按版本号统计凭据数量
- `aiteam_key_rotation_duration_seconds`: 密钥轮换耗时

## 故障恢复

### 场景 1: 密钥丢失

如果加密密钥丢失，**无法恢复加密的凭据**。预防措施：

1. 将密钥备份到多个安全位置
2. 使用密钥管理服务（AWS KMS, Azure Key Vault）
3. 定期测试密钥恢复流程

### 场景 2: 解密失败率突增

1. 检查密钥配置是否正确
2. 验证 rotation_version 与实际密钥版本匹配
3. 回滚到上一个已知良好的密钥配置

### 场景 3: 轮换失败

1. 查看迁移脚本日志，定位失败的 connector_id
2. 手动验证失败凭据的格式
3. 必要时手动修复单个凭据后重试

## 参考

- [shared/crypto README](../README.md)
- [v1 概要设计 §3.6: 多租户认证](../../../docs/v1正式版本/技术设计/概要设计/)
- [D18: 禁止明文密钥裁决](../../../docs/v1正式版本/技术设计/概要设计/)
