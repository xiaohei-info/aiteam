"""connector_probe.py branch coverage — issue #296 local validation."""

from __future__ import annotations

import json

import pytest

from manager_service.connector_probe import (
    AUTH_FLOW,
    AUTH_SCHEMES,
    known_auth_scheme_for_preset,
    parse_config_schema,
    validate_auth_scheme,
    validate_connector,
    validate_connector_id,
)


class TestValidateConnectorId:
    def test_valid_ids_pass(self):
        for cid in ("slack", "feishu", "my-connector", "jira2", "a" * 64):
            assert validate_connector_id(cid) == [], cid

    def test_empty_rejected(self):
        issues = validate_connector_id("")
        assert any(i.code == "connector_id_required" for i in issues)

    def test_uppercase_rejected(self):
        issues = validate_connector_id("Slack")
        assert any(i.code == "connector_id_invalid" for i in issues)

    def test_leading_digit_rejected(self):
        issues = validate_connector_id("2slack")
        assert any(i.code == "connector_id_invalid" for i in issues)

    def test_too_long_rejected(self):
        issues = validate_connector_id("a" * 65)
        assert any(i.code == "connector_id_invalid" for i in issues)

    def test_spaces_rejected(self):
        issues = validate_connector_id("my connector")
        assert any(i.code == "connector_id_invalid" for i in issues)


class TestValidateAuthScheme:
    def test_supported_schemes_normalized(self):
        for s in AUTH_SCHEMES:
            issues, norm = validate_auth_scheme(s)
            assert issues == []
            assert norm == s

    def test_case_insensitive(self):
        issues, norm = validate_auth_scheme("OAuth2")
        assert issues == []
        assert norm == "oauth2"

    def test_unsupported_rejected(self):
        issues, norm = validate_auth_scheme("ftp")
        assert norm is None
        assert any(i.code == "auth_scheme_unsupported" for i in issues)

    def test_none_is_allowed_but_returns_none(self):
        issues, norm = validate_auth_scheme(None)
        assert issues == []
        assert norm is None


class TestParseConfigSchema:
    def test_dict_passthrough(self):
        issues, parsed = parse_config_schema({"type": "object"})
        assert issues == []
        assert parsed == {"type": "object"}

    def test_json_string_parsed(self):
        issues, parsed = parse_config_schema('{"type":"object"}')
        assert issues == []
        assert parsed == {"type": "object"}

    def test_none_returns_none(self):
        issues, parsed = parse_config_schema(None)
        assert issues == []
        assert parsed is None

    def test_invalid_json_rejected(self):
        issues, parsed = parse_config_schema("{not json")
        assert parsed is None
        assert any(i.code == "config_schema_parse" for i in issues)

    def test_non_object_json_rejected(self):
        issues, parsed = parse_config_schema(json.dumps([1, 2, 3]))
        assert parsed is None
        assert any(i.code == "config_schema_type" for i in issues)

    def test_non_string_non_dict_rejected(self):
        issues, parsed = parse_config_schema(12345)
        assert parsed is None


class TestValidateConnector:
    def test_valid_oauth2_with_schema(self):
        result = validate_connector(
            "feishu",
            auth_scheme="oauth2",
            config_schema_json={"properties": {"app_id": {"type": "string"}}},
        )
        assert result.success is True
        assert result.auth_scheme == "oauth2"
        assert result.flow == "authorization_code"
        assert result.ok is True
        assert result.config_schema == {"properties": {"app_id": {"type": "string"}}}

    def test_invalid_id_fails_before_auth_scheme(self):
        result = validate_connector("___bad", auth_scheme="oauth2")
        assert result.success is False
        assert any(i.code == "connector_id_invalid" for i in result.issues)

    def test_missing_auth_scheme_fails(self):
        result = validate_connector("slack")
        assert result.success is False
        assert any(i.code == "auth_scheme_missing" for i in result.issues)

    def test_api_key_flow(self):
        result = validate_connector("jira", auth_scheme="api_key")
        assert result.success is True
        assert result.flow == "static_token"

    def test_mcp_flow(self):
        result = validate_connector("my-mcp", auth_scheme="mcp")
        assert result.success is True
        assert result.flow == "mcp_handshake"

    def test_webhook_flow(self):
        result = validate_connector("my-hook", auth_scheme="webhook")
        assert result.success is True
        assert result.flow == "callback_registration"

    def test_bad_auth_and_schema_both_reported(self):
        result = validate_connector("Acme", auth_scheme="ftp",
                                    config_schema_json="broken")
        assert result.success is False
        codes = {i.code for i in result.issues}
        assert "connector_id_invalid" in codes
        assert "auth_scheme_unsupported" in codes
        assert "config_schema_parse" in codes


class TestKnownAuthSchemeForPreset:
    def test_mapping(self):
        assert known_auth_scheme_for_preset("preset_oauth") == "oauth2"
        assert known_auth_scheme_for_preset("preset_apikey") == "api_key"
        assert known_auth_scheme_for_preset("preset_mcp") == "mcp"
        assert known_auth_scheme_for_preset("preset_webhook") == "webhook"
        assert known_auth_scheme_for_preset("preset_unknown") is None
        assert known_auth_scheme_for_preset(None) is None


class TestModuleConstants:
    def test_auth_schemes_complete(self):
        assert set(AUTH_SCHEMES) == {"oauth2", "api_key", "mcp", "webhook"}

    def test_each_scheme_has_flow_mapping(self):
        for s in AUTH_SCHEMES:
            assert s in AUTH_FLOW
            assert "flow" in AUTH_FLOW[s]
            assert "note" in AUTH_FLOW[s]
