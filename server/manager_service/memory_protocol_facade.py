"""Hindsight protocol adapter backed by Manager MemoryService.

Pi Hindsight speaks the native ``/v1/default/banks/...`` protocol.  Manager's
canonical memory authorization already resolves the employee snapshot, policy,
and bank for every operation, so this adapter only translates the protocol and
never treats the bank in the plugin URL as authority.
"""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import Request
from starlette.responses import Response

from shared.contracts.tenancy import TenantContext
from shared.errors import Forbidden, RequestTooLarge

from .hindsight_client import HindsightUnavailable
from .hindsight_operation_policy import parse_operation_body
from .memory_service import MemoryService

_BANK_PATH = re.compile(r"^v1/default/banks/([A-Za-z0-9_-]{1,128})/(profile|memories/recall|memories)$")
_MAX_BODY_BYTES = 256 * 1024
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024


class MemoryProtocolFacade:
    """Translate the Hindsight plugin wire contract to MemoryService calls."""

    def __init__(self, memory_service: MemoryService):
        self._memory = memory_service

    @staticmethod
    def _bank(ctx: TenantContext, employee_id: str) -> str:
        from .hindsight_credentials import derive_hindsight_bank_id

        return derive_hindsight_bank_id(ctx.tenant_id, ctx.user_id, employee_id, ctx.enterprise_id)

    @staticmethod
    def _limit(payload: dict[str, Any]) -> int:
        max_tokens = payload.get("max_tokens", 4096)
        if not isinstance(max_tokens, int) or isinstance(max_tokens, bool):
            raise Forbidden("Hindsight recall max_tokens is invalid")
        return max(1, min(100, (max_tokens + 255) // 256))

    async def proxy(
        self,
        request: Request,
        path: str,
        *,
        ctx: TenantContext,
        employee_id: str,
    ) -> Response:
        raw_path = request.scope.get("raw_path", b"")
        match = _BANK_PATH.fullmatch(path)
        if match is None or b"%" in raw_path or request.query_params:
            raise Forbidden("Hindsight path is outside the memory protocol adapter")

        _requested_bank, suffix = match.groups()
        operation = {"profile": "profile", "memories/recall": "recall", "memories": "retain"}[suffix]
        if request.method != ("GET" if operation == "profile" else "POST"):
            raise Forbidden("Hindsight method is not supported by the memory protocol adapter")

        # The plugin needs a bank-shaped URL.  It is a protocol placeholder only:
        # MemoryService derives the real bank from the authenticated tenant/member
        # and the fixed employee session below.
        actual_bank = self._bank(ctx, employee_id)
        if operation == "profile":
            if request.headers.get("content-length") not in (None, "0"):
                raise Forbidden("Hindsight profile does not accept a body")
            # Calling the canonical service authorizer makes profile availability
            # obey the same current employee grant and memory policy as recall.
            self._memory.runtime_context(ctx, employee_id=employee_id)
            result = {
                "bank_id": actual_bank,
                "name": actual_bank,
                "mission": "",
                "disposition": {"skepticism": 3, "literalism": 3, "empathy": 3},
            }
            return self._json(result)

        if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
            raise Forbidden("Hindsight requires a JSON operation body")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > _MAX_BODY_BYTES:
                raise RequestTooLarge("Hindsight request body exceeds the limit")
        payload = parse_operation_body(operation, bytes(body))

        if operation == "recall":
            result = self._memory.recall(
                ctx,
                employee_id=employee_id,
                query=payload["query"],
                limit=self._limit(payload),
            )
            return self._json(result)

        items = payload.get("items")
        if not isinstance(items, list) or not items:
            raise Forbidden("Hindsight retain requires at least one item")
        operation_ids: list[str] = []
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("content"), str):
                raise Forbidden("Hindsight retain item is invalid")
            metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            # The existing Manager retain contract is one memory per call.  Keep
            # the plugin's batch protocol and acknowledge each item through that
            # canonical operation; no second retention implementation is created.
            ack = self._memory.retain(
                ctx,
                employee_id=employee_id,
                content=item["content"],
                metadata={**metadata, **{
                    key: item[key] for key in ("context", "timestamp", "document_id", "update_mode", "tags", "entities")
                    if key in item
                }},
            )
            if not isinstance(ack, dict) or not isinstance(ack.get("operation_id"), str):
                raise HindsightUnavailable("Manager memory retain returned an invalid acknowledgement")
            operation_ids.append(ack["operation_id"])
        return self._json({
            "success": True,
            "async": True,
            "operation_id": operation_ids[0],
        })

    @staticmethod
    def _json(value: Any) -> Response:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > _MAX_RESPONSE_BYTES:
            raise HindsightUnavailable("Hindsight response exceeds the limit")
        return Response(encoded, media_type="application/json", headers={"Cache-Control": "no-store"})
