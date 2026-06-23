# Operation 企业账号仓储 PostgreSQL 实现

## 概述

本实现将 Operation 端企业账号仓储从内存骨架替换为 PostgreSQL 持久化，满足生产环境需求。

## 架构设计

### 仓储抽象

- **`EnterpriseRepository`**: 抽象基类，定义接口契约
- **`InMemoryEnterpriseRepository`**: 内存实现（dev/测试）
- **`PgEnterpriseRepository`**: PostgreSQL 实现（生产）

### 数据库设计

- **数据库**: `oper`（Operation 专属单租户库，无 RLS）
- **表**: `enterprise_account`
- **角色**: `app_rw`（受约束应用角色，非 superuser、非 BYPASSRLS）
- **迁移**: `operation_service/migrations/*.sql`（幂等脚本）

### 字段说明

```sql
enterprise_account (
    enterprise_id       uuid PRIMARY KEY,           -- 企业 ID（全局唯一）
    tenant_id           uuid NOT NULL UNIQUE,       -- 租户 ID（全局唯一）
    enterprise_name     text NOT NULL,              -- 企业名称
    enterprise_code     text,                       -- 企业代码（可选，非空时全局唯一）
    owner_phone         text NOT NULL,              -- 负责人手机号
    owner_bootstrap_hash text NOT NULL,             -- bootstrap 校验材料（sha256，绝不存明文）
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
)
```

### 约束与索引

- **主键**: `enterprise_id`
- **唯一约束**: `tenant_id`, `enterprise_code`（UNIQUE NULLS NOT DISTINCT）
- **索引**: `tenant_id`, `enterprise_code`（WHERE NOT NULL）

## 配置

### 环境变量

生产环境需配置以下环境变量：

```bash
# 业务连接（app_rw 身份）
OPER_DB_URL=postgresql://app_rw:password@localhost:5432/oper

# 管理连接（超管/DDL owner，用于迁移）
OPER_ADMIN_DB_URL=postgresql://admin:adminpass@localhost:5432/oper

# app_rw 角色密码（从配置/env 取，不硬编码）
OPER_APP_RW_PASSWORD=secure_password
```

### 配置逻辑

在 `operation_service/dependencies.py` 中：

```python
def get_repository() -> EnterpriseRepository:
    settings = load_settings("operation")
    oper_db_url = settings.raw.get("oper_db_url")
    
    if oper_db_url:
        # PostgreSQL 实现：自动应用迁移
        admin_url = settings.raw.get("oper_admin_db_url") or oper_db_url
        app_rw_password = settings.raw.get("oper_app_rw_password")
        apply_migrations(admin_url, app_rw_password)
        return PgEnterpriseRepository(oper_db_url)
    
    # 内存实现（dev/测试，无配置时自动降级）
    return InMemoryEnterpriseRepository()
```

## 使用方式

### 开发环境（内存）

无需配置，自动使用内存仓储：

```bash
cd server
python run.py --tier=operation
```

### 生产环境（PostgreSQL）

1. **创建数据库**:

```bash
createdb oper
```

2. **配置环境变量**（或在配置文件中）:

```bash
export OPER_DB_URL=postgresql://app_rw:password@localhost:5432/oper
export OPER_ADMIN_DB_URL=postgresql://postgres:adminpass@localhost:5432/oper
export OPER_APP_RW_PASSWORD=secure_password
```

3. **启动服务**（自动应用迁移）:

```bash
cd server
python run.py --tier=operation
```

## 测试

### 单元测试（内存）

不需要 PostgreSQL，快速验证接口契约：

```bash
cd server
pytest tests/operation/test_repository_memory.py -v
pytest tests/operation/test_service.py -v
```

### 集成测试（PostgreSQL）

需要真实 PostgreSQL：

```bash
# 配置测试数据库
export OPER_TEST_ADMIN_DB_URL=postgresql://postgres:password@localhost:5432/oper_test
export OPER_TEST_DB_URL=postgresql://app_rw:password@localhost:5432/oper_test
export OPER_TEST_APP_RW_PASSWORD=test_password

# 运行集成测试
cd server
pytest tests/operation/test_repository_pg.py -v -m integration
```

### 跳过集成测试

默认测试运行不需要 PostgreSQL：

```bash
cd server
pytest tests/operation/ -v -m "not integration"
```

## 迁移管理

### 迁移脚本规范

- **位置**: `operation_service/migrations/*.sql`
- **命名**: `0001_xxx.sql`, `0002_xxx.sql`（按序号排序）
- **幂等性**: 必须使用 `IF NOT EXISTS` / `OR REPLACE` / `DO` 块
- **自动执行**: 启动时自动按序应用未应用的迁移

### 添加新迁移

1. 创建新文件 `operation_service/migrations/000X_description.sql`
2. 编写幂等 SQL（参考 `0001_enterprise_account.sql`）
3. 重启服务，自动应用

## 安全约束

### 红线（CLAUDE/AGENTS §8 / 03 §9.2）

- ✅ Operator **永不持企业长期/明文密码**
- ✅ `owner_bootstrap_hash` 只存 **sha256 校验材料**
- ✅ 企业账号表**唯一写端是 Operator**（单写者）
- ✅ 应用角色 `app_rw` 非 superuser、非 BYPASSRLS
- ✅ 迁移/DDL 用独立**管理连接**（超管/DDL owner）

### 密码处理

```python
# Operator 本端只持 sha256
local_hash = hashlib.sha256(secret.encode()).hexdigest()

# 跨端同步给 Manager 的是明文（TLS 服务间）
# Manager 单次 scrypt hash 是单一真相源
```

## 故障排查

### 连接失败

- 检查 `OPER_DB_URL` 配置是否正确
- 检查 PostgreSQL 服务是否运行
- 检查 `app_rw` 角色是否创建且有正确权限

### 迁移失败

- 检查 `OPER_ADMIN_DB_URL` 是否有 DDL 权限
- 查看日志中的 SQL 错误信息
- 手动连接数据库检查表状态

### 测试失败

- 单元测试失败：检查代码逻辑
- 集成测试失败：检查测试数据库配置和权限

## 验收标准

- ✅ PostgreSQL 实现通过企业账号仓储现有测试
- ✅ 重启后已开通企业 + bootstrap 校验材料仍在（持久化验证）
- ✅ `server` 全量 pytest 绿（单元测试，不含集成测试）
- ✅ 接口形状不变，只替换底层实现
- ✅ 支持配置降级（无配置时自动用内存仓储）

## 相关文件

- `operation_service/repository.py` - 仓储实现
- `operation_service/dependencies.py` - 依赖注入配置
- `operation_service/migrations/0001_enterprise_account.sql` - 数据库迁移
- `tests/operation/test_repository_memory.py` - 内存仓储单元测试
- `tests/operation/test_repository_pg.py` - PostgreSQL 集成测试
- `tests/operation/test_service.py` - 服务层测试（验证接口不变）
