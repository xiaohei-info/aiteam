"""URL 抓取 + 文本提取（issue #416；URL 导入路径）。

与 document_parser.py 分开：URL 抓取涉及网络 + urllib，独立模块便于测试 mock。
返回 (text, file_name, mime, title)；失败抛 ValueError（由上层映射为 400）。
"""

from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .document_parser import html_to_text


_MAX_BODY_BYTES = 4 * 1024 * 1024
_MAX_REDIRECTS = 5


def _validate_url_target(url: str) -> None:
    """Validate scheme and every address returned for a URL host."""
    try:
        parsed = urlparse(url)
        host = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError("invalid URL") from None
    if parsed.scheme not in ("http", "https"):
        raise ValueError("unsupported URL scheme")
    if not host:
        raise ValueError("invalid URL: missing host")

    try:
        addresses = socket.getaddrinfo(
            host, port if port is not None else (443 if parsed.scheme == "https" else 80),
            type=socket.SOCK_STREAM,
        )
    except OSError:
        raise ValueError("URL host could not be resolved") from None
    if not addresses:
        raise ValueError("URL host could not be resolved")

    for address in addresses:
        try:
            ip = ipaddress.ip_address(address[4][0])
        except (IndexError, ValueError):
            raise ValueError("URL host could not be resolved") from None
        if (
            ip.is_loopback
            or ip.is_private
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
            or not ip.is_global
        ):
            raise ValueError("URL host resolves to a blocked address")


class _SafeRedirectHandler(HTTPRedirectHandler):
    """Revalidate redirect destinations and bound the redirect chain."""

    def __init__(self) -> None:
        super().__init__()
        self._redirect_count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if self._redirect_count >= _MAX_REDIRECTS:
            raise ValueError("too many URL redirects")
        _validate_url_target(newurl)
        self._redirect_count += 1
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_url_text(url: str) -> tuple[str, str, str, str]:
    """抓取 URL 并提取可见文本；网络失败以有界通用错误返回。"""
    _validate_url_target(url)
    parsed = urlparse(url)
    req = Request(url, headers={"User-Agent": "aiteam-knowledge/1.0"})
    # An explicit empty proxy map prevents HTTP(S)_PROXY/ALL_PROXY ambient use.
    opener = build_opener(ProxyHandler({}), _SafeRedirectHandler())
    try:
        with opener.open(req, timeout=15) as resp:
            mime = (resp.headers.get("Content-Type") or "").split(";", 1)[0].strip()
            data = resp.read(_MAX_BODY_BYTES + 1)
    except ValueError:
        raise
    except Exception:
        raise ValueError("URL fetch failed") from None
    if not data:
        raise ValueError("fetched URL returned empty body")
    if len(data) > _MAX_BODY_BYTES:
        raise ValueError("fetched URL body exceeds maximum size")
    text = data.decode("utf-8", errors="replace")

    title = ""
    tm = re.search(r"<title[^>]*>(.*?)</title>", text[:8192], re.I | re.S)
    if tm:
        title = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", tm.group(1))).strip()

    name = parsed.path.rsplit("/", 1)[-1] or "page.html"
    if "html" in mime or not mime:
        text = html_to_text(text)
    return text, name, mime or "text/plain", title
