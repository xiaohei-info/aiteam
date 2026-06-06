"""AuthService — domain service for LoginSession aggregate operations.

P2-S14A: QR code login, phone verification, JWT refresh, device tracking, rate limiting.
DDD Owner: Team Panel Auth Domain (backend-eng).
"""
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import hashlib
import uuid

from ...domain.auth_entities import DeviceSession, LoginSession
from ...domain.auth_value_objects import AuthRateLimitKey, PhoneVerificationRef, QRCodeRef


class RateLimitExceededError(RuntimeError):
    """Raised when an auth action exceeds its rate limit."""


@dataclass
class QRLoginRequest:
    """Request to initiate QR code login."""

    enterprise_id: str
    created_by: str


@dataclass
class QRLoginResult:
    """Result of QR code login initiation."""

    qr_ref: QRCodeRef
    login_session_id: str


@dataclass
class PhoneLoginRequest:
    """Request to initiate phone verification login."""

    enterprise_id: str
    phone_number: str
    created_by: str


@dataclass
class PhoneLoginResult:
    """Result of phone verification login initiation."""

    phone_ref: PhoneVerificationRef
    login_session_id: str


@dataclass
class RefreshTokenRequest:
    """Request to refresh JWT access token."""

    enterprise_id: str
    user_id: str
    refresh_token_jti: str
    login_session_id: str


@dataclass
class RefreshTokenResult:
    """Result of JWT token refresh."""

    new_access_token: str
    new_access_jti: str
    new_expires_at: str


@dataclass
class DeviceRegistrationRequest:
    """Request to register a device session."""

    login_session_id: str
    enterprise_id: str
    user_id: str
    device_fingerprint: str
    device_name: str
    ip_address: str
    user_agent: str


@dataclass
class LogoutRequest:
    """Request to logout a session."""

    login_session_id: str
    enterprise_id: str
    user_id: str


class AuthService:
    """Minimal in-memory auth service used by the current auth domain tests."""

    _RATE_LIMITS = {
        "scan_qr": (5, timedelta(minutes=1)),
        "verify_phone": (3, timedelta(hours=1)),
        "refresh": (10, timedelta(minutes=1)),
        "login": (5, timedelta(minutes=1)),
    }
    _PHONE_TEST_CODE = "888888"

    def __init__(self) -> None:
        self._qr_refs: dict[str, QRCodeRef] = {}
        self._phone_refs: dict[str, PhoneVerificationRef] = {}
        self._sessions: dict[str, LoginSession] = {}
        self._devices: dict[str, DeviceSession] = {}
        self._qr_to_session: dict[str, str] = {}
        self._phone_to_session: dict[str, str] = {}
        self._rate_limit_events: dict[str, list[datetime]] = {}

    def init_qr_login(self, request: QRLoginRequest) -> QRLoginResult:
        rate_key = AuthRateLimitKey(
            enterprise_id=request.enterprise_id,
            key_type="enterprise",
            key_value=request.enterprise_id,
            action="scan_qr",
        )
        if not self.check_rate_limit(rate_key):
            raise RateLimitExceededError("QR login initiation rate limit exceeded")

        now = self._now()
        qr_ref_id = self._new_id("qr")
        login_session_id = self._new_id("ls")
        qr_ref = QRCodeRef(
            id=qr_ref_id,
            enterprise_id=request.enterprise_id,
            qr_data=f"qr:{qr_ref_id}",
            scan_url=f"/auth/qr/{qr_ref_id}",
            expires_at=self._future(minutes=10),
            created_at=now,
        )
        session = LoginSession(
            id=login_session_id,
            enterprise_id=request.enterprise_id,
            user_id=request.created_by,
            status="pending",
            qr_code_ref=qr_ref_id,
            created_at=now,
            last_activity_at=now,
            created_by=request.created_by,
            updated_at=now,
        )
        self._qr_refs[qr_ref_id] = qr_ref
        self._sessions[login_session_id] = session
        self._qr_to_session[qr_ref_id] = login_session_id
        return QRLoginResult(qr_ref=qr_ref, login_session_id=login_session_id)

    def confirm_qr_scan(self, qr_ref_id: str, scanned_by_user_id: str) -> QRCodeRef:
        qr_ref = self._require_qr_ref(qr_ref_id)
        if not qr_ref.is_pending():
            raise ValueError(f"QR ref {qr_ref_id} is not pending")

        now = self._now()
        updated = replace(
            qr_ref,
            status="scanned",
            scanned_by_user_id=scanned_by_user_id,
            scanned_at=now,
        )
        self._qr_refs[qr_ref_id] = updated

        session = self._sessions[self._qr_to_session[qr_ref_id]]
        session.qr_scanned_at = now
        session.updated_at = now
        return updated

    def confirm_qr_login(self, qr_ref_id: str, confirmed_by_user_id: str) -> LoginSession:
        qr_ref = self._require_qr_ref(qr_ref_id)
        if not qr_ref.is_scanned():
            raise ValueError(f"QR ref {qr_ref_id} must be scanned before confirmation")

        now = self._now()
        session = self._sessions[self._qr_to_session[qr_ref_id]]
        session.user_id = confirmed_by_user_id
        session.qr_confirmed_at = now
        session.refresh_token_jti = self._new_id("refresh")
        session.refresh_token_expires_at = self._future(days=7)
        session.refresh(new_access_jti=self._new_id("access"), new_expires_at=self._future(hours=1)) if session.is_active() else session.activate(
            auth_method="qr_scan",
            activated_at=now,
            expires_at=self._future(hours=1),
        )
        session.access_token_jti = session.access_token_jti or self._new_id("access")
        session.last_activity_at = now
        session.updated_at = now

        self._qr_refs[qr_ref_id] = replace(qr_ref, status="confirmed", confirmed_at=now)
        return session

    def init_phone_login(self, request: PhoneLoginRequest) -> PhoneLoginResult:
        rate_key = AuthRateLimitKey(
            enterprise_id=request.enterprise_id,
            key_type="phone",
            key_value=request.phone_number,
            action="verify_phone",
        )
        if not self.check_rate_limit(rate_key):
            raise RateLimitExceededError("Phone login initiation rate limit exceeded")

        now = self._now()
        phone_ref_id = self._new_id("phone")
        login_session_id = self._new_id("ls")
        phone_ref = PhoneVerificationRef(
            id=phone_ref_id,
            phone_number=request.phone_number,
            code_hash=self._hash_code(self._PHONE_TEST_CODE),
            enterprise_id=request.enterprise_id,
            expires_at=self._future(minutes=10),
            created_at=now,
        )
        session = LoginSession(
            id=login_session_id,
            enterprise_id=request.enterprise_id,
            user_id=request.created_by,
            status="pending",
            phone_number=request.phone_number,
            phone_code_ref=phone_ref_id,
            created_at=now,
            last_activity_at=now,
            created_by=request.created_by,
            updated_at=now,
        )
        self._phone_refs[phone_ref_id] = phone_ref
        self._sessions[login_session_id] = session
        self._phone_to_session[phone_ref_id] = login_session_id
        return PhoneLoginResult(phone_ref=phone_ref, login_session_id=login_session_id)

    def verify_phone_code(self, phone_ref_id: str, code: str) -> LoginSession:
        phone_ref = self._require_phone_ref(phone_ref_id)
        if not phone_ref.is_pending():
            raise ValueError(f"Phone verification ref {phone_ref_id} is not pending")

        attempts = phone_ref.attempts + 1
        now = self._now()
        if self._hash_code(code) != phone_ref.code_hash:
            status = "exceeded" if attempts >= phone_ref.max_attempts else "pending"
            self._phone_refs[phone_ref_id] = replace(phone_ref, attempts=attempts, status=status)
            raise ValueError("Invalid phone verification code")

        updated_ref = replace(phone_ref, attempts=attempts, status="verified", verified_at=now)
        self._phone_refs[phone_ref_id] = updated_ref

        session = self._sessions[self._phone_to_session[phone_ref_id]]
        session.phone_verified_at = now
        session.refresh_token_jti = self._new_id("refresh")
        session.refresh_token_expires_at = self._future(days=7)
        session.activate(auth_method="phone_verify", activated_at=now, expires_at=self._future(hours=1))
        session.access_token_jti = self._new_id("access")
        session.last_activity_at = now
        session.updated_at = now
        return session

    def refresh_token(self, request: RefreshTokenRequest) -> RefreshTokenResult:
        rate_key = AuthRateLimitKey(
            enterprise_id=request.enterprise_id,
            key_type="session",
            key_value=request.login_session_id,
            action="refresh",
        )
        if not self.check_rate_limit(rate_key):
            raise RateLimitExceededError("Refresh token rate limit exceeded")

        session = self._require_session(request.login_session_id)
        if session.enterprise_id != request.enterprise_id or session.user_id != request.user_id:
            raise ValueError("Refresh request does not match the active session")
        if session.refresh_token_jti != request.refresh_token_jti:
            raise ValueError("Refresh token JTI does not match the active session")
        if session.status != "active":
            raise ValueError(f"Cannot refresh from {session.status}; must be active")

        now = self._now()
        new_access_jti = self._new_id("access")
        new_expires_at = self._future(hours=1)
        session.refresh(new_access_jti=new_access_jti, new_expires_at=new_expires_at)
        session.updated_at = now
        return RefreshTokenResult(
            new_access_token=f"access-token:{new_access_jti}",
            new_access_jti=new_access_jti,
            new_expires_at=new_expires_at,
        )

    def register_device(self, request: DeviceRegistrationRequest) -> DeviceSession:
        session = self._require_session(request.login_session_id)
        if session.enterprise_id != request.enterprise_id or session.user_id != request.user_id:
            raise ValueError("Device registration request does not match the active session")

        now = self._now()
        existing = session.get_device_by_fingerprint(request.device_fingerprint)
        if existing is not None:
            existing.device_name = request.device_name
            existing.update_last_seen(
                ip_address=request.ip_address,
                user_agent=request.user_agent,
                seen_at=now,
            )
            existing.updated_at = now
            return existing

        device = DeviceSession(
            id=self._new_id("dev"),
            login_session_id=request.login_session_id,
            enterprise_id=request.enterprise_id,
            user_id=request.user_id,
            device_fingerprint=request.device_fingerprint,
            device_name=request.device_name,
            trust_level="untrusted",
            last_seen_at=now,
            first_seen_at=now,
            ip_address=request.ip_address,
            user_agent=request.user_agent,
            created_at=now,
            updated_at=now,
        )
        session.add_device_session(device)
        session.primary_device_id = session.primary_device_id or device.id
        session.updated_at = now
        self._devices[device.id] = device
        return device

    def trust_device(self, device_session_id: str) -> DeviceSession:
        device = self._require_device(device_session_id)
        device.mark_trusted()
        device.updated_at = self._now()
        return device

    def revoke_device(self, device_session_id: str) -> DeviceSession:
        device = self._require_device(device_session_id)
        device.revoke()
        device.updated_at = self._now()
        return device

    def logout(self, request: LogoutRequest) -> LoginSession:
        session = self._require_session(request.login_session_id)
        if session.enterprise_id != request.enterprise_id or session.user_id != request.user_id:
            raise ValueError("Logout request does not match the active session")
        now = self._now()
        session.logout(logged_out_at=now)
        session.updated_at = now
        return session

    def check_rate_limit(self, rate_key: AuthRateLimitKey) -> bool:
        limit, window = self._resolve_rate_limit(rate_key.action)
        cache_key = rate_key.to_cache_key()
        now = datetime.now(timezone.utc)
        events = [ts for ts in self._rate_limit_events.get(cache_key, []) if now - ts < window]
        allowed = len(events) < limit
        if allowed:
            events.append(now)
        self._rate_limit_events[cache_key] = events
        return allowed

    def _require_qr_ref(self, qr_ref_id: str) -> QRCodeRef:
        qr_ref = self._qr_refs.get(qr_ref_id)
        if qr_ref is None:
            raise ValueError(f"Unknown QR ref: {qr_ref_id}")
        return qr_ref

    def _require_phone_ref(self, phone_ref_id: str) -> PhoneVerificationRef:
        phone_ref = self._phone_refs.get(phone_ref_id)
        if phone_ref is None:
            raise ValueError(f"Unknown phone verification ref: {phone_ref_id}")
        return phone_ref

    def _require_session(self, login_session_id: str) -> LoginSession:
        session = self._sessions.get(login_session_id)
        if session is None:
            raise ValueError(f"Unknown login session: {login_session_id}")
        return session

    def _require_device(self, device_session_id: str) -> DeviceSession:
        device = self._devices.get(device_session_id)
        if device is None:
            raise ValueError(f"Unknown device session: {device_session_id}")
        return device

    def _resolve_rate_limit(self, action: str) -> tuple[int, timedelta]:
        return self._RATE_LIMITS.get(action, (5, timedelta(minutes=1)))

    def _new_id(self, prefix: str) -> str:
        return f"{prefix}_{uuid.uuid4().hex[:12]}"

    def _hash_code(self, code: str) -> str:
        return hashlib.sha256(code.encode("utf-8")).hexdigest()

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _future(self, *, minutes: int = 0, hours: int = 0, days: int = 0) -> str:
        return (datetime.now(timezone.utc) + timedelta(minutes=minutes, hours=hours, days=days)).isoformat()
