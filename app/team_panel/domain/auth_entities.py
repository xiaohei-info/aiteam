"""Team Panel auth domain entities — LoginSession aggregate.

P2-S14A: Session-based auth with QR code, phone, JWT refresh, device tracking.
DDD Owner: Team Panel Auth Domain (backend-eng).
"""
from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime

from .enums import LoginSessionStatus, AuthMethod, DeviceTrustLevel


@dataclass
class DeviceSession:
    """Device tracking entity (child of LoginSession).
    
    Tracks trusted/untrusted devices per enterprise member.
    """
    id: str
    login_session_id: str
    enterprise_id: str
    user_id: str  # member_id / employee_id / external_user_id
    device_fingerprint: str = ""  # browser/device fingerprint hash
    device_name: str = ""  # user-visible name "iPhone 15"
    trust_level: str = "untrusted"  # untrusted | trusted | revoked
    last_seen_at: str = ""
    first_seen_at: str = ""
    ip_address: str = ""
    user_agent: str = ""
    created_at: str = ""
    updated_at: str = ""
    deleted_at: Optional[str] = None

    _TRUST_LEVELS = frozenset({"untrusted", "trusted", "revoked"})

    def mark_trusted(self) -> None:
        if self.trust_level == "revoked":
            raise ValueError("Cannot trust a revoked device")
        self.trust_level = "trusted"

    def revoke(self) -> None:
        self.trust_level = "revoked"

    def is_trusted(self) -> bool:
        return self.trust_level == "trusted"

    def update_last_seen(self, ip_address: str, user_agent: str, seen_at: str) -> None:
        self.last_seen_at = seen_at
        self.ip_address = ip_address
        self.user_agent = user_agent


@dataclass
class LoginSession:
    """LoginSession aggregate root for session-based auth.
    
    Supports:
    - QR code scan login (wechat/enterprise_wechat)
    - Phone verification login (sms_code)
    - JWT refresh token lifecycle
    - Multi-device tracking (DeviceSession children)
    - Rate limiting via auth_attempts tracking
    
    DDD boundary: Team Panel Auth Domain.
    """
    id: str
    enterprise_id: str
    user_id: str  # membership.employee_id or external_user_id
    auth_method: str = ""  # qr_scan | phone_verify | jwt_refresh | password
    status: str = "pending"  # pending | active | expired | revoked | logged_out
    
    # QR code flow fields
    qr_code_ref: Optional[str] = None  # QRCodeRef.id
    qr_scanned_at: Optional[str] = None
    qr_confirmed_at: Optional[str] = None
    
    # Phone verification flow fields
    phone_number: Optional[str] = None
    phone_code_ref: Optional[str] = None  # PhoneVerificationRef.id
    phone_verified_at: Optional[str] = None
    
    # JWT token fields
    access_token_jti: Optional[str] = None  # JWT ID for access token
    refresh_token_jti: Optional[str] = None  # JWT ID for refresh token
    refresh_token_expires_at: Optional[str] = None
    
    # Session lifecycle
    created_at: str = ""
    activated_at: Optional[str] = None
    expires_at: Optional[str] = None
    last_activity_at: str = ""
    logged_out_at: Optional[str] = None
    revoked_at: Optional[str] = None
    revoke_reason: Optional[str] = None
    
    # Device tracking
    primary_device_id: Optional[str] = None
    device_sessions: list[DeviceSession] = field(default_factory=list)
    
    # Rate limiting / audit
    auth_attempts: int = 0
    last_attempt_at: Optional[str] = None
    created_by: str = ""
    updated_at: str = ""
    deleted_at: Optional[str] = None

    _VALID_STATUS = frozenset({"pending", "active", "expired", "revoked", "logged_out"})
    _TERMINAL = frozenset({"expired", "revoked", "logged_out"})
    _AUTH_METHODS = frozenset({"qr_scan", "phone_verify", "jwt_refresh", "password"})

    def activate(self, auth_method: str, activated_at: str, expires_at: str) -> None:
        if self.status != "pending":
            raise ValueError(f"Cannot activate from {self.status}; must be pending")
        if auth_method not in self._AUTH_METHODS:
            raise ValueError(f"Invalid auth_method: {auth_method}")
        self.status = "active"
        self.auth_method = auth_method
        self.activated_at = activated_at
        self.expires_at = expires_at

    def refresh(self, new_access_jti: str, new_expires_at: str) -> None:
        if self.status != "active":
            raise ValueError(f"Cannot refresh from {self.status}; must be active")
        self.access_token_jti = new_access_jti
        self.expires_at = new_expires_at
        self.last_activity_at = new_expires_at

    def expire(self, expired_at: str) -> None:
        if self.status not in {"active", "pending"}:
            raise ValueError(f"Cannot expire from {self.status}")
        self.status = "expired"
        self.expires_at = expired_at

    def revoke(self, reason: str, revoked_at: str) -> None:
        if self.status in self._TERMINAL:
            raise ValueError(f"Cannot revoke from {self.status}; already terminal")
        self.status = "revoked"
        self.revoke_reason = reason
        self.revoked_at = revoked_at

    def logout(self, logged_out_at: str) -> None:
        if self.status != "active":
            raise ValueError(f"Cannot logout from {self.status}; must be active")
        self.status = "logged_out"
        self.logged_out_at = logged_out_at

    def is_active(self) -> bool:
        return self.status == "active"

    def is_terminal(self) -> bool:
        return self.status in self._TERMINAL

    def record_auth_attempt(self, attempted_at: str) -> None:
        self.auth_attempts += 1
        self.last_attempt_at = attempted_at

    def add_device_session(self, device: DeviceSession) -> None:
        self.device_sessions.append(device)

    def get_trusted_devices(self) -> list[DeviceSession]:
        return [d for d in self.device_sessions if d.is_trusted()]

    def get_device_by_fingerprint(self, fingerprint: str) -> Optional[DeviceSession]:
        for d in self.device_sessions:
            if d.device_fingerprint == fingerprint:
                return d
        return None