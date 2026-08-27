"""Small, fixed-target reverse proxy for embedded vendor consoles.

The browser only talks to the owning Operation/Manager origin.  Component
credentials stay in the service process and are added to upstream requests;
there is deliberately no user-supplied target URL or generic proxy endpoint.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Mapping
from urllib.parse import unquote, urlsplit

import httpx
from fastapi import Request
from shared.auth import authorize
from shared.errors import AppError, Unauthorized
from starlette.responses import Response


_MAX_BODY_BYTES = 64 * 1024 * 1024
_MAX_RESPONSE_BYTES = 64 * 1024 * 1024
_FORWARD_REQUEST_HEADERS = (
    "accept",
    "accept-language",
    "cache-control",
    "content-type",
    "if-match",
    "if-modified-since",
    "if-none-match",
    "next-action",
    "next-router-prefetch",
    "next-router-state-tree",
    "next-url",
    "range",
    "rsc",
    "user-agent",
    "x-nextjs-data",
    "x-requested-with",
)
_RESPONSE_HEADERS = (
    "allow",
    "cache-control",
    "content-disposition",
    "content-type",
    "etag",
    "last-modified",
    "retry-after",
    "vary",
    "www-authenticate",
    "x-middleware-redirect",
    "x-middleware-rewrite",
    "x-nextjs-matched-path",
    "x-nextjs-redirect",
)
_HTML_ROOT_URL = re.compile(r"([\"'`])/(?![/])")
_KNOWN_ROOT_URL = re.compile(
    r"([\"'`])/(?=(?:api|assets|static|_next|webui|health|documents|query|sign-in|dashboard|en|logo|favicon|manifest)(?:[/.?/#\"'`]|$))"
)
_CSS_ROOT_URL = re.compile(r"url\((\s*)/(?=(?:assets|static|_next|webui|logo|favicon)(?:[/.)#?]))", re.IGNORECASE)
_CONFIG_VALUE = re.compile(r"(?P<prefix>[\"']{key}[\"']\s*:\s*)[\"'][^\"']*[\"']")


class NativeConsoleUnavailable(AppError):
    status, code, title = 503, "native_console_unavailable", "Native console unavailable"


class NativeConsolePathError(AppError):
    status, code, title = 400, "native_console_path_invalid", "Native console path invalid"


def require_console_claims(verifier, cookie_name: str, allowed_roles: list[str]):
    """Return a FastAPI-compatible dependency for the HttpOnly console session."""

    def dependency(request: Request):
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.startswith("Bearer ") else ""
        if not token:
            token = request.cookies.get(cookie_name, "").strip()
        if not token:
            raise Unauthorized("native console session is required")
        claims = verifier.verify(token)
        authorize(claims, allowed_roles)
        return claims

    return dependency


@dataclass(frozen=True)
class NativeConsoleConfig:
    """One fixed vendor target and its service-side credentials."""

    name: str
    base_url: str
    prefix: str
    upstream_headers: Mapping[str, str] = field(default_factory=dict, repr=False)
    config_values: Mapping[str, str] = field(default_factory=dict, repr=False)
    blocked_query_params: frozenset[str] = frozenset()
    timeout_seconds: float = 60.0

    def validate(self) -> None:
        if not isinstance(self.base_url, str) or not self.base_url.strip():
            raise NativeConsoleUnavailable(f"{self.name} console is not configured")
        parsed = urlsplit(self.base_url)
        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise NativeConsoleUnavailable(f"{self.name} console URL is invalid")
        if not self.prefix.startswith("/") or self.prefix.endswith("/"):
            raise ValueError("console prefix must start with / and not end with /")
        for key, value in self.upstream_headers.items():
            if not isinstance(key, str) or not isinstance(value, str) or not value:
                raise NativeConsoleUnavailable(f"{self.name} console credentials are not configured")


class NativeConsoleProxy:
    """Proxy one vendor UI without allowing target or credential selection."""

    def __init__(
        self,
        config: NativeConsoleConfig,
        *,
        client: httpx.AsyncClient | None = None,
    ):
        config.validate()
        self.config = config
        self._client = client

    async def proxy(self, request: Request, path: str) -> Response:
        upstream_path = _normalize_path(path)
        body = await request.body()
        if len(body) > _MAX_BODY_BYTES:
            raise NativeConsoleUnavailable(f"{self.config.name} console request is too large")

        target = f"{self.config.base_url.rstrip('/')}/{upstream_path}" if upstream_path else f"{self.config.base_url.rstrip('/')}/"
        headers = {
            key: request.headers[key]
            for key in _FORWARD_REQUEST_HEADERS
            if key in request.headers
        }
        # Browser cookies and authorization are intentionally not forwarded.  The
        # only upstream credentials are the fixed service-side headers below.
        headers.update(self.config.upstream_headers)
        client = self._client or httpx.AsyncClient(
            timeout=self.config.timeout_seconds,
            follow_redirects=False,
        )
        try:
            upstream = await client.request(
                request.method,
                target,
                params=[
                    (key, value)
                    for key, value in request.query_params.multi_items()
                    if key.lower() not in self.config.blocked_query_params
                ],
                content=body,
                headers=headers,
            )
            if len(upstream.content) > _MAX_RESPONSE_BYTES:
                raise NativeConsoleUnavailable(f"{self.config.name} console response is too large")
            content = _rewrite_body(
                upstream.content,
                upstream.headers.get("content-type", ""),
                self.config.prefix,
                self.config.config_values,
            )
            response_headers = {
                key: upstream.headers[key]
                for key in _RESPONSE_HEADERS
                if key in upstream.headers
            }
            for location_header in ("location", "x-middleware-redirect", "x-middleware-rewrite", "x-nextjs-redirect"):
                location = upstream.headers.get(location_header)
                if location:
                    response_headers[location_header] = _rewrite_location(location, self.config)
            # These headers describe the vendor origin and can prevent an iframe
            # from rendering.  The owning service controls the frame boundary.
            response_headers.pop("content-security-policy", None)
            response_headers.pop("x-frame-options", None)
            response = Response(
                content=content,
                status_code=upstream.status_code,
                headers=response_headers,
                media_type=None,
            )
            for cookie in upstream.headers.get_list("set-cookie"):
                rewritten = _rewrite_set_cookie(cookie, self.config.prefix)
                if rewritten:
                    response.raw_headers.append((b"set-cookie", rewritten.encode("latin-1")))
            return response
        except NativeConsoleUnavailable:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise NativeConsoleUnavailable(f"{self.config.name} console request failed") from exc
        finally:
            if self._client is None:
                await client.aclose()


def _normalize_path(path: str) -> str:
    decoded = unquote(unquote(path or "")).lstrip("/")
    if any(part in {".", ".."} for part in decoded.split("/")):
        raise NativeConsolePathError("console path traversal is not allowed")
    if any(char in decoded for char in "?#\\\x00") or any(ord(char) < 32 or ord(char) == 127 for char in decoded):
        raise NativeConsolePathError("console path contains an invalid character")
    return decoded


def _rewrite_body(
    body: bytes,
    content_type: str,
    prefix: str,
    config_values: Mapping[str, str],
) -> bytes:
    lowered = content_type.lower()
    if not (
        "text/html" in lowered
        or "text/css" in lowered
        or "javascript" in lowered
        or "ecmascript" in lowered
    ):
        return body
    text = body.decode("utf-8", errors="replace")
    # Vendor SPAs commonly use root-relative asset/API URLs.  Prefix them so
    # every request remains inside this fixed console route.  HTML attributes
    # accept every root path; JavaScript is limited to known request/static
    # prefixes to avoid changing unrelated vendor string literals.
    if "text/html" in lowered:
        text = _HTML_ROOT_URL.sub(lambda match: f"{match.group(1)}{prefix}/", text)
    else:
        text = _KNOWN_ROOT_URL.sub(lambda match: f"{match.group(1)}{prefix}/", text)
    text = _CSS_ROOT_URL.sub(lambda match: f"url({match.group(1)}{prefix}/", text)
    for key, value in config_values.items():
        expression = re.compile(_CONFIG_VALUE.pattern.format(key=re.escape(key)))
        text = expression.sub(
            lambda match, value=value: f"{match.group('prefix')}\"{value}\"",
            text,
        )
    return text.encode("utf-8")


def _rewrite_location(location: str, config: NativeConsoleConfig) -> str:
    if location.startswith("/") and not location.startswith("//"):
        return f"{config.prefix}{location}"
    parsed = urlsplit(location)
    upstream = urlsplit(config.base_url)
    if parsed.scheme in {"http", "https"} and parsed.netloc == upstream.netloc:
        path = parsed.path or "/"
        return f"{config.prefix}{path}" + (f"?{parsed.query}" if parsed.query else "") + (f"#{parsed.fragment}" if parsed.fragment else "")
    return location


def _rewrite_set_cookie(value: str, prefix: str) -> str | None:
    parts = [part.strip() for part in value.split(";") if part.strip()]
    if not parts or "=" not in parts[0]:
        return None
    attributes: list[str] = []
    path_seen = False
    for part in parts[1:]:
        key, _, _ = part.partition("=")
        lowered = key.strip().lower()
        if lowered == "domain":
            continue
        if lowered == "path":
            attributes.append(f"Path={prefix}")
            path_seen = True
        else:
            attributes.append(part)
    if not path_seen:
        attributes.append(f"Path={prefix}")
    return "; ".join([parts[0], *attributes])