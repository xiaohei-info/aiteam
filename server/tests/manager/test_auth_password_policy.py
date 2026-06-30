"""auth_password_password_policy 单元测试（非集成；纯函数）。"""

from __future__ import annotations

import os
import time

import pytest

from manager_service import auth_password_policy as pp
from shared.errors import ValidationProblem


class TestValidatePasswordComplexity:
    def test_valid_password_passes(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        pp.validate_password_complexity("Str0ng!Pass")

    def test_too_short(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        with pytest.raises(ValidationProblem) as exc:
            pp.validate_password_complexity("Aa1!")
        assert "min length 8" in exc.value.detail

    def test_missing_uppercase(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        with pytest.raises(ValidationProblem) as exc:
            pp.validate_password_complexity("lower1!case")
        assert "require uppercase" in exc.value.detail

    def test_missing_lowercase(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        with pytest.raises(ValidationProblem) as exc:
            pp.validate_password_complexity("UPPER1!CASE")
        assert "require lowercase" in exc.value.detail

    def test_missing_digit(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        with pytest.raises(ValidationProblem) as exc:
            pp.validate_password_complexity("NoDigits!!")
        assert "require digit" in exc.value.detail

    def test_missing_symbol(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        with pytest.raises(ValidationProblem) as exc:
            pp.validate_password_complexity("NoSymbo1s")
        assert "require symbol" in exc.value.detail

    def test_empty_string_reports_min_length(self, monkeypatch):
        monkeypatch.setattr(pp, "min_length", lambda: 8)
        with pytest.raises(ValidationProblem) as exc:
            pp.validate_password_complexity("")
        assert "min length" in exc.value.detail

    def test_min_length_env_override(self, monkeypatch):
        os.environ["MANAGER_PASSWORD_MIN_LENGTH"] = "12"
        try:
            assert pp.min_length() == 12
        finally:
            os.environ.pop("MANAGER_PASSWORD_MIN_LENGTH", None)


class TestPasswordExpired:
    def test_none_never_expired(self, monkeypatch):
        monkeypatch.setattr(pp, "max_age_days", lambda: 90)
        assert pp.password_expired(password_changed_at=None, now=10**9) is False

    def test_fresh_not_expired(self, monkeypatch):
        monkeypatch.setattr(pp, "max_age_days", lambda: 90)
        now = time.time()
        assert pp.password_expired(password_changed_at=now - 86400, now=now) is False

    def test_stale_expired(self, monkeypatch):
        monkeypatch.setattr(pp, "max_age_days", lambda: 90)
        now = time.time()
        assert pp.password_expired(password_changed_at=now - 86400 * 120, now=now) is True

    def test_expired_raises_forbidden(self, monkeypatch):
        from shared.errors import Forbidden
        monkeypatch.setattr(pp, "max_age_days", lambda: 90)
        now = time.time()
        with pytest.raises(Forbidden):
            pp.assert_password_not_expired(password_changed_at=now - 86400 * 200, now=now)
