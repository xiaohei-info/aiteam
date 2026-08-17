"""知识文档文本提取（issue #416，04 §6.6；D21）。

按格式提取真实文本供后续切块/向量化。与旧 app/ 风格割裂——不沿用旧 router 单文件巨型实现，
本模块仅负责"字节 → 纯文本"；intake 编排、状态机、路由在 knowledge_intake_service/routes。

Good-taste：文本类/HTML/URL 走 stdlib（零依赖）；.docx 用 zip+xml stdlib；.pdf 走 PyPDF2
（轻量、纯 Python、无 native 依赖）。尚不支持的格式显式抛 UnsupportedFormatError，由上层落到
文档 error 状态，绝不静默写入损坏内容。
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
    """格式需配置解析引擎（当前不支持）时抛。"""


def extract_text(path: str | Path) -> str:
    """按格式提取纯文本。抛 UnsupportedFormatError / FileNotFoundError。"""
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"document file not found: {p}")
    suffix = p.suffix.lower()
    if suffix in _TEXT_SUFFIXES:
        return p.read_text(encoding="utf-8", errors="replace")
    if suffix == ".docx":
        return _extract_docx(p)
    if suffix == ".pdf":
        return _extract_pdf(p)
    if suffix in (".doc", ".ppt", ".pptx", ".xls", ".xlsx"):
        raise UnsupportedFormatError(
            f"格式 {suffix} 需配置解析引擎（当前支持文本类/.docx/.pdf）"
        )
    # 未知扩展名：保守按文本兜底（多数为纯文本日志/配置）。
    return p.read_text(encoding="utf-8", errors="replace")


def _extract_docx(p: Path) -> str:
    """从 .docx（OOXML zip）提取段落文本，stdlib-only。"""
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
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _extract_pdf(p: Path) -> str:
    """从 PDF 提取文本（PyPDF2）。抛 UnsupportedFormatError 在解析失败时。"""
    try:
        from PyPDF2 import PdfReader
    except ImportError as exc:  # PyPDF2 未装时明确报错，不静默降级
        raise UnsupportedFormatError(
            "PDF 解析需安装 PyPDF2（pip install PyPDF2）"
        ) from exc
    try:
        reader = PdfReader(str(p))
    except Exception as exc:
        raise UnsupportedFormatError(f"PDF 打开失败：{exc}") from exc
    parts: list[str] = []
    for page in reader.pages:
        try:
            t = page.extract_text() or ""
        except Exception:
            t = ""
        t = t.strip()
        if t:
            parts.append(t)
    text = "\n\n".join(parts)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ── HTML import support（URL ingestion） ──────────────────────────────────

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)
_HTML_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def html_to_text(html: str) -> str:
    """去 HTML 标签/注释、归一化空白（零依赖）。"""
    if not html:
        return ""
    text = _HTML_COMMENT_RE.sub(" ", html)
    text = _HTML_TAG_RE.sub(" ", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
                .replace("&lt;", "<").replace("&gt;", ">")
                .replace("&quot;", '"').replace("&#39;", "'"))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    m = _HTML_TITLE_RE.search(html)
    if m:
        t = _HTML_TAG_RE.sub(" ", m.group(1))
        t = re.sub(r"\s+", " ", t).strip()
        if t:
            text = f"{t}\n\n{text}"
    return text
