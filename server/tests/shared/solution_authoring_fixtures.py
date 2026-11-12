"""行业文档生成测试夹具：在内存里造最小的 docx / pptx / xlsx / pdf / 图片。"""

from __future__ import annotations

import io
import zipfile
from xml.sax.saxutils import escape

import pytest
from PIL import Image

from shared.solution_authoring.runner import WorkerError, default_worker_command

_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"
_P = "http://schemas.openxmlformats.org/presentationml/2006/main"
_S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
_IMAGE_REL = f"{_R}/image"


def _real_worker_available() -> bool:
    try:
        default_worker_command()
    except WorkerError:
        return False
    return True


# 需要真实 Node worker 的用例：没装 worker 依赖的环境（如纯 Python 的 CI job）跳过，由专门的 job 负责跑。
real_worker = pytest.mark.skipif(not _real_worker_available(), reason="solution_authoring_worker dependencies are not installed")


def png_bytes(width: int = 120, height: int = 90, color=(200, 30, 30)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buffer, format="PNG")
    return buffer.getvalue()


def _zip(entries: dict[str, bytes | str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def docx_bytes(paragraphs: list[str], *, table: list[list[str]] | None = None, images: list[bytes] | None = None) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{escape(text)}</w:t></w:r></w:p>" for text in paragraphs)
    if table:
        rows = "".join(
            "<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{escape(cell)}</w:t></w:r></w:p></w:tc>" for cell in row) + "</w:tr>"
            for row in table
        )
        body += f"<w:tbl>{rows}</w:tbl>"
    entries: dict[str, bytes | str] = {
        "word/document.xml": f'<?xml version="1.0"?><w:document xmlns:w="{_W}"><w:body>{body}</w:body></w:document>',
    }
    for index, image in enumerate(images or [], start=1):
        entries[f"word/media/image{index}.png"] = image
    return _zip(entries)


def pptx_bytes(slides: list[list[str]], *, images: dict[int, bytes] | None = None) -> bytes:
    """slides[i] 是第 i+1 张幻灯片的文本行；images 的键是幻灯片序号（从 1 起）。"""
    entries: dict[str, bytes | str] = {}
    for number, lines in enumerate(slides, start=1):
        paragraphs = "".join(f"<a:p><a:r><a:t>{escape(line)}</a:t></a:r></a:p>" for line in lines)
        entries[f"ppt/slides/slide{number}.xml"] = (
            f'<?xml version="1.0"?><p:sld xmlns:p="{_P}" xmlns:a="{_A}"><p:cSld><p:spTree>'
            f"<p:sp><p:txBody>{paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"
        )
        image = (images or {}).get(number)
        if image:
            entries[f"ppt/media/image{number}.png"] = image
            entries[f"ppt/slides/_rels/slide{number}.xml.rels"] = (
                f'<?xml version="1.0"?><Relationships xmlns="{_REL}">'
                f'<Relationship Id="rId1" Type="{_IMAGE_REL}" Target="../media/image{number}.png"/></Relationships>'
            )
    return _zip(entries)


def xlsx_bytes(sheets: dict[str, list[list[str]]]) -> bytes:
    """所有单元格走共享字符串表；工作表顺序即字典顺序。"""
    shared: list[str] = []
    entries: dict[str, bytes | str] = {}
    sheet_nodes, rel_nodes = [], []
    for number, (title, rows) in enumerate(sheets.items(), start=1):
        row_nodes = []
        for row_number, row in enumerate(rows, start=1):
            cells = []
            for value in row:
                shared.append(value)
                cells.append(f'<c t="s"><v>{len(shared) - 1}</v></c>')
            row_nodes.append(f'<row r="{row_number}">{"".join(cells)}</row>')
        entries[f"xl/worksheets/sheet{number}.xml"] = (
            f'<?xml version="1.0"?><worksheet xmlns="{_S}"><sheetData>{"".join(row_nodes)}</sheetData></worksheet>'
        )
        sheet_nodes.append(f'<sheet name="{escape(title)}" sheetId="{number}" r:id="rId{number}"/>')
        rel_nodes.append(f'<Relationship Id="rId{number}" Type="{_R}/worksheet" Target="worksheets/sheet{number}.xml"/>')
    entries["xl/workbook.xml"] = (
        f'<?xml version="1.0"?><workbook xmlns="{_S}" xmlns:r="{_R}"><sheets>{"".join(sheet_nodes)}</sheets></workbook>'
    )
    entries["xl/_rels/workbook.xml.rels"] = f'<?xml version="1.0"?><Relationships xmlns="{_REL}">{"".join(rel_nodes)}</Relationships>'
    entries["xl/sharedStrings.xml"] = (
        f'<?xml version="1.0"?><sst xmlns="{_S}">' + "".join(f"<si><t>{escape(value)}</t></si>" for value in shared) + "</sst>"
    )
    return _zip(entries)


def text_pdf_bytes(pages: list[str]) -> bytes:
    """只含 ASCII 文本层的最小 PDF（每页一行）。"""
    objects: list[bytes] = []
    kids = " ".join(f"{3 + index * 2} 0 R" for index in range(len(pages)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(pages)} >>".encode())
    font_number = 3 + len(pages) * 2
    for index, text in enumerate(pages):
        content_number = 4 + index * 2
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content_number} 0 R "
            f"/Resources << /Font << /F1 {font_number} 0 R >> >> >>".encode()
        )
        safe = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        stream = f"BT /F1 12 Tf 72 720 Td ({safe}) Tj ET".encode()
        objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    out = io.BytesIO()
    out.write(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(f"{number} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = out.tell()
    out.write(f"xref\n0 {len(objects) + 1}\n".encode())
    out.write(b"0000000000 65535 f \n")
    for offset in offsets:
        out.write(f"{offset:010d} 00000 n \n".encode())
    out.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return out.getvalue()


def scanned_pdf_bytes(pages: int = 1) -> bytes:
    """没有文本层、每页一张整页图片的 PDF（模拟扫描件）。"""
    images = [Image.new("RGB", (300, 400), (240, 240, 240 - index)) for index in range(pages)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="PDF", save_all=True, append_images=images[1:])
    return buffer.getvalue()
