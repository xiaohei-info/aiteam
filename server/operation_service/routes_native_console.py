"""Operator-only native NewAPI console bridge.

NewAPI is an Operator-owned component.  The UI is exposed through a fixed
same-origin route so the browser never receives the NewAPI management token.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel

from shared.auth import authorize, require_claims
from shared.contracts.auth import TokenClaims
from shared.contracts.envelope import Envelope
from shared.contracts.enums import PlatformRole
from shared.errors import Unauthorized
from shared.native_console import (
    NativeConsoleConfig,
    NativeConsoleProxy,
    NativeConsoleUnavailable,
    require_console_claims,
)


CONSOLE_PREFIX = "/api/operation/newapi-console"
_CONSOLE_COOKIE = "aiteam_operation_newapi_console"
_CONSOLE_MAX_AGE = 600
_ALLOWED_ROLES = [PlatformRole.SYSTEM_ADMIN.value, PlatformRole.SYSTEM_OPERATOR.value]


class NativeConsoleSessionOut(BaseModel):
    url: str
    expires_in: int


def _config() -> NativeConsoleConfig:
    base_url = os.getenv("NEWAPI_ADMIN_BASE_URL") or os.getenv("NEWAPI_URL") or ""
    admin_token = os.getenv("NEWAPI_ADMIN_TOKEN") or ""
    admin_user_id = os.getenv("NEWAPI_ADMIN_USER_ID") or ""
    if not admin_token.strip() or not admin_user_id.strip():
        raise NativeConsoleUnavailable("NewAPI native console credentials are not configured")
    return NativeConsoleConfig(
        name="NewAPI",
        base_url=base_url,
        prefix=CONSOLE_PREFIX,
        upstream_headers={
            "Authorization": f"Bearer {admin_token}",
            "New-Api-User": admin_user_id,
        },
    )


def build_newapi_console_router(verifier) -> APIRouter:
    router = APIRouter(prefix=CONSOLE_PREFIX, tags=["operation", "newapi-console"])
    require = require_claims(verifier)
    require_console = require_console_claims(verifier, _CONSOLE_COOKIE, _ALLOWED_ROLES)

    @router.post("/session", operation_id="operation_newapi_console_session")
    async def create_session(
        request: Request,
        response: Response,
        claims: TokenClaims = Depends(require),
    ) -> Envelope[NativeConsoleSessionOut]:
        authorize(claims, _ALLOWED_ROLES)
        token = request.headers.get("authorization", "")[7:].strip()
        if not token:
            raise Unauthorized("missing bearer token")
        # Validate the fixed target before setting a browser session.  Missing
        # component credentials fail closed and never render a misleading frame.
        _config().validate()
        response.headers["Cache-Control"] = "no-store"
        response.set_cookie(
            _CONSOLE_COOKIE,
            token,
            max_age=_CONSOLE_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=bool(getattr(request.app.state.settings, "is_production", False)),
            path=CONSOLE_PREFIX,
        )
        return Envelope(data=NativeConsoleSessionOut(
            url=f"{CONSOLE_PREFIX}/",
            expires_in=_CONSOLE_MAX_AGE,
        ))

    @router.delete("/session", operation_id="operation_newapi_console_session_delete")
    async def delete_session(response: Response, claims: TokenClaims = Depends(require)) -> Response:
        authorize(claims, _ALLOWED_ROLES)
        response.delete_cookie(_CONSOLE_COOKIE, path=CONSOLE_PREFIX)
        response.status_code = 204
        response.headers["Cache-Control"] = "no-store"
        return response

    @router.api_route(
        "/{path:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    async def proxy(
        request: Request,
        path: str,
        claims: TokenClaims = Depends(require_console),
    ) -> Response:
        # Keep the dependency in the route even though the value is not used;
        # every vendor asset/API request must re-check the owning role/token.
        del claims
        return await NativeConsoleProxy(_config()).proxy(request, path)

    return router