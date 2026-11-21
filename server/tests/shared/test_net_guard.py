"""shared.net_guard: public-address pinning, https only, body cap, same-host redirects (design 2026-11-20 C / #4).

No real network: DNS and the httpcore pool are replaced with fakes.
"""

from __future__ import annotations

import contextlib
import ipaddress
import socket
import time

import httpcore
import pytest

from shared import net_guard
from shared.net_guard import (
    Blocked,
    FetchFailed,
    get,
    is_blocked,
    pinned_fetch,
    public_addresses,
)


def _info(address: str):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    return (family, socket.SOCK_STREAM, 6, "", (address, 443))


@pytest.mark.parametrize("address, blocked", [
    ("93.184.216.34", False),
    ("10.0.0.1", True),
    ("127.0.0.1", True),
    ("169.254.169.254", True),
    ("::ffff:10.0.0.1", True),        # IPv4-mapped private
    ("::ffff:93.184.216.34", False),  # IPv4-mapped public
    ("0.0.0.0", True),
    ("2606:4700::1111", False),
])
def test_is_blocked(address, blocked):
    assert is_blocked(ipaddress.ip_address(address)) is blocked


def test_public_addresses_resolves_and_rejects(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, type: [_info("93.184.216.34"), _info("2606:4700::1111")])
    assert public_addresses("example.com", 443) == ["93.184.216.34", "2606:4700::1111"]

    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, type: [_info("93.184.216.34"), _info("192.168.1.2")])
    with pytest.raises(Blocked):
        public_addresses("rebind.example", 443)

    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port, type: [])
    with pytest.raises(FetchFailed, match="无法解析"):
        public_addresses("empty.example", 443)

    def boom(host, port, type):
        raise socket.gaierror("nope")
    monkeypatch.setattr(socket, "getaddrinfo", boom)
    with pytest.raises(FetchFailed, match="无法解析"):
        public_addresses("missing.example", 443)


class _FakeResponse:
    def __init__(self, status, headers, chunks, on_chunk=None):
        self.status = status
        self.headers = headers
        self._chunks = chunks
        self._on_chunk = on_chunk

    def iter_stream(self):
        for chunk in self._chunks:
            if self._on_chunk:
                self._on_chunk()
            yield chunk


class _FakePool:
    """Captures the network backend and replays a scripted response."""

    last: _FakePool | None = None

    def __init__(self, network_backend, retries):
        self.backend = network_backend
        self.retries = retries
        self.response: _FakeResponse | Exception | None = None
        self.calls: list[tuple] = []
        _FakePool.last = self

    @contextlib.contextmanager
    def stream(self, method, url, headers, content, extensions):
        self.calls.append((method, url, headers, content, extensions))
        if isinstance(self.response, Exception):
            raise self.response
        yield self.response


@pytest.fixture()
def pool(monkeypatch):
    monkeypatch.setattr(httpcore, "ConnectionPool", _FakePool)
    return _FakePool


def test_pinned_fetch_reads_body_and_lowercases_headers(pool):
    fetch = pinned_fetch(max_bytes=1024)
    pool.last.response = _FakeResponse(200, [(b"Content-Type", b"text/plain")], [b"hel", b"lo"])
    status, headers, body = fetch("GET", "https://example.com/a", {"Accept": "*/*"}, None, time.monotonic() + 5)
    assert (status, headers, body) == (200, {"content-type": "text/plain"}, b"hello")
    assert pool.last.retries == 0
    method, url, sent_headers, _, extensions = pool.last.calls[0]
    assert (method, url, sent_headers) == ("GET", "https://example.com/a", [("Accept", "*/*")])
    assert set(extensions["timeout"]) == {"connect", "read", "write", "pool"}


def test_pinned_fetch_refuses_plain_http(pool):
    fetch = pinned_fetch(max_bytes=10)
    with pytest.raises(Blocked, match="https"):
        fetch("GET", "http://example.com/", {}, None, time.monotonic() + 5)
    assert pool.last.calls == []


def test_pinned_fetch_stops_past_the_body_cap(pool):
    fetch = pinned_fetch(max_bytes=2 * 1024 * 1024)
    pool.last.response = _FakeResponse(200, [], [b"x" * (1024 * 1024), b"x" * (1024 * 1024), b"x"])
    with pytest.raises(FetchFailed, match="2 MiB"):
        fetch("GET", "https://example.com/big", {}, None, time.monotonic() + 5)


def test_pinned_fetch_stops_past_the_deadline(pool, monkeypatch):
    fetch = pinned_fetch(max_bytes=1024)
    deadline = time.monotonic() + 5
    pool.last.response = _FakeResponse(200, [], [b"a", b"b"], on_chunk=lambda: monkeypatch.setattr(time, "monotonic", lambda: deadline + 1))
    with pytest.raises(FetchFailed, match="超时"):
        fetch("GET", "https://example.com/slow", {}, None, deadline)


def test_pinned_fetch_wraps_transport_errors_generically(pool):
    fetch = pinned_fetch(max_bytes=10)
    pool.last.response = httpcore.ConnectError("secret-ish detail")
    with pytest.raises(FetchFailed, match="^无法连接$"):
        fetch("GET", "https://example.com/", {}, None, time.monotonic() + 5)
    pool.last.response = Blocked("地址指向内网")
    with pytest.raises(Blocked):
        fetch("GET", "https://example.com/", {}, None, time.monotonic() + 5)


def test_backend_connects_only_to_vetted_addresses(pool, monkeypatch):
    pinned_fetch(max_bytes=10)
    backend = pool.last.backend
    monkeypatch.setattr(net_guard, "public_addresses", lambda host, port: ["203.0.113.9", "93.184.216.34"])
    tried: list[str] = []

    def connect(address, port, timeout=None, socket_options=None):
        tried.append(address)
        if address == "203.0.113.9":
            raise httpcore.ConnectError("refused")
        return f"stream:{address}:{port}"

    monkeypatch.setattr(backend._inner, "connect_tcp", connect)
    assert backend.connect_tcp("example.com", 443) == "stream:93.184.216.34:443"
    assert tried == ["203.0.113.9", "93.184.216.34"]

    monkeypatch.setattr(net_guard, "public_addresses", lambda host, port: ["203.0.113.9"])
    with pytest.raises(httpcore.ConnectError, match="refused"):
        backend.connect_tcp("example.com", 443)
    with pytest.raises(httpcore.ConnectError, match="unix"):
        backend.connect_unix_socket("/var/run/docker.sock")
    slept: list[float] = []
    monkeypatch.setattr(backend._inner, "sleep", slept.append)
    backend.sleep(0.5)
    assert slept == [0.5]


def _scripted(*answers):
    calls: list[str] = []
    queue = list(answers)

    def fetch(method, url, headers, body, deadline):
        calls.append(url)
        return queue.pop(0)
    return fetch, calls


def test_get_follows_same_host_redirects_only():
    fetch, calls = _scripted((302, {"location": "/b"}, b""), (200, {}, b"ok"))
    assert get("https://example.com/a", fetch=fetch, timeout_s=5) == (200, {}, b"ok")
    assert calls == ["https://example.com/a", "https://example.com/b"]

    fetch, _ = _scripted((301, {"location": "https://evil.example/x"}, b""))
    with pytest.raises(FetchFailed, match="其他网站"):
        get("https://example.com/a", fetch=fetch, timeout_s=5)

    fetch, _ = _scripted(*[(307, {"location": "/loop"}, b"")] * 3)
    with pytest.raises(FetchFailed, match="跳转次数过多"):
        get("https://example.com/a", fetch=fetch, timeout_s=5, max_redirects=2)


@pytest.mark.parametrize("status, message", [(429, "太频繁"), (404, "404"), (500, "HTTP 500")])
def test_get_maps_failure_statuses(status, message):
    fetch, _ = _scripted((status, {}, b""))
    with pytest.raises(FetchFailed, match=message):
        get("https://example.com/a", fetch=fetch, timeout_s=5)


def test_get_allows_extra_statuses():
    fetch, _ = _scripted((206, {}, b"part"))
    assert get("https://example.com/a", fetch=fetch, timeout_s=5, allow_status=(200, 206))[0] == 206
