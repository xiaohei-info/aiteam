"""枚举口径（冻结）。

- 会话主状态 / 展示态：07 §8（展示态不写入持久化主状态）。
- 角色枚举：03 §9.7（禁用旧 admin/manager/viewer）。
- 隔离档位：04 §6.1.1（L1/L2/L3）。
- provider：03 §9.3（auth_identity.provider 取值，新增登录方式=多一个取值）。

下游禁止重新声明这些枚举；测试 `test_contracts.py` 会断言取值集合不被悄改。
"""

from __future__ import annotations

from enum import Enum


class ConversationState(str, Enum):
    """Conversation 持久化主状态（固定枚举，07 §8）。"""

    DRAFT = "draft"
    ACTIVE = "active"
    PAUSED = "paused"
    MUTED = "muted"
    ARCHIVED = "archived"


class DisplayState(str, Enum):
    """会话展示态（07 §8）。**不写入持久化主状态**，仅前端/运行态镜像使用。"""

    IDLE = "idle"
    ROUTING = "routing"
    WAITING_REPLY = "waiting_reply"
    STREAMING = "streaming"
    BUSY = "busy"
    RESOLVED = "resolved"
    RECONNECTING = "reconnecting"


class EnterpriseRole(str, Enum):
    """企业侧角色（03 §9.7）。禁用旧 admin/manager/viewer。"""

    OWNER = "owner"
    ENTERPRISE_ADMIN = "enterprise_admin"
    FINANCE_ADMIN = "finance_admin"
    MEMBER = "member"


class PlatformRole(str, Enum):
    """平台侧角色（03 §9.7）。"""

    SYSTEM_ADMIN = "system_admin"
    SYSTEM_OPERATOR = "system_operator"


class AuthProvider(str, Enum):
    """登录方式（03 §9.3）。新增方式 = 多一个取值 + 一个 Authenticator，user/token 层零改。"""

    PASSWORD = "password"
    PHONE = "phone"
    WECHAT = "wechat"


class IsolationLevel(str, Enum):
    """Manager 租户隔离档位（04 §6.1.1，D20）。业务代码不感知差异，只经 TenantRouter。"""

    L1_SHARED_RLS = "l1_shared_rls"
    L2_SCHEMA_PER_TENANT = "l2_schema_per_tenant"
    L3_DB_PER_TENANT = "l3_db_per_tenant"
