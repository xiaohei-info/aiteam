"""企业密码策略（issue AITEAM-253，「密码策略（复杂度/过期）」缺口）。

口径（03 9.3 红线：Manager 不存可逆密码；本策略只关涉密码强度与生命周期）：
- 新建/重置密码必须过复杂度校验（长度 + 字符类别）。
- 登录时校验密码年龄；超出 max_age_days 则拒绝并要求走 reset（9.4 首登重置口径复用）。
- 校验失败抛 shared.errors 子类（-> problem+json），不含密码明文。

策略参数可调（环境变量），默认对齐 NIST/OWASP 保守基线。
"""

from __future__ import annotations

import os
import re
import time

from shared.errors import Forbidden, ValidationProblem

class PasswordResetRequired(Forbidden):
    code = "password_reset_required"


class PasswordExpired(Forbidden):
    code = "password_expired"


MIN_LENGTH_DEFAULT = 8
MAX_AGE_DAYS_DEFAULT = 90


def _env_int(name, default):
    raw = os.getenv(name, "").strip()
    if raw.isdigit():
        return int(raw)
    return default


def min_length():
    return _env_int("MANAGER_PASSWORD_MIN_LENGTH", MIN_LENGTH_DEFAULT)


def max_age_days():
    return _env_int("MANAGER_PASSWORD_MAX_AGE_DAYS", MAX_AGE_DAYS_DEFAULT)


_RE_UPPER = re.compile(r"[A-Z]")
_RE_LOWER = re.compile(r"[a-z]")
_RE_DIGIT = re.compile(r"\d")
_RE_SYMBOL = re.compile(r"[^A-Za-z0-9]")


def validate_password_complexity(password):
    """校验新建/重置密码的复杂度。失败抛 ValidationProblem(422)。"""
    problems = []
    if not isinstance(password, str) or len(password) < min_length():
        problems.append("min length %d" % min_length())
    if not _RE_LOWER.search(password or ""):
        problems.append("require lowercase")
    if not _RE_UPPER.search(password or ""):
        problems.append("require uppercase")
    if not _RE_DIGIT.search(password or ""):
        problems.append("require digit")
    if not _RE_SYMBOL.search(password or ""):
        problems.append("require symbol")
    if problems:
        raise ValidationProblem("password policy violation: " + ", ".join(problems))


def password_expired(*, password_changed_at, now=None):
    """True 表示密码已过最大寿命。"""
    if password_changed_at is None:
        return False
    now = now or time.time()
    # password_changed_at 从 DB 来时是 datetime 对象(psycopg3 默认),需转 timestamp
    if hasattr(password_changed_at, "timestamp"):
        password_changed_at = password_changed_at.timestamp()
    return (now - password_changed_at) / 86400.0 > max_age_days()


def assert_password_not_expired(*, password_changed_at, now=None):
    """密码过期时抛 Forbidden(403 reset required)。"""
    if password_expired(password_changed_at=password_changed_at, now=now):
        raise PasswordExpired("password expired (%dd); reset required" % max_age_days())
