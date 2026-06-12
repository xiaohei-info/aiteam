"""Task 2 — document_parser.extract_text 多格式抽取。"""

from __future__ import annotations

import io
import zipfile

import pytest

from team_panel.integration.document_parser import (
    UnsupportedFormatError,
    extract_text,
)


def test_text_formats_return_raw(tmp_path):
    for name, body in [("a.md", "# 标题\n正文"), ("b.txt", "hello"),
                       ("c.csv", "x,y\n1,2"), ("d.json", '{"k":1}')]:
        f = tmp_path / name
        f.write_text(body, encoding="utf-8")
        assert extract_text(f) == body


def test_unknown_suffix_falls_back_to_text(tmp_path):
    f = tmp_path / "note.weird"
    f.write_text("plain content", encoding="utf-8")
    assert extract_text(f) == "plain content"


def test_pdf_is_unsupported(tmp_path):
    f = tmp_path / "doc.pdf"
    f.write_bytes(b"%PDF-1.4 ...")
    with pytest.raises(UnsupportedFormatError):
        extract_text(f)


def test_missing_file_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        extract_text(tmp_path / "nope.txt")


def _make_docx(path, paragraphs):
    """Build a minimal valid .docx with the given paragraph texts."""
    ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    body = "".join(
        f'<w:p><w:r><w:t>{t}</w:t></w:r></w:p>' for t in paragraphs
    )
    document = (
        f'<?xml version="1.0"?>'
        f'<w:document xmlns:w="{ns}"><w:body>{body}</w:body></w:document>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", document)
    path.write_bytes(buf.getvalue())


def test_docx_extracts_paragraph_text(tmp_path):
    f = tmp_path / "report.docx"
    _make_docx(f, ["第一段内容", "第二段内容"])
    out = extract_text(f)
    assert "第一段内容" in out
    assert "第二段内容" in out
