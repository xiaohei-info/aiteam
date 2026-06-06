"""Team Panel domain enums — single source of truth for control-plane statuses."""
from enum import StrEnum


class EmployeeStatus(StrEnum):
    """员工主状态 per 领域模型详细设计 §5.1"""
    DRAFT = "draft"
    PROVISIONING = "provisioning"
    ACTIVE = "active"
    PAUSED = "paused"
    PROVISIONING_FAILED = "provisioning_failed"
    ARCHIVED = "archived"


class ConversationType(StrEnum):
    PRIVATE = "private"
    GROUP = "group"


class ExecutionMode(StrEnum):
    SINGLE_AGENT = "single_agent"
    KANBAN_ORCHESTRATION = "kanban_orchestration"
    CRON_SINGLE_AGENT = "cron_single_agent"


class TriggerType(StrEnum):
    PRIVATE_MESSAGE = "private_message"
    GROUP_MESSAGE = "group_message"
    MANUAL_RUN = "manual_run"
    SCHEDULED_JOB = "scheduled_job"
    API_CALL = "api_call"


class CreatedFrom(StrEnum):
    TALENT_MARKET = "talent_market"
    MANUAL = "manual"
    SOLUTION_APPLY = "solution_apply"
    ADMIN_SEED = "admin_seed"


class EnterpriseRole(StrEnum):
    """企业侧成员角色 per 共享口径 §8.1"""
    OWNER = "owner"
    ENTERPRISE_ADMIN = "enterprise_admin"
    FINANCE_ADMIN = "finance_admin"
    MEMBER = "member"


class EnterpriseStatus(StrEnum):
    """Enterprise control-plane status."""
    ACTIVE = "active"
    SUSPENDED = "suspended"
    ARCHIVED = "archived"


class MembershipStatus(StrEnum):
    """Membership status values."""
    ACTIVE = "active"
    INVITED = "invited"
    DISABLED = "disabled"
    REMOVED = "removed"


class SystemRole(StrEnum):
    """平台侧角色 per 共享口径 §8.2"""
    SYSTEM_ADMIN = "system_admin"
    SYSTEM_OPERATOR = "system_operator"

class LoginSessionStatus(StrEnum):
    """Login session lifecycle status per P2-S14A."""
    PENDING = "pending"
    ACTIVE = "active"
    EXPIRED = "expired"
    REVOKED = "revoked"
    LOGGED_OUT = "logged_out"


class AuthMethod(StrEnum):
    """Authentication method per P2-S14A."""
    QR_SCAN = "qr_scan"
    PHONE_VERIFY = "phone_verify"
    JWT_REFRESH = "jwt_refresh"
    PASSWORD = "password"


class DeviceTrustLevel(StrEnum):
    """Device trust level for device tracking per P2-S14A."""
    UNTRUSTED = "untrusted"
    TRUSTED = "trusted"
    REVOKED = "revoked"


class QRCodeStatus(StrEnum):
    """QR code login ticket status per P2-S14A."""
    PENDING = "pending"
    SCANNED = "scanned"
    CONFIRMED = "confirmed"
    EXPIRED = "expired"
    CANCELLED = "cancelled"


class PhoneVerificationStatus(StrEnum):
    """Phone verification code status per P2-S14A."""
    PENDING = "pending"
    VERIFIED = "verified"
    EXPIRED = "expired"
    EXCEEDED = "exceeded"

