"""行业资料解析：各格式主路径、来源定位、上限与恶意输入。"""

from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image

from shared.solution_authoring.parsing import (
    ParseLimits,
    SourceParseError,
    parse_source,
)
from tests.shared.solution_authoring_fixtures import (
    docx_bytes,
    png_bytes,
    pptx_bytes,
    scanned_pdf_bytes,
    text_pdf_bytes,
    xlsx_bytes,
)


def _error_code(name: str, data: bytes, limits: ParseLimits | None = None) -> str:
    with pytest.raises(SourceParseError) as raised:
        parse_source("s1", name, data, limits)
    return raised.value.code


def test_text_is_chunked_with_paragraph_locators():
    parsed = parse_source("s1", "手册.md", "第一段内容\n\n第二段内容\n\n\n\n第三段".encode())
    assert [chunk.chunk_id for chunk in parsed.chunks] == ["s1-c1"]
    assert parsed.chunks[0].locator == "第 1 段 ~ 第 3 段"
    assert parsed.chunks[0].text == "第一段内容\n第二段内容\n第三段"
    assert parsed.chunks[0].source_name == "手册.md"
    assert parsed.images == [] and parsed.warnings == []


def test_text_falls_back_to_gb18030():
    parsed = parse_source("s1", "旧文档.txt", "来料检验流程".encode("gb18030"))
    assert parsed.chunks[0].text == "来料检验流程"


def test_long_text_splits_into_bounded_chunks_with_unique_ids():
    limits = ParseLimits(max_chunk_chars=50)
    text = "\n\n".join(f"第{index}条规定：" + "检" * 30 for index in range(1, 9))
    parsed = parse_source("s1", "规程.txt", text.encode(), limits)
    assert len(parsed.chunks) > 3
    assert len({chunk.chunk_id for chunk in parsed.chunks}) == len(parsed.chunks)
    assert all(len(chunk.text) <= 50 for chunk in parsed.chunks)


def test_text_over_source_budget_is_truncated_with_warning():
    parsed = parse_source("s1", "a.txt", ("字" * 500).encode(), ParseLimits(max_chars_per_source=120, max_chunk_chars=100))
    assert sum(len(chunk.text) for chunk in parsed.chunks) == 120
    assert parsed.warnings == ["text_truncated"]


def test_html_drops_script_and_style():
    html = "<html><head><title>T</title><style>p{color:red}</style></head><body><p>不合格品处理</p><script>alert('x')</script><div>返工 &amp; 报废</div></body></html>"
    parsed = parse_source("s1", "page.html", html.encode())
    text = "\n".join(chunk.text for chunk in parsed.chunks)
    assert "不合格品处理" in text and "返工 & 报废" in text
    assert "alert" not in text and "color" not in text


def test_docx_paragraphs_table_and_images():
    data = docx_bytes(["质量手册", "来料必须检验"], table=[["项目", "标准"], ["外观", "无划痕"]], images=[png_bytes(), png_bytes(8, 8)])
    parsed = parse_source("s1", "质量手册.docx", data)
    text = "\n".join(chunk.text for chunk in parsed.chunks)
    assert "来料必须检验" in text and "外观 | 无划痕" in text
    assert parsed.chunks[0].locator == "第 1 段 ~ 表格 1"
    # 8x8 的装饰小图被跳过并留痕；正常图片归一化为 JPEG。
    assert len(parsed.images) == 1 and parsed.warnings == ["image_skipped"]
    image = parsed.images[0]
    assert (image.image_id, image.locator, image.media_type) == ("s1-i1", "文档内图片 1", "image/jpeg")
    assert Image.open(io.BytesIO(image.data)).format == "JPEG"


def test_pptx_slides_are_ordered_numerically_and_images_located():
    slides = [[f"第{number}页标题"] for number in range(1, 12)]
    parsed = parse_source("s1", "培训.pptx", pptx_bytes(slides, images={10: png_bytes()}), ParseLimits(max_chunk_chars=8))
    assert [chunk.locator for chunk in parsed.chunks][:3] == ["第 1 张幻灯片", "第 2 张幻灯片", "第 3 张幻灯片"]
    assert parsed.chunks[9].text == "第10页标题" and parsed.chunks[9].locator == "第 10 张幻灯片"
    assert [image.locator for image in parsed.images] == ["第 10 张幻灯片内图片"]


def test_xlsx_rows_carry_sheet_and_row_locators():
    data = xlsx_bytes({"巡检记录": [["日期", "结果"], ["周一", "合格"]], "汇总": [["合格率", "98%"]]})
    parsed = parse_source("s1", "巡检.xlsx", data, ParseLimits(max_chunk_chars=12))
    located = {chunk.locator: chunk.text for chunk in parsed.chunks}
    assert located["工作表「巡检记录」第 2 行"] == "周一 | 合格"
    assert located["工作表「汇总」第 1 行"] == "合格率 | 98%"


def test_xlsx_rows_over_limit_are_truncated_with_warning():
    data = xlsx_bytes({"S": [[f"r{index}"] for index in range(10)]})
    parsed = parse_source("s1", "a.xlsx", data, ParseLimits(max_sheet_rows=3))
    assert "rows_truncated" in parsed.warnings
    assert "r3" not in "\n".join(chunk.text for chunk in parsed.chunks)


def test_pdf_text_layer_is_located_by_page():
    parsed = parse_source("s1", "std.pdf", text_pdf_bytes(["Incoming inspection procedure", "Nonconforming product handling"]), ParseLimits(max_chunk_chars=40))
    assert [(chunk.locator, chunk.text) for chunk in parsed.chunks] == [
        ("第 1 页", "Incoming inspection procedure"),
        ("第 2 页", "Nonconforming product handling"),
    ]
    assert parsed.images == []


def test_scanned_pdf_yields_page_images_instead_of_text():
    parsed = parse_source("s1", "扫描.pdf", scanned_pdf_bytes(2))
    assert parsed.chunks == []
    assert [image.locator for image in parsed.images] == ["第 1 页图片", "第 2 页图片"]


def test_pdf_pages_over_limit_are_truncated_with_warning():
    parsed = parse_source("s1", "a.pdf", text_pdf_bytes([f"page number {index}" for index in range(5)]), ParseLimits(max_pdf_pages=2, max_chunk_chars=20))
    assert len(parsed.chunks) == 2 and parsed.warnings == ["pages_truncated"]


def test_standalone_image_becomes_one_asset():
    parsed = parse_source("s1", "现场.png", png_bytes(2400, 1200))
    assert parsed.chunks == [] and len(parsed.images) == 1
    assert max(Image.open(io.BytesIO(parsed.images[0].data)).size) == 1600


def test_images_over_limit_are_truncated_with_warning():
    data = docx_bytes(["正文"], images=[png_bytes(color=(index, 0, 0)) for index in range(5)])
    parsed = parse_source("s1", "a.docx", data, ParseLimits(max_images_per_source=2))
    assert len(parsed.images) == 2 and "images_truncated" in parsed.warnings


@pytest.mark.parametrize(
    ("name", "data", "code"),
    [
        ("旧版.doc", b"x", "legacy_format"),
        ("a.exe", b"x", "unsupported_format"),
        ("noext", b"x", "unsupported_format"),
        ("a.txt", b"", "empty_file"),
        ("a.txt", b"   \n\n  ", "no_content"),
        ("a.docx", b"not a zip", "corrupt_file"),
        ("a.pptx", docx_bytes(["x"]), "corrupt_file"),
        ("a.xlsx", docx_bytes(["x"]), "corrupt_file"),
        ("a.pdf", b"%PDF-1.4 broken", "corrupt_file"),
        ("a.png", b"not an image", "invalid_image"),
    ],
)
def test_rejected_inputs_have_stable_codes(name, data, code):
    assert _error_code(name, data) == code


def test_file_over_size_limit_is_rejected():
    assert _error_code("a.txt", b"x" * 11, ParseLimits(max_file_bytes=10)) == "file_too_large"


def test_zip_bomb_is_rejected_before_extraction():
    bomb = io.BytesIO()
    with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"0" * 2_000_000)
    assert len(bomb.getvalue()) < 10_000
    assert _error_code("a.docx", bomb.getvalue(), ParseLimits(max_zip_uncompressed_bytes=1_000_000)) == "archive_too_large"


def test_zip_with_too_many_entries_is_rejected():
    assert _error_code("a.docx", docx_bytes(["x"], images=[png_bytes()] * 3), ParseLimits(max_zip_entries=2)) == "archive_too_large"


@pytest.mark.parametrize("encoding", ["utf-8", "utf-16"])  # UTF-16 下按字节找不到 `<!DOCTYPE`，必须由解析器拒绝
def test_xml_with_entity_declaration_is_rejected(encoding):
    document = (
        f'<?xml version="1.0" encoding="{encoding}"?><!DOCTYPE d [<!ENTITY a "aaaa">]>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>&a;</w:t></w:r></w:p></w:body></w:document>"
    )
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("word/document.xml", document.encode(encoding))
    assert _error_code("a.docx", payload.getvalue()) == "unsafe_xml"


def test_malformed_xml_is_reported_as_corrupt():
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("word/document.xml", b"<w:document")
    assert _error_code("a.docx", payload.getvalue()) == "corrupt_file"


def test_oversized_image_pixels_are_rejected_for_standalone_and_skipped_when_embedded():
    limits = ParseLimits(max_image_pixels=10_000)
    big = png_bytes(400, 400)
    assert _error_code("a.png", big, limits) == "invalid_image"
    parsed = parse_source("s1", "a.docx", docx_bytes(["正文"], images=[big]), limits)
    assert parsed.images == [] and parsed.warnings == ["image_skipped"]


def test_error_messages_never_echo_document_content():
    with pytest.raises(SourceParseError) as raised:
        parse_source("s1", "a.docx", b"SECRET-CONTENT-not-a-zip")
    assert "SECRET-CONTENT" not in str(raised.value)
