from __future__ import annotations

from urllib.request import ProxyHandler, Request

import pytest

from manager_service import document_parser_url as parser


def _dns_result(address: str):
    return [(0, 0, 0, "", (address, 0))]


@pytest.mark.parametrize("address", [
    "127.0.0.1",
    "10.0.0.7",
    "169.254.1.2",
    "224.0.0.1",
    "0.0.0.0",
])
def test_fetch_rejects_non_public_dns_results(monkeypatch: pytest.MonkeyPatch, address: str) -> None:
    monkeypatch.setattr(parser.socket, "getaddrinfo", lambda *args, **kwargs: _dns_result(address))
    with pytest.raises(ValueError, match="blocked address"):
        parser.fetch_url_text("https://public.example/page")


def test_redirect_target_is_revalidated(monkeypatch: pytest.MonkeyPatch) -> None:
    def resolve(host, *args, **kwargs):
        return _dns_result("10.0.0.7" if host == "private.example" else "93.184.216.34")

    monkeypatch.setattr(parser.socket, "getaddrinfo", resolve)
    handler = parser._SafeRedirectHandler()
    with pytest.raises(ValueError, match="blocked address"):
        handler.redirect_request(
            Request("https://public.example/page"), None, 302, "found", {},
            "https://private.example/internal",
        )


def test_public_host_uses_no_ambient_proxy_and_extracts_content(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        parser.socket, "getaddrinfo", lambda *args, **kwargs: _dns_result("93.184.216.34")
    )
    calls = {}

    class Response:
        headers = {"Content-Type": "text/html; charset=utf-8"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit):
            calls["limit"] = limit
            return b"<title>Example</title><p>Hello</p>"

    class Opener:
        def open(self, request, timeout):
            calls["request"] = request
            calls["timeout"] = timeout
            return Response()

    def build(*handlers):
        calls["handlers"] = handlers
        return Opener()

    monkeypatch.setattr(parser, "build_opener", build)
    text, name, mime, title = parser.fetch_url_text("https://public.example/page.html")

    assert "Hello" in text
    assert (name, mime, title) == ("page.html", "text/html", "Example")
    assert calls["limit"] == parser._MAX_BODY_BYTES + 1
    assert calls["timeout"] == 15
    assert isinstance(calls["handlers"][0], ProxyHandler)
    assert calls["handlers"][0].proxies == {}


def test_body_limit_is_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        parser.socket, "getaddrinfo", lambda *args, **kwargs: _dns_result("93.184.216.34")
    )

    class Response:
        headers = {}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, limit):
            return b"x" * (parser._MAX_BODY_BYTES + 1)

    class Opener:
        def open(self, request, timeout):
            return Response()

    monkeypatch.setattr(parser, "build_opener", lambda *handlers: Opener())
    with pytest.raises(ValueError, match="maximum size"):
        parser.fetch_url_text("https://public.example/large")


def test_redirect_count_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        parser, "_validate_url_target", lambda url: None
    )
    handler = parser._SafeRedirectHandler()
    request = Request("https://public.example/page")
    for _ in range(parser._MAX_REDIRECTS):
        handler.redirect_request(request, None, 302, "found", {}, "https://public.example/next")
    with pytest.raises(ValueError, match="too many"):
        handler.redirect_request(request, None, 302, "found", {}, "https://public.example/next")
