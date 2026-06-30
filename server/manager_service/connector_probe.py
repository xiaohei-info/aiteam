"""ConnectorProbeService: real validation on the Manager side (issue #296).

D18/Architecture line: Manager manages connector "admin-face truth" WITHOUT making
outbound calls to external connector services; credential bodies belong to M5, real
connectivity is executed on the user side. So this module only does "locally
reachable local validation":

  1. connector_id naming semantics (DB/RLS friendly identifier)
  2. auth_scheme enum validation + connection flow classification
  3. config_schema_json parse + structural validation
  4. failures -> explicit failure reason + error code; writes into test record
     and status (connected/error)

ConnectorProbeService keeps ProbeResult pure (no I/O) so it is trivially unit-testable
and keeps the validate_connector() entry point deterministic.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

AUTH_SCHEMES: tuple[str, ...] = ("oauth2", "api_key", "mcp", "webhook")

AUTH_FLOW: dict[str, dict[str, str]] = {
    "oauth2": {
        "flow": "authorization_code",
        "note": "needs authorization-code callback + token exchange, creds -> M5",
    },
    "api_key": {
        "flow": "static_token",
        "note": "needs API Key / Secret on the connector side, creds -> M5",
    },
    "mcp": {
        "flow": "mcp_handshake",
        "note": "MCP server discovery + handshake (stdio/http), creds -> M5",
    },
    "webhook": {
        "flow": "callback_registration",
        "note": "register callback URL + verify signature, creds -> M5",
    },
}

_CONNECTOR_ID_RE = re.compile(r"^[a-z][a-z0-9_-]{1,63}$")

_KNOWN_PRESET_TYPE_TO_SCHEME: dict[str, str] = {
    "preset_oauth": "oauth2",
    "preset_apikey": "api_key",
    "preset_mcp": "mcp",
    "preset_webhook": "webhook",
}


@dataclass(frozen=True)
class ProbeIssue:
    code: str
    message: str


@dataclass
class ProbeResult:
    connector_id: str
    auth_scheme: str | None = None
    flow: str | None = None
    success: bool = False
    checked_at: float = field(default_factory=time.time)
    issues: list[ProbeIssue] = field(default_factory=list)
    config_schema: dict | None = None
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.success and not self.issues


def validate_connector_id(connector_id: str) -> list[ProbeIssue]:
    issues: list[ProbeIssue] = []
    if not isinstance(connector_id, str) or not connector_id:
        issues.append(ProbeIssue("connector_id_required", "connector_id required"))
        return issues
    if not _CONNECTOR_ID_RE.match(connector_id):
        issues.append(ProbeIssue(
            "connector_id_invalid",
            "connector_id must start with a-z and contain only a-z/0-9/_/-",
        ))
    return issues


def validate_auth_scheme(auth_scheme):
    if auth_scheme is None:
        return [], None
    normalized = str(auth_scheme).strip().lower()
    if normalized not in AUTH_SCHEMES:
        return [ProbeIssue(
            "auth_scheme_unsupported",
            f"auth_scheme '{auth_scheme}' not in supported values: {', '.join(AUTH_SCHEMES)}",
        )], None
    return [], normalized


def parse_config_schema(config_schema_json):
    if config_schema_json is None:
        return [], None
    if isinstance(config_schema_json, dict):
        return [], dict(config_schema_json)
    try:
        parsed = json.loads(config_schema_json)
    except (ValueError, TypeError) as exc:
        return [ProbeIssue("config_schema_parse", f"config_schema_json not valid JSON: {exc}")], None
    if not isinstance(parsed, dict):
        return [ProbeIssue("config_schema_type", "config_schema_json must parse to an object/dict")], None
    return [], parsed


def known_auth_scheme_for_preset(preset_type):
    if not preset_type:
        return None
    return _KNOWN_PRESET_TYPE_TO_SCHEME.get(str(preset_type).strip().lower())


def validate_connector(connector_id, auth_scheme=None, config_schema_json=None) -> ProbeResult:
    """Accumulate ALL validation issues for a single pass, then report together."""
    issues: list[ProbeIssue] = []
    issues.extend(validate_connector_id(connector_id))

    scheme_issues, normalized_scheme = validate_auth_scheme(auth_scheme)
    issues.extend(scheme_issues)
    schema_issues, parsed_schema = parse_config_schema(config_schema_json)
    issues.extend(schema_issues)

    if issues:
        return ProbeResult(
            connector_id=connector_id, success=False, issues=list(issues),
            message="; ".join(i.message for i in issues),
        )

    if normalized_scheme is None:
        issues.append(ProbeIssue(
            "auth_scheme_missing",
            "auth_scheme missing: provide an auth_scheme (oauth2/api_key/mcp/webhook)",
        ))
        return ProbeResult(
            connector_id=connector_id, success=False, issues=list(issues),
            message=issues[-1].message,
        )

    flow = AUTH_FLOW.get(normalized_scheme, {}).get("flow")
    return ProbeResult(
        connector_id=connector_id,
        auth_scheme=normalized_scheme,
        flow=flow,
        success=True,
        config_schema=parsed_schema,
        message=f"connector '{connector_id}' passed local validation "
                f"(auth_scheme={normalized_scheme}, flow={flow})",
    )
