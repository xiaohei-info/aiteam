"""Document text extraction for knowledge-base ingestion.

Per 调研方案 D5: AI Team 不再用 ``read_text(utf-8)`` 把任意文件当纯文本读，
按格式提取真实文本后交给 LightRAG 切块/向量化。

Good-taste 取舍：不绑定 LightRAG 的重解析管线（pdf 需 mineru/docling 外部引擎、
docx 需 IR 构建）。文本类直接读；``.docx`` 本质是 zip+xml，用 stdlib 提取
``<w:t>`` 文本即可，零依赖且可靠；尚不支持的二进制格式（pdf/doc）显式报错并落到
文档 error 状态，给出可操作信息，绝不静默写入损坏内容。
"""

from __future__ import annotations

import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree

# 文本类格式：直接按 UTF-8 读取（容错替换非法字节）。
_TEXT_SUFFIXES = {
    ".txt", ".md", ".markdown", ".csv", ".json", ".log",
    ".html", ".htm", ".yaml", ".yml", ".text",
}

# WordprocessingML 文本节点命名空间。
_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class UnsupportedFormatError(ValueError):
    """Raised when a file's format cannot be extracted without extra engines."""


def extract_text(path: str | Path) -> str:
    """Extract plain text from a knowledge document file.

    Returns the document's text. Raises ``UnsupportedFormatError`` for formats
    that need a parser engine we have not enabled (pdf/doc), and
    ``FileNotFoundError`` when the file is missing.
    """
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"document file not found: {p}")
    suffix = p.suffix.lower()

    if suffix in _TEXT_SUFFIXES:
        return p.read_text(encoding="utf-8", errors="replace")
    if suffix == ".docx":
        return _extract_docx(p)
    if suffix in (".pdf", ".doc", ".ppt", ".pptx", ".xls", ".xlsx"):
        raise UnsupportedFormatError(
            f"格式 {suffix} 需配置解析引擎（当前仅支持文本类与 .docx）"
        )
    # 未知扩展名：保守按文本兜底（多数情况是纯文本日志/配置）。
    return p.read_text(encoding="utf-8", errors="replace")


def _extract_docx(p: Path) -> str:
    """Pull visible paragraph text out of a .docx (OOXML zip), stdlib-only."""
    try:
        with zipfile.ZipFile(p) as zf:
            xml = zf.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise UnsupportedFormatError(f".docx 解析失败：{exc}") from exc

    root = ElementTree.fromstring(xml)
    paragraphs: list[str] = []
    for para in root.iter(f"{_W_NS}p"):
        runs = [node.text or "" for node in para.iter(f"{_W_NS}t")]
        line = "".join(runs).strip()
        if line:
            paragraphs.append(line)
    text = "\n".join(paragraphs)
    # 折叠多余空行。
    return re.sub(r"\n{3,}", "\n\n", text).strip()
