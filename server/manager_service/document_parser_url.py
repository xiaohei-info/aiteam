"""URL 抓取 + 文本提取（issue #416；URL 导入路径）。

与 document_parser.py 分开：URL 抓取涉及网络 + urllib，独立模块便于测试 mock。
返回 (text, file_name, mime, title)；失败抛 ValueError（由上层映射为 400）。
"""

from __future__ import annotations

import re
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .document_parser import html_to_text


def fetch_url_text(url: str) -> tuple[str, str, str, str]:
    """抓取 URL 并提取可见文本。抛 ValueError 在非法 URL / 空 body / 网络错误。"""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"unsupported URL scheme: {parsed.scheme or 'empty'}")
    if not parsed.netloc:
        raise ValueError(f"invalid URL: missing host: {url}")

    req = Request(url, headers={"User-Agent": "aiteam-knowledge/1.0"})
    with urlopen(req, timeout=15) as resp:
        mime = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip()
        data = resp.read(4 * 1024 * 1024)  # 4 MB cap
    if not data:
        raise ValueError("fetched URL returned empty body")
    text = data.decode("utf-8", errors="replace")

    title = ""
    tm = re.search(r"<title[^>]*>(.*?)</title>", text[:8192], re.I | re.S)
    if tm:
        title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", tm.group(1))).strip()

    name = parsed.path.rsplit("/", 1)[-1] or "page.html"
    if "html" in mime or not mime:
        text = html_to_text(text)
    return text, name, mime or "text/plain", title
