"""Trusted browser authentication origin; never inferred from Host or user input."""
from dataclasses import dataclass
import os
from urllib.parse import urlsplit

from shared.errors import AppError


class AuthOriginUnconfigured(AppError):
    status, code, title = 503, "auth_origin_unconfigured", "Authentication Origin Unconfigured"


@dataclass(frozen=True)
class AuthOrigin:
    origin: str
    rp_id: str

    def require_passkey_rp(self):
        from ipaddress import ip_address
        try:
            ip_address(self.rp_id)
        except ValueError:
            return self
        raise AuthOriginUnconfigured("Passkey requires a DNS RP hostname; use localhost for dev/test, not an IP address")

    @property
    def oauth_redirect_uri(self) -> str:
        return self.origin + "/auth/oauth/callback"

    @classmethod
    def from_env(cls):
        return cls.parse(os.getenv("MANAGER_PUBLIC_ORIGIN", ""), environment=os.getenv("AITEAM_ENV", ""))

    @classmethod
    def parse(cls, value: str, *, environment: str = ""):
        try:
            url = urlsplit(value)
            local = url.hostname in {"localhost", "127.0.0.1", "::1"}
            if (not url.hostname or url.username or url.password or url.path or url.query or url.fragment
                    or (url.scheme != "https" and not (url.scheme == "http" and local and environment in {"dev", "test"}))):
                raise ValueError()
            # Explicit canonical origin only: no trailing slash, path, userinfo or malformed port.
            port = url.port
            host = f"[{url.hostname}]" if ":" in url.hostname else url.hostname.encode("idna").decode()
            canonical = f"{url.scheme}://{host}" + (f":{port}" if port and port != (443 if url.scheme == "https" else 80) else "")
            if canonical != value:
                raise ValueError()
            return cls(origin=canonical, rp_id=url.hostname)
        except ValueError as exc:
            raise AuthOriginUnconfigured("configure a canonical trusted MANAGER_PUBLIC_ORIGIN (HTTPS; dev/test loopback HTTP only)") from exc
