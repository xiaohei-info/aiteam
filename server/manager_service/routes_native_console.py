"""Manager-native consoles for the deployment-owned Hindsight and LightRAG UIs.

A Manager deployment serves one enterprise.  The bridge therefore does not
implement cross-tenant routing; it only keeps component credentials in the
Manager process and exposes the configured component through the Manager auth
boundary.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.contracts.enums import EnterpriseRole
from shared.errors import NotFound, Unauthorized
from shared.native_console import (
    NativeConsoleConfig,
    NativeConsoleProxy,
    require_console_claims,
)

from .hindsight_client import HindsightSettings
from .rag_mcp import LightRagSettings


CONSOLE_PREFIX = "/api/manager/native-console"
_CONSOLE_MAX_AGE = 600
_ALLOWED_ROLES = [EnterpriseRole.OWNER.value, EnterpriseRole.ENTERPRISE_ADMIN.value]


class NativeConsoleSessionOut(BaseModel):
    url: str
    expires_in: int


@dataclass(frozen=True)
class _Component:
    name: str
    cookie_name: str
    path: str


_COMPONENTS = {
    "lightrag": _Component("LightRAG", "aiteam_manager_lightrag_console", "lightrag"),
    "hindsight": _Component("Hindsight", "aiteam_manager_hindsight_console", "hindsight"),
}


def _component_config(component: str) -> tuple[_Component, NativeConsoleConfig]:
    selected = _COMPONENTS.get(component)
    if selected is None:
        raise NotFound("native console not found")
    prefix = f"{CONSOLE_PREFIX}/{selected.path}"
    if component == "lightrag":
        settings = LightRagSettings.from_env()
        if settings is None or not settings.url or not settings.api_key or not settings.workspace:
            from shared.native_console import NativeConsoleUnavailable
            raise NativeConsoleUnavailable("LightRAG native console is not configured")
        config = NativeConsoleConfig(
            name=selected.name,
            base_url=os.getenv("LIGHTRAG_CONSOLE_URL") or settings.url,
            prefix=prefix,
            upstream_headers={"X-API-Key": settings.api_key},
            blocked_query_params=frozenset({"workspace", "workspace_id"}),
            config_values={
                "apiPrefix": prefix,
                "webuiPrefix": f"{prefix}/webui/",
            },
        )
    else:
        settings = HindsightSettings.from_env()
        console_url = os.getenv("HINDSIGHT_CONSOLE_URL") or ""
        if not console_url or not settings.token:
            from shared.native_console import NativeConsoleUnavailable
            raise NativeConsoleUnavailable("Hindsight native console is not configured")
        config = NativeConsoleConfig(
            name=selected.name,
            base_url=console_url,
            prefix=prefix,
            upstream_headers={"Authorization": f"Bearer {settings.token}"},
        )
    config.validate()
    return selected, config


def build_native_console_router(verifier) -> APIRouter:
    router = APIRouter(prefix=CONSOLE_PREFIX, tags=["manager", "native-console"])
    require = require_claims(verifier)

    @router.post("/{component}/session", operation_id="manager_native_console_session")
    async def create_session(
        component: str,
        request: Request,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[NativeConsoleSessionOut]:
        authorize(claims, _ALLOWED_ROLES)
        selected, _ = _component_config(component)
        token = request.headers.get("authorization", "")[7:].strip()
        if not token:
            raise Unauthorized("missing bearer token")
        response.headers["Cache-Control"] = "no-store"
        response.set_cookie(
            selected.cookie_name,
            token,
            max_age=_CONSOLE_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=bool(getattr(request.app.state.settings, "is_production", False)),
            path=f"{CONSOLE_PREFIX}/{selected.path}",
        )
        return Envelope(data=NativeConsoleSessionOut(
            url=f"{CONSOLE_PREFIX}/{selected.path}/",
            expires_in=_CONSOLE_MAX_AGE,
        ))

    @router.delete("/{component}/session", operation_id="manager_native_console_session_delete")
    async def delete_session(
        component: str,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Response:
        selected = _COMPONENTS.get(component)
        if selected is None:
            raise NotFound("native console not found")
        authorize(claims, _ALLOWED_ROLES)
        response.delete_cookie(
            selected.cookie_name,
            path=f"{CONSOLE_PREFIX}/{selected.path}",
        )
        response.status_code = 204
        response.headers["Cache-Control"] = "no-store"
        return response

    @router.api_route(
        "/{component}/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    async def proxy(
        component: str,
        path: str,
        request: Request,
    ) -> Response:
        selected = _COMPONENTS.get(component)
        if selected is None:
            raise NotFound("native console not found")
        require_console = require_console_claims(verifier, selected.cookie_name, _ALLOWED_ROLES)
        claims = require_console(request)
        del claims
        _, config = _component_config(component)
        return await NativeConsoleProxy(config).proxy(request, path)

    return router