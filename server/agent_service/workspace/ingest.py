"""文档摄入器（AITEAM-260）——把原始字节变成可检索的 chunk 流。

本端只做轻量文本抽取 + 切分；真正的向量入库 (LightRAG / M1+) 留作后续接入。
这里的输出是 rag_document_id（本地确定性 ID）与 chunk_count，供检索 UI 显示。
"""

from __future__ import annotations

import io
import re
import zipfile
import xml.etree.ElementTree as ET
from uuid import uuid4


_WORD_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_CHUNK_SIZE = 800        # 字符/块（轻量启发式）
_CHUNK_OVERLAP = 80


def _safe_utf8(data: bytes) -> str:
    """尽力把字节解码为文本；失败时用 latin-1 兜底（不丢字节）。"""
    for enc in ("utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


def extract_pdf_text(data: bytes) -> str:
    """极简 PDF 文本抽取：仅保留可直接解码的文本片段（无 pypdf 依赖）。

    真实 PDF 解析留 M1+ 接 pypdf / pymupdf；这里做兜底：把可解码的文字段抽出即可，
    否则抛出 RuntimeError 让 ingestion 状态机落 error。
    """
    text = _safe_utf8(data)
    # 抽取 parenthesis 内的可见字符串（最粗粒度的启发式）
    pieces = re.findall(r"\((?:[^()\\]|\\.){2,}\)", text)
    cleaned: list[str] = []
    for p in pieces[1:-1]:              # 去掉首末（通常是字典）
        # 去转义
        p = re.sub(r"\\([nrtbf()\\])", lambda m: {"n": "\n", "r": "\r", "t": "\t", "f": "\f", "b": "\b"}.get(m.group(1), ""), p)
        p = p.replace("\\(", "(").replace("\\)", ")")
        if any(ch.isalpha() for ch in p):
            cleaned.append(p)
    out = _WS_RE.sub(" ", " ".join(cleaned)).strip()
    if not out.strip():
        raise RuntimeError("PDF text extraction produced no readable content (needs M1+ parser)")
    return out


def extract_docx_text(data: bytes) -> str:
    """从 .docx (OOXML) 抽取纯文本（仅依赖 zipfile + xml，无需 python-docx）。"""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        with zf.open("word/document.xml") as fh:
            tree = ET.parse(fh)
    body = tree.getroot().find("w:body", _WORD_NS)
    if body is None:
        return ""
    paragraphs: list[str] = []
    for p in body.findall("w:p", _WORD_NS):
        texts = [t.text or "" for t in p.findall(".//w:t", _WORD_NS)]
        if texts:
            paragraphs.append("".join(texts))
    return "\n".join(paragraphs)


def extract_text(data: bytes, content_type: str | None = None, extension: str = "") -> str:
    """按类型分发文本抽取。"""
    ext = extension.lower().lstrip(".")
    ct = (content_type or "").lower()

    if ext in ("txt", "md", "markdown", "csv", "json", "log", "text"):
        return _safe_utf8(data)
    if ct.startswith("text/") or ct in ("application/json", "application/xml"):
        return _safe_utf8(data)

    if ext == "docx" or ct in (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ):
        try:
            text = extract_docx_text(data)
            return _WS_RE.sub(" ", text).strip()
        except Exception as e:
            raise RuntimeError(f"DOCX parse failed: {e}") from e

    if ext == "pdf" or ct == "application/pdf":
        return extract_pdf_text(data)

    # 默认尝试 UTF-8
    return _safe_utf8(data)


def html_to_text(html: str) -> str:
    """去掉 HTML 标签，归一化空白（无外部依赖）。保留 <title> 作为首行。"""
    title = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
    body = _HTML_TAG_RE.sub(" ", html)
    body = _WS_RE.sub(" ", body).strip()
    if title:
        t = _WS_RE.sub(" ", title.group(1)).strip()
        if t:
            body = f"{t}\n\n{body}"
    return body


def chunk_text(text: str, size: int = _CHUNK_SIZE, overlap: int = _CHUNK_OVERLAP) -> list[str]:
    """把长文本按 size+overlap 滑动窗口切块（无 LangChain 依赖）。"""
    text = text.strip()
    if not text:
        return []
    if len(text) <= size:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + size, len(text))
        chunks.append(text[start:end])
        start += max(size - overlap, 1)
    return chunks


def build_rag_document_id() -> str:
    return f"rag-{uuid4().hex[:16]}"


def extract_text_only(data: bytes, content_type: str | None, filename: str) -> str:
    """对外入口：抽取文本。"""
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
    return extract_text(data, content_type, ext)
