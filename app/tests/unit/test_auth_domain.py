"""Unit tests for LoginSession aggregate and AuthService main paths.

P2-S14A: QR code login, phone verification, JWT refresh, device tracking, rate limiting.
DDD Owner: Team Panel Auth Domain (backend-eng).
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.team_panel.application.commands.auth_service import (
    AuthService,
    DeviceRegistrationRequest,
    LogoutRequest,
    PhoneLoginRequest,
    QRLoginRequest,
    RateLimitExceededError,
    RefreshTokenRequest,
)
from app.team_panel.domain.auth_entities import DeviceSession, LoginSession
from app.team_panel.domain.auth_value_objects import AuthRateLimitKey


def _activate_qr_session(service: AuthService, *, enterprise_id: str = "ent_001", user_id: str = "user_001") -> LoginSession:
    result = service.init_qr_login(QRLoginRequest(enterprise_id=enterprise_id, created_by=user_id))
    service.confirm_qr_scan(result.qr_ref.id, scanned_by_user_id=user_id)
    return service.confirm_qr_login(result.qr_ref.id, confirmed_by_user_id=user_id)


# ═══════════════════════════════════════════════════════════════════
# LoginSession Aggregate Unit Tests (domain behavior)
# ═══════════════════════════════════════════════════════════════════

class TestLoginSessionStatusTransitions:
    def test_pending_session_can_be_activated(self):
        session = LoginSession(
            id="ls_001",
            enterprise_id="ent_001",
            user_id="user_001",
            status="pending",
        )

        now = datetime.now(timezone.utc).isoformat()
        expires = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()

        session.activate(auth_method="qr_scan", activated_at=now, expires_at=expires)

        assert session.status == "active"
        assert session.auth_method == "qr_scan"
        assert session.activated_at == now

    def test_active_session_cannot_be_activated_again(self):
        session = LoginSession(
            id="ls_002",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
            auth_method="qr_scan",
        )

        now = datetime.now(timezone.utc).isoformat()
        expires = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()

        with pytest.raises(ValueError, match="Cannot activate from active"):
            session.activate(auth_method="phone_verify", activated_at=now, expires_at=expires)

    def test_active_session_can_be_refreshed(self):
        session = LoginSession(
            id="ls_003",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
            auth_method="qr_scan",
            access_token_jti="jti_old",
        )

        new_expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        session.refresh(new_access_jti="jti_new", new_expires_at=new_expires)

        assert session.access_token_jti == "jti_new"
        assert session.expires_at == new_expires

    def test_expired_session_cannot_be_refreshed(self):
        session = LoginSession(
            id="ls_004",
            enterprise_id="ent_001",
            user_id="user_001",
            status="expired",
        )

        new_expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()

        with pytest.raises(ValueError, match="Cannot refresh from expired"):
            session.refresh(new_access_jti="jti_new", new_expires_at=new_expires)

    def test_active_session_can_be_logged_out(self):
        session = LoginSession(
            id="ls_005",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
        )

        now = datetime.now(timezone.utc).isoformat()
        session.logout(logged_out_at=now)

        assert session.status == "logged_out"
        assert session.logged_out_at == now

    def test_pending_session_can_be_expired(self):
        session = LoginSession(
            id="ls_006",
            enterprise_id="ent_001",
            user_id="user_001",
            status="pending",
        )

        now = datetime.now(timezone.utc).isoformat()
        session.expire(expired_at=now)

        assert session.status == "expired"

    def test_active_session_can_be_revoked_with_reason(self):
        session = LoginSession(
            id="ls_007",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
        )

        now = datetime.now(timezone.utc).isoformat()
        session.revoke(reason="security_violation", revoked_at=now)

        assert session.status == "revoked"
        assert session.revoke_reason == "security_violation"


class TestLoginSessionDeviceTracking:
    def test_session_can_add_device_session(self):
        session = LoginSession(
            id="ls_010",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
        )

        device = DeviceSession(
            id="dev_001",
            login_session_id="ls_010",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_abc123",
            trust_level="untrusted",
        )

        session.add_device_session(device)

        assert len(session.device_sessions) == 1
        assert session.device_sessions[0].device_fingerprint == "fp_abc123"

    def test_session_can_filter_trusted_devices(self):
        session = LoginSession(
            id="ls_011",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
        )

        trusted_device = DeviceSession(
            id="dev_001",
            login_session_id="ls_011",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_trusted",
            trust_level="trusted",
        )

        untrusted_device = DeviceSession(
            id="dev_002",
            login_session_id="ls_011",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_untrusted",
            trust_level="untrusted",
        )

        session.add_device_session(trusted_device)
        session.add_device_session(untrusted_device)

        trusted = session.get_trusted_devices()

        assert len(trusted) == 1
        assert trusted[0].device_fingerprint == "fp_trusted"

    def test_session_can_find_device_by_fingerprint(self):
        session = LoginSession(
            id="ls_012",
            enterprise_id="ent_001",
            user_id="user_001",
            status="active",
        )

        device = DeviceSession(
            id="dev_001",
            login_session_id="ls_012",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_lookup",
            trust_level="untrusted",
        )

        session.add_device_session(device)

        found = session.get_device_by_fingerprint("fp_lookup")

        assert found is not None
        assert found.id == "dev_001"


class TestDeviceSessionTrustTransitions:
    def test_untrusted_device_can_be_marked_trusted(self):
        device = DeviceSession(
            id="dev_020",
            login_session_id="ls_020",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_trust_upgrade",
            trust_level="untrusted",
        )

        device.mark_trusted()

        assert device.trust_level == "trusted"
        assert device.is_trusted() is True

    def test_revoked_device_cannot_be_marked_trusted(self):
        device = DeviceSession(
            id="dev_021",
            login_session_id="ls_021",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_revoked",
            trust_level="revoked",
        )

        with pytest.raises(ValueError, match="Cannot trust a revoked device"):
            device.mark_trusted()

    def test_trusted_device_can_be_revoked(self):
        device = DeviceSession(
            id="dev_022",
            login_session_id="ls_022",
            enterprise_id="ent_001",
            user_id="user_001",
            device_fingerprint="fp_revoke",
            trust_level="trusted",
        )

        device.revoke()

        assert device.trust_level == "revoked"


# ═══════════════════════════════════════════════════════════════════
# AuthService Main-Path Tests
# ═══════════════════════════════════════════════════════════════════

class TestAuthServiceQRLogin:
    def test_init_qr_login_generates_qr_ref(self):
        service = AuthService()

        result = service.init_qr_login(
            QRLoginRequest(
                enterprise_id="ent_001",
                created_by="user_001",
            )
        )

        assert result.qr_ref.status == "pending"
        assert result.qr_ref.enterprise_id == "ent_001"
        assert result.login_session_id is not None
        assert result.qr_ref.scan_url.endswith(result.qr_ref.id)

    def test_confirm_qr_login_activates_session(self):
        service = AuthService()
        result = service.init_qr_login(
            QRLoginRequest(
                enterprise_id="ent_001",
                created_by="user_001",
            )
        )

        scanned_ref = service.confirm_qr_scan(result.qr_ref.id, scanned_by_user_id="user_mobile")
        session = service.confirm_qr_login(result.qr_ref.id, confirmed_by_user_id="user_mobile")

        assert scanned_ref.status == "scanned"
        assert session.status == "active"
        assert session.auth_method == "qr_scan"
        assert session.user_id == "user_mobile"
        assert session.qr_scanned_at is not None
        assert session.qr_confirmed_at is not None
        assert session.access_token_jti is not None
        assert session.refresh_token_jti is not None

    def test_init_qr_login_rate_limits_enterprise(self):
        service = AuthService()

        for _ in range(5):
            service.init_qr_login(
                QRLoginRequest(
                    enterprise_id="ent_rate_limit",
                    created_by="user_001",
                )
            )

        with pytest.raises(RateLimitExceededError, match="QR login initiation rate limit exceeded"):
            service.init_qr_login(
                QRLoginRequest(
                    enterprise_id="ent_rate_limit",
                    created_by="user_001",
                )
            )


class TestAuthServicePhoneLogin:
    def test_init_phone_login_generates_phone_ref(self):
        service = AuthService()

        result = service.init_phone_login(
            PhoneLoginRequest(
                enterprise_id="ent_001",
                phone_number="+861****8000",
                created_by="user_001",
            )
        )

        assert result.phone_ref.status == "pending"
        assert result.phone_ref.phone_number == "+861****8000"
        assert result.login_session_id is not None

    def test_verify_phone_code_activates_session(self):
        service = AuthService()
        result = service.init_phone_login(
            PhoneLoginRequest(
                enterprise_id="ent_001",
                phone_number="+861****8000",
                created_by="user_001",
            )
        )

        session = service.verify_phone_code(result.phone_ref.id, code="888888")

        assert session.status == "active"
        assert session.auth_method == "phone_verify"
        assert session.phone_verified_at is not None
        assert session.access_token_jti is not None
        assert session.refresh_token_jti is not None

    def test_init_phone_login_rate_limits_phone(self):
        service = AuthService()

        for _ in range(3):
            service.init_phone_login(
                PhoneLoginRequest(
                    enterprise_id="ent_001",
                    phone_number="+861****8001",
                    created_by="user_001",
                )
            )

        with pytest.raises(RateLimitExceededError, match="Phone login initiation rate limit exceeded"):
            service.init_phone_login(
                PhoneLoginRequest(
                    enterprise_id="ent_001",
                    phone_number="+861****8001",
                    created_by="user_001",
                )
            )


class TestAuthServiceRefreshToken:
    def test_refresh_token_generates_new_access_token(self):
        service = AuthService()
        session = _activate_qr_session(service)

        result = service.refresh_token(
            RefreshTokenRequest(
                enterprise_id="ent_001",
                user_id="user_001",
                refresh_token_jti=session.refresh_token_jti,
                login_session_id=session.id,
            )
        )

        assert result.new_access_token.startswith("access-token:")
        assert result.new_access_jti == session.access_token_jti
        assert result.new_expires_at == session.expires_at


class TestAuthServiceDeviceRegistration:
    def test_register_device_creates_new_device_session(self):
        service = AuthService()
        session = _activate_qr_session(service)

        device = service.register_device(
            DeviceRegistrationRequest(
                login_session_id=session.id,
                enterprise_id="ent_001",
                user_id="user_001",
                device_fingerprint="fp_new_device",
                device_name="iPhone 15",
                ip_address="192.168.1.100",
                user_agent="Mozilla/5.0",
            )
        )

        assert device.device_fingerprint == "fp_new_device"
        assert device.trust_level == "untrusted"
        assert session.primary_device_id == device.id

    def test_revoke_device_marks_device_revoked(self):
        service = AuthService()
        session = _activate_qr_session(service)
        device = service.register_device(
            DeviceRegistrationRequest(
                login_session_id=session.id,
                enterprise_id="ent_001",
                user_id="user_001",
                device_fingerprint="fp_revoke_me",
                device_name="MacBook Pro",
                ip_address="10.0.0.1",
                user_agent="Mozilla/5.0",
            )
        )

        trusted = service.trust_device(device.id)
        assert trusted.trust_level == "trusted"

        revoked = service.revoke_device(device.id)
        assert revoked.trust_level == "revoked"


class TestAuthServiceLogout:
    def test_logout_marks_session_logged_out(self):
        service = AuthService()
        session = _activate_qr_session(service)

        logged_out = service.logout(
            LogoutRequest(
                login_session_id=session.id,
                enterprise_id="ent_001",
                user_id="user_001",
            )
        )

        assert logged_out.status == "logged_out"
        assert logged_out.logged_out_at is not None


class TestAuthServiceRateLimit:
    def test_check_rate_limit_allows_below_threshold(self):
        service = AuthService()

        rate_key = AuthRateLimitKey(
            enterprise_id="ent_001",
            key_type="user",
            key_value="user_001",
            action="login",
        )

        assert service.check_rate_limit(rate_key) is True

    def test_check_rate_limit_blocks_above_threshold(self):
        service = AuthService()

        rate_key = AuthRateLimitKey(
            enterprise_id="ent_001",
            key_type="user",
            key_value="user_rate_limit",
            action="login",
        )

        for _ in range(5):
            assert service.check_rate_limit(rate_key) is True

        assert service.check_rate_limit(rate_key) is False
