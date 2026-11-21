"""Outbound HTTPS from the control plane to user-supplied addresses (design 2026-11-20 decision C / #4).

Every connection resolves the host and refuses private / loopback / link-local / multicast / reserved /
documentation addresses, then connects to the vetted address itself (TLS still verifies the original host
name), so a DNS answer cannot change between the check and the connect. https only, no ambient proxies, a
caller-chosen overall deadline and body cap. Redirects are followed only within the same host.
"""

from __future__ import annotations

import ipaddress
import socket
import time
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit


class Blocked(Exception):
    """The target is not allowed (scheme / address range)."""


class FetchFailed(Exception):
    """Network failure, redirect, oversize or an unexpected answer. Messages are safe to show to admins."""


# (method, url, headers, body, deadline) -> (status, lower-cased headers, body)
Fetch = Callable[[str, str, dict[str, str], bytes | None, float], tuple[int, dict[str, str], bytes]]


def is_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return (
        ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_multicast or ip.is_reserved
        or ip.is_unspecified or not ip.is_global
    )


def public_addresses(host: str, port: int) -> list[str]:
    """Every address of `host`, or Blocked when any of them is not public."""
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise FetchFailed("域名无法解析") from exc
    addresses: list[str] = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if is_blocked(ip):
            raise Blocked("地址指向内网、本机或保留网段，不允许访问")
        addresses.append(str(ip))
    if not addresses:
        raise FetchFailed("域名无法解析")
    return addresses


def pinned_fetch(*, max_bytes: int) -> Fetch:
    """A fetch that only connects to public addresses and stops reading past `max_bytes`."""
    import httpcore

    class _PinnedBackend(httpcore.NetworkBackend):
        def __init__(self) -> None:
            self._inner = httpcore.SyncBackend()

        def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
            last: Exception | None = None
            for address in public_addresses(host, port):
                try:
                    return self._inner.connect_tcp(address, port, timeout=timeout, socket_options=socket_options)
                except httpcore.ConnectError as exc:
                    last = exc
            raise httpcore.ConnectError(str(last or "connect failed"))

        def connect_unix_socket(self, path, timeout=None, socket_options=None):
            raise httpcore.ConnectError("unix sockets are not allowed")

        def sleep(self, seconds: float) -> None:
            self._inner.sleep(seconds)

    pool = httpcore.ConnectionPool(network_backend=_PinnedBackend(), retries=0)

    def fetch(method: str, url: str, headers: dict[str, str], body: bytes | None, deadline: float):
        if urlsplit(url).scheme != "https":
            raise Blocked("只允许 https 地址")
        remaining = max(0.1, deadline - time.monotonic())
        timeout = {"connect": remaining, "read": remaining, "write": remaining, "pool": remaining}
        try:
            with pool.stream(method, url, headers=list(headers.items()), content=body, extensions={"timeout": timeout}) as response:
                data = bytearray()
                for chunk in response.iter_stream():
                    data.extend(chunk)
                    if len(data) > max_bytes:
                        raise FetchFailed(f"内容超过 {max_bytes // (1024 * 1024)} MiB 上限")
                    if time.monotonic() > deadline:
                        raise FetchFailed("请求超时")
                return response.status, {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in response.headers}, bytes(data)
        except (Blocked, FetchFailed):
            raise
        except Exception as exc:  # httpcore errors carry no secrets, but keep the message generic anyway
            raise FetchFailed("无法连接") from exc

    return fetch


def get(url: str, *, fetch: Fetch, timeout_s: float, headers: dict[str, str] | None = None,
        max_redirects: int = 3, allow_status: tuple[int, ...] = (200,)) -> tuple[int, dict[str, str], bytes]:
    """GET with same-host redirects only; any status outside `allow_status` raises FetchFailed."""
    deadline = time.monotonic() + timeout_s
    current = url
    for _ in range(max_redirects + 1):
        status, response_headers, body = fetch("GET", current, dict(headers or {}), None, deadline)
        if status in (301, 302, 303, 307, 308):
            target = urljoin(current, response_headers.get("location", ""))
            if urlsplit(target).scheme != "https" or urlsplit(target).netloc.lower() != urlsplit(current).netloc.lower():
                raise FetchFailed("地址跳转到了其他网站，已停止")
            current = target
            continue
        if status == 429:
            raise FetchFailed("对方请求太频繁，请稍后再试")
        if status == 404:
            raise FetchFailed("对方返回 404：找不到")
        if status not in allow_status:
            raise FetchFailed(f"对方返回 HTTP {status}")
        return status, response_headers, body
    raise FetchFailed("跳转次数过多")
