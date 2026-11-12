"""子进程隔离解析：结果与进程内解析一致；超时 / 崩溃 / 异常输出都变成稳定的 SourceParseError。"""

from __future__ import annotations

import pytest

from shared.solution_authoring import isolated_parse
from shared.solution_authoring.isolated_parse import parse_source_isolated
from shared.solution_authoring.parsing import (
    ParseLimits,
    SourceParseError,
    parse_source,
)
from tests.shared.solution_authoring_fixtures import (
    docx_bytes,
    png_bytes,
    scanned_pdf_bytes,
    text_pdf_bytes,
)


@pytest.mark.parametrize(
    ("name", "data"),
    [
        ("手册.md", "# 来料检验\n\n所有来料必须检验。".encode()),
        ("手册.docx", docx_bytes(["来料检验流程", "不合格品隔离"])),
        ("手册.pdf", text_pdf_bytes(["第一页的来料检验说明文字足够长", "第二页的不合格品处理说明文字"])),
        ("扫描.pdf", scanned_pdf_bytes()),
        ("图.png", png_bytes(200, 120)),
    ],
)
def test_isolated_result_matches_in_process_parse(name, data):
    expected = parse_source("s1", name, data)
    actual = parse_source_isolated("s1", name, data)
    assert actual.chunks == expected.chunks
    assert actual.images == expected.images
    assert actual.warnings == expected.warnings


def test_limits_are_passed_to_the_child():
    data = text_pdf_bytes([f"第 {n} 页的说明文字足够长，用来避免被当作扫描页" for n in range(3)])
    parsed = parse_source_isolated("s1", "手册.pdf", data, ParseLimits(max_pdf_pages=1))
    assert "pages_truncated" in parsed.warnings
    assert {chunk.locator for chunk in parsed.chunks} == {"第 1 页"}


@pytest.mark.parametrize(
    ("name", "data", "code"),
    [("方案.exe", b"MZ", "unsupported_format"), ("坏.pdf", b"%PDF-1.4 garbage", "corrupt_file"), ("空.txt", b"", "empty_file")],
)
def test_parse_errors_from_the_child_keep_their_code(name, data, code):
    with pytest.raises(SourceParseError) as raised:
        parse_source_isolated("s1", name, data)
    assert raised.value.code == code


def _bootstrap(monkeypatch, code: str) -> None:
    monkeypatch.setattr(isolated_parse, "_BOOTSTRAP", code)


def test_a_hanging_parser_is_killed_at_the_time_limit(monkeypatch):
    _bootstrap(monkeypatch, "import time; time.sleep(60)")
    with pytest.raises(SourceParseError) as raised:
        parse_source_isolated("s1", "a.md", b"x", timeout_seconds=0.5)
    assert raised.value.code == "parse_timeout"


@pytest.mark.parametrize(
    "code",
    [
        "import os; os._exit(3)",  # 崩溃
        "pass",  # 没有输出
        "import sys; sys.stdout.write('not json')",
        "import sys; sys.stdout.write('{\"chunks\": [{\"bad\": 1}], \"images\": [], \"warnings\": []}')",
    ],
)
def test_crashes_and_malformed_output_become_parse_failed(monkeypatch, code):
    _bootstrap(monkeypatch, code)
    with pytest.raises(SourceParseError) as raised:
        parse_source_isolated("s1", "a.md", b"x")
    assert raised.value.code == "parse_failed"


def test_the_child_does_not_inherit_secrets_from_the_host(monkeypatch):
    monkeypatch.setenv("OPERATION_DB_URL", "postgresql://u:p@h/db")
    _bootstrap(
        monkeypatch,
        "import os, sys, json; sys.stdout.write(json.dumps({'chunks': [], 'images': [], "
        "'warnings': sorted(os.environ)}))",
    )
    parsed = parse_source_isolated("s1", "a.md", b"x")
    assert "OPERATION_DB_URL" not in parsed.warnings
    assert set(parsed.warnings) <= set(isolated_parse._ENV_ALLOWLIST) | {"__CF_USER_TEXT_ENCODING", "LC_CTYPE"}
