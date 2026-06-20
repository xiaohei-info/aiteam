"""A3 验收：cron 表达式解析与到点判定（runtime 无关、非 hermes cron）。

覆盖标准 5 字段 cron 的核心语义：单值、`*`、`*/N`、区间、区间步长、列表、越界/非法报错。
到点判定用 match_cron 对构造的 datetime 判真/判假。weekday 0=Sunday 的换算单测守。
"""

from datetime import datetime

import pytest

from agent_service.loop.cron import CronError, match_cron, parse_cron


def test_parse_star_matches_anything():
    parsed = parse_cron("* * * * *")
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 30))
    assert match_cron(parsed, datetime(2026, 1, 1, 0, 0))


def test_parse_exact_minute_hour():
    parsed = parse_cron("30 12 * * *")
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 30))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 31))
    assert not match_cron(parsed, datetime(2026, 6, 20, 13, 30))


def test_parse_step_every_15_minutes():
    parsed = parse_cron("*/15 * * * *")
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 0))
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 15))
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 45))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 7))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 46))


def test_parse_range():
    parsed = parse_cron("0 9-17 * * *")  # 每小时整点，9 点到 17 点
    assert match_cron(parsed, datetime(2026, 6, 20, 9, 0))
    assert match_cron(parsed, datetime(2026, 6, 20, 17, 0))
    assert not match_cron(parsed, datetime(2026, 6, 20, 8, 0))
    assert not match_cron(parsed, datetime(2026, 6, 20, 18, 0))


def test_parse_range_with_step():
    parsed = parse_cron("10-50/10 * * * *")  # 10,20,30,40,50
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 20))
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 50))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 0))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 5))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 55))


def test_parse_list():
    parsed = parse_cron("0,30 * * * *")
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 0))
    assert match_cron(parsed, datetime(2026, 6, 20, 12, 30))
    assert not match_cron(parsed, datetime(2026, 6, 20, 12, 15))


def test_parse_month_and_day():
    parsed = parse_cron("0 0 1 1 *")  # 每年 1 月 1 日 0:00
    assert match_cron(parsed, datetime(2026, 1, 1, 0, 0))
    assert not match_cron(parsed, datetime(2026, 1, 1, 0, 1))
    assert not match_cron(parsed, datetime(2026, 2, 1, 0, 0))


def test_weekday_sunday_is_zero():
    """cron weekday 0=Sunday。Python weekday() 0=Monday；换算 (wd+1)%7。

    2026-06-21 是周日（Python weekday()=6 -> cron 0）。
    表达式 `0 0 * * 0`（每周日 0:00）应命中。
    """
    parsed = parse_cron("0 0 * * 0")
    assert match_cron(parsed, datetime(2026, 6, 21, 0, 0))  # 周日
    assert not match_cron(parsed, datetime(2026, 6, 22, 0, 0))  # 周一


def test_weekday_list_monday_friday():
    """0,5 -> cron 周日与周五。2026-06-19 周五(Python wd=4 -> cron 5)、06-21 周日(cron 0)。"""
    parsed = parse_cron("0 12 * * 0,5")
    assert match_cron(parsed, datetime(2026, 6, 19, 12, 0))  # 周五
    assert match_cron(parsed, datetime(2026, 6, 21, 12, 0))  # 周日
    assert not match_cron(parsed, datetime(2026, 6, 22, 12, 0))  # 周一


def test_invalid_field_count():
    with pytest.raises(CronError):
        parse_cron("* * * *")  # 4 字段
    with pytest.raises(CronError):
        parse_cron("* * * * * *")  # 6 字段


def test_invalid_out_of_range():
    with pytest.raises(CronError):
        parse_cron("60 * * * *")  # minute 60
    with pytest.raises(CronError):
        parse_cron("* 24 * * *")  # hour 24
    with pytest.raises(CronError):
        parse_cron("* * 0 * *")  # day 0
    with pytest.raises(CronError):
        parse_cron("* * * 13 *")  # month 13
    with pytest.raises(CronError):
        parse_cron("* * * * 7")  # weekday 7


def test_invalid_syntax():
    with pytest.raises(CronError):
        parse_cron("abc * * * *")
    with pytest.raises(CronError):
        parse_cron("*/0 * * * *")  # 步长 0
    with pytest.raises(CronError):
        parse_cron("5-3 * * * *")  # 区间反向


def test_list_with_mixed_items():
    """列表里混单值、区间、步长。"""
    parsed = parse_cron("0,15,30-45/15 * * * *")  # 0,15,30,45
    for m in (0, 15, 30, 45):
        assert match_cron(parsed, datetime(2026, 6, 20, 12, m))
    for m in (5, 10, 46, 59):
        assert not match_cron(parsed, datetime(2026, 6, 20, 12, m))
