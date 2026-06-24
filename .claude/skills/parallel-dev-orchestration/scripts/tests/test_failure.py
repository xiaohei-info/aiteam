# tests/test_failure.py
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from core import is_unrecoverable


def test_none_and_empty_are_recoverable():
    assert is_unrecoverable(None) is False
    assert is_unrecoverable("") is False


def test_quota_balance_keywords():
    assert is_unrecoverable("API quota exhausted")
    assert is_unrecoverable("insufficient balance")
    assert is_unrecoverable("配额已用完")
    assert is_unrecoverable("账户余额不足")


def test_case_insensitive():
    assert is_unrecoverable("QUOTA EXCEEDED")
    assert is_unrecoverable("Insufficient Credit")


def test_crash_and_auth_keywords():
    assert is_unrecoverable("worker process crashed")
    assert is_unrecoverable("进程崩溃")
    assert is_unrecoverable("401 Unauthorized")
    assert is_unrecoverable("rate limit exceeded")


def test_ordinary_logic_failures_are_recoverable():
    assert is_unrecoverable("test failed: assertion error") is False
    assert is_unrecoverable("缺少 PR 产物") is False
    assert is_unrecoverable("Worker run failed") is False
