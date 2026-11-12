"""行业资料解析：字节 → 带来源定位的文本块 + 待识别图片。

只负责确定性的「拆」：不调模型、不做敏感扫描。上传内容不可信，所以每种格式都有硬上限
（文件大小、压缩包条目与解压体积、页数、字符数、图片数与像素），XML 拒绝 DTD / 实体声明。
超限一律截断并在 `warnings` 里留痕，不静默丢弃。
"""

from __future__ import annotations

import io
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import PurePosixPath
from xml.etree import ElementTree

from defusedxml import DefusedXmlException
from defusedxml.ElementTree import fromstring as safe_fromstring

from .schemas import ImageAsset, SourceChunk

TEXT_SUFFIXES = frozenset({".txt", ".md", ".markdown", ".csv"})
HTML_SUFFIXES = frozenset({".html", ".htm"})
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
SUPPORTED_SUFFIXES = TEXT_SUFFIXES | HTML_SUFFIXES | IMAGE_SUFFIXES | {".docx", ".pptx", ".xlsx", ".pdf"}
LEGACY_SUFFIXES = frozenset({".doc", ".ppt", ".xls"})

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_S = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

_MAX_XML_ENTRY_BYTES = 50 * 1024 * 1024
_MIN_EMBEDDED_IMAGE_SIDE = 64
_SCANNED_PAGE_TEXT_CHARS = 20


@dataclass(frozen=True)
class ParseLimits:
    max_file_bytes: int = 20 * 1024 * 1024
    max_chars_per_source: int = 400_000
    max_chunk_chars: int = 1600
    max_images_per_source: int = 20
    max_image_pixels: int = 40_000_000
    max_image_side: int = 1600
    max_pdf_pages: int = 300
    max_zip_entries: int = 5000
    max_zip_uncompressed_bytes: int = 200 * 1024 * 1024
    max_sheet_rows: int = 2000


@dataclass
class ParsedSource:
    chunks: list[SourceChunk] = field(default_factory=list)
    images: list[ImageAsset] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class SourceParseError(ValueError):
    """资料无法解析。`code` 是稳定的错误码；消息不含文档内容。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class _Extracted:
    blocks: list[tuple[str, str]] = field(default_factory=list)  # (locator, text)
    images: list[tuple[str, bytes]] = field(default_factory=list)  # (locator, raw bytes)
    warnings: list[str] = field(default_factory=list)

    def warn(self, code: str) -> None:
        if code not in self.warnings:
            self.warnings.append(code)


def source_suffix(name: str) -> str:
    return PurePosixPath(name.replace("\\", "/")).suffix.lower()


def parse_source(source_id: str, name: str, data: bytes, limits: ParseLimits | None = None) -> ParsedSource:
    """解析一份资料。抛 SourceParseError（不支持 / 损坏 / 超限）。"""
    limits = limits or ParseLimits()
    suffix = source_suffix(name)
    if suffix in LEGACY_SUFFIXES:
        raise SourceParseError("legacy_format", f"{suffix} 需先另存为新格式（.docx / .pptx / .xlsx）")
    if suffix not in SUPPORTED_SUFFIXES:
        raise SourceParseError("unsupported_format", f"不支持的文件类型：{suffix or '无扩展名'}")
    if not data:
        raise SourceParseError("empty_file", "文件为空")
    if len(data) > limits.max_file_bytes:
        raise SourceParseError("file_too_large", "文件超过大小上限")

    if suffix in TEXT_SUFFIXES:
        extracted = _extract_text(data)
    elif suffix in HTML_SUFFIXES:
        extracted = _extract_html(data)
    elif suffix in IMAGE_SUFFIXES:
        extracted = _Extracted(images=[("图片", data)])
    elif suffix == ".docx":
        extracted = _extract_docx(data, limits)
    elif suffix == ".pptx":
        extracted = _extract_pptx(data, limits)
    elif suffix == ".xlsx":
        extracted = _extract_xlsx(data, limits)
    else:
        extracted = _extract_pdf(data, limits)

    parsed = ParsedSource(warnings=list(extracted.warnings))
    parsed.chunks = _chunk(source_id, name, extracted.blocks, limits, parsed.warnings)
    standalone = suffix in IMAGE_SUFFIXES
    for locator, raw in extracted.images:
        if len(parsed.images) >= limits.max_images_per_source:
            _warn(parsed.warnings, "images_truncated")
            break
        normalized = _normalize_image(raw, limits, min_side=1 if standalone else _MIN_EMBEDDED_IMAGE_SIDE)
        if normalized is None:
            if standalone:
                raise SourceParseError("invalid_image", "图片无法读取或超过像素上限")
            _warn(parsed.warnings, "image_skipped")
            continue
        parsed.images.append(ImageAsset(
            image_id=f"{source_id}-i{len(parsed.images) + 1}", source_id=source_id, source_name=name,
            locator=locator, media_type="image/jpeg", data=normalized,
        ))
    if not parsed.chunks and not parsed.images:
        raise SourceParseError("no_content", "未能从文件中提取到任何内容")
    return parsed


def _warn(warnings: list[str], code: str) -> None:
    if code not in warnings:
        warnings.append(code)


# ---- chunking ----

def _chunk(source_id: str, name: str, blocks: list[tuple[str, str]], limits: ParseLimits, warnings: list[str]) -> list[SourceChunk]:
    chunks: list[SourceChunk] = []
    budget = limits.max_chars_per_source
    first = last = ""
    parts: list[str] = []
    size = 0

    def flush() -> None:
        nonlocal first, last, parts, size
        if parts:
            locator = first if first == last else f"{first} ~ {last}"
            chunks.append(SourceChunk(
                chunk_id=f"{source_id}-c{len(chunks) + 1}", source_id=source_id, source_name=name[:255],
                locator=locator[:120], text="\n".join(parts),
            ))
        first = last = ""
        parts, size = [], 0

    for locator, raw in blocks:
        text = _clean(raw)
        if not text:
            continue
        if budget <= 0:
            _warn(warnings, "text_truncated")
            break
        if len(text) > budget:
            text = text[:budget]
            _warn(warnings, "text_truncated")
        budget -= len(text)
        for piece in _split(text, limits.max_chunk_chars):
            if parts and size + len(piece) > limits.max_chunk_chars:
                flush()
            if not parts:
                first = locator
            last = locator
            parts.append(piece)
            size += len(piece) + 1
    flush()
    return chunks


def _split(text: str, width: int) -> list[str]:
    return [text[index:index + width] for index in range(0, len(text), width)]


_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _clean(text: str) -> str:
    text = _CONTROL_RE.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


# ---- text / html ----

def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig", "gb18030"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def _paragraph_blocks(text: str) -> list[tuple[str, str]]:
    paragraphs = [part for part in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if part.strip()]
    return [(f"第 {index} 段", part) for index, part in enumerate(paragraphs, start=1)]


def _extract_text(data: bytes) -> _Extracted:
    return _Extracted(blocks=_paragraph_blocks(_decode(data)))


class _HtmlText(HTMLParser):
    _SKIP = frozenset({"script", "style", "noscript", "template", "svg", "head"})
    _BLOCK = frozenset({"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "ul", "ol", "blockquote", "pre"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag in self._BLOCK:
            self.parts.append("\n\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in self._BLOCK:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if not self._skip_depth:
            self.parts.append(data)


def _extract_html(data: bytes) -> _Extracted:
    parser = _HtmlText()
    parser.feed(_decode(data))
    parser.close()
    return _Extracted(blocks=_paragraph_blocks("".join(parser.parts)))


# ---- OOXML helpers ----

def _open_zip(data: bytes, limits: ParseLimits) -> zipfile.ZipFile:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise SourceParseError("corrupt_file", "文件已损坏或不是有效的 Office 文档") from exc
    infos = archive.infolist()
    if len(infos) > limits.max_zip_entries or sum(info.file_size for info in infos) > limits.max_zip_uncompressed_bytes:
        archive.close()
        raise SourceParseError("archive_too_large", "文档解压后超过上限")
    return archive


def _read_xml(archive: zipfile.ZipFile, name: str) -> ElementTree.Element | None:
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > _MAX_XML_ENTRY_BYTES:
        raise SourceParseError("archive_too_large", "文档内部条目超过上限")
    raw = archive.read(info)
    try:
        # 由解析器本身拒绝 DTD / 实体声明：按字节查找 `<!DOCTYPE` 会被 UTF-16 等编码绕过。
        return safe_fromstring(raw, forbid_dtd=True)
    except DefusedXmlException as exc:
        raise SourceParseError("unsafe_xml", "文档包含不允许的 XML 声明") from exc
    except ElementTree.ParseError as exc:
        raise SourceParseError("corrupt_file", "文档内部结构损坏") from exc


def _relationships(archive: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    """part 的关系表：rId → (type, 解析后的包内路径)。"""
    directory, filename = posixpath.split(part)
    root = _read_xml(archive, posixpath.join(directory, "_rels", f"{filename}.rels"))
    result: dict[str, tuple[str, str]] = {}
    if root is None:
        return result
    for rel in root.iter(f"{_REL}Relationship"):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target", "")
        resolved = target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(directory, target))
        result[rel.get("Id", "")] = (rel.get("Type", ""), resolved)
    return result


def _numbered(names: list[str], pattern: str) -> list[str]:
    regex = re.compile(pattern)
    matched: list[tuple[int, str]] = []
    for name in names:
        match = regex.fullmatch(name)
        if not match:
            continue
        try:
            matched.append((int(match.group(1)), name))
        except ValueError:
            continue
    return [name for _, name in sorted(matched)]


def _media(archive: zipfile.ZipFile, path: str) -> bytes | None:
    try:
        info = archive.getinfo(path)
    except KeyError:
        return None
    return archive.read(info) if info.file_size <= _MAX_XML_ENTRY_BYTES else None


# ---- docx ----

def _docx_paragraph(node: ElementTree.Element) -> str:
    parts: list[str] = []
    for child in node.iter():
        if child.tag == f"{_W}t":
            parts.append(child.text or "")
        elif child.tag in (f"{_W}tab",):
            parts.append(" ")
        elif child.tag in (f"{_W}br", f"{_W}cr"):
            parts.append("\n")
    return "".join(parts)


def _docx_table(node: ElementTree.Element) -> str:
    rows: list[str] = []
    for row in node.iter(f"{_W}tr"):
        cells = [" ".join(_docx_paragraph(p).strip() for p in cell.iter(f"{_W}p")).strip() for cell in row.findall(f"{_W}tc")]
        if any(cells):
            rows.append(" | ".join(cells))
    return "\n".join(rows)


def _extract_docx(data: bytes, limits: ParseLimits) -> _Extracted:
    out = _Extracted()
    with _open_zip(data, limits) as archive:
        root = _read_xml(archive, "word/document.xml")
        if root is None:
            raise SourceParseError("corrupt_file", "不是有效的 Word 文档")
        body = root.find(f"{_W}body")
        paragraph = table = 0
        for node in (body if body is not None else []):
            if node.tag == f"{_W}p":
                paragraph += 1
                out.blocks.append((f"第 {paragraph} 段", _docx_paragraph(node)))
            elif node.tag == f"{_W}tbl":
                table += 1
                out.blocks.append((f"表格 {table}", _docx_table(node)))
        media = sorted(name for name in archive.namelist() if name.startswith("word/media/"))
        for index, name in enumerate(media, start=1):
            raw = _media(archive, name)
            if raw:
                out.images.append((f"文档内图片 {index}", raw))
    return out


# ---- pptx ----

def _extract_pptx(data: bytes, limits: ParseLimits) -> _Extracted:
    out = _Extracted()
    with _open_zip(data, limits) as archive:
        slides = _numbered(archive.namelist(), r"ppt/slides/slide([0-9]{1,6})\.xml")
        if not slides:
            raise SourceParseError("corrupt_file", "不是有效的 PowerPoint 文档")
        seen_media: set[str] = set()
        for number, part in enumerate(slides, start=1):
            root = _read_xml(archive, part)
            if root is None:
                continue
            lines = ["".join(node.text or "" for node in para.iter(f"{_A}t")) for para in root.iter(f"{_A}p")]
            out.blocks.append((f"第 {number} 张幻灯片", "\n".join(line for line in lines if line.strip())))
            for rel_type, target in _relationships(archive, part).values():
                if not rel_type.endswith("/image") or target in seen_media:
                    continue
                seen_media.add(target)
                raw = _media(archive, target)
                if raw:
                    out.images.append((f"第 {number} 张幻灯片内图片", raw))
    return out


# ---- xlsx ----

def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    root = _read_xml(archive, "xl/sharedStrings.xml")
    if root is None:
        return []
    return ["".join(node.text or "" for node in item.iter(f"{_S}t")) for item in root.iter(f"{_S}si")]


def _cell_text(cell: ElementTree.Element, shared: list[str]) -> str:
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{_S}t"))
    value = cell.findtext(f"{_S}v") or ""
    if kind == "s":
        try:
            return shared[int(value)]
        except (ValueError, IndexError):
            return ""
    return value


def _extract_xlsx(data: bytes, limits: ParseLimits) -> _Extracted:
    out = _Extracted()
    with _open_zip(data, limits) as archive:
        workbook = _read_xml(archive, "xl/workbook.xml")
        if workbook is None:
            raise SourceParseError("corrupt_file", "不是有效的 Excel 文档")
        rels = _relationships(archive, "xl/workbook.xml")
        shared = _shared_strings(archive)
        for sheet in workbook.iter(f"{_S}sheet"):
            target = rels.get(sheet.get(f"{_R}id", ""), ("", ""))[1]
            root = _read_xml(archive, target) if target else None
            if root is None:
                continue
            title = (sheet.get("name") or "Sheet")[:40]
            for count, row in enumerate(root.iter(f"{_S}row"), start=1):
                if count > limits.max_sheet_rows:
                    out.warn("rows_truncated")
                    break
                cells = [_cell_text(cell, shared).strip() for cell in row.findall(f"{_S}c")]
                if any(cells):
                    out.blocks.append((f"工作表「{title}」第 {row.get('r') or count} 行", " | ".join(cells)))
    return out


# ---- pdf ----

def _extract_pdf(data: bytes, limits: ParseLimits) -> _Extracted:
    from pypdf import PdfReader

    out = _Extracted()
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise SourceParseError("encrypted_file", "PDF 已加密，无法解析")
        pages = list(reader.pages)
    except SourceParseError:
        raise
    except Exception as exc:  # noqa: BLE001 — pypdf 对损坏文件抛的异常类型不固定
        raise SourceParseError("corrupt_file", "PDF 无法打开") from exc
    if len(pages) > limits.max_pdf_pages:
        pages = pages[:limits.max_pdf_pages]
        out.warn("pages_truncated")
    for number, page in enumerate(pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:  # noqa: BLE001
            text = ""
        out.blocks.append((f"第 {number} 页", text))
        if len(text.strip()) >= _SCANNED_PAGE_TEXT_CHARS:
            continue
        # 没有文本层的页多半是扫描件：取页内嵌入的图片交给图片识别。
        try:
            images = [image.data for image in page.images]
        except Exception:  # noqa: BLE001
            images = []
            out.warn("image_skipped")
        for raw in images:
            out.images.append((f"第 {number} 页图片", raw))
    return out


# ---- images ----

def _normalize_image(raw: bytes, limits: ParseLimits, *, min_side: int) -> bytes | None:
    """校验并归一化为受限尺寸的 JPEG（去元数据）。无法识别 / 过小 / 像素超限返回 None。"""
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(raw)) as image:
            width, height = image.size
            if width * height > limits.max_image_pixels or min(width, height) < min_side:
                return None
            image.load()
            if image.mode in ("RGBA", "LA", "P"):
                rgba = image.convert("RGBA")
                flattened = Image.new("RGB", rgba.size, (255, 255, 255))
                flattened.paste(rgba, mask=rgba.getchannel("A"))
                image = flattened
            else:
                image = image.convert("RGB")
            image.thumbnail((limits.max_image_side, limits.max_image_side))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=85)
            return buffer.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return None
