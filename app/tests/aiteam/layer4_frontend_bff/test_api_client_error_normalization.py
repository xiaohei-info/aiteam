from pathlib import Path


ROOT = Path(__file__).resolve().parents[4]
API_CLIENT_PATH = ROOT / "app" / "static" / "aiteam" / "api-client.js"


def test_api_client_prefers_human_message_over_error_code_for_string_errors():
    source = API_CLIENT_PATH.read_text(encoding="utf-8")
    assert "if (typeof data.error === 'string')" in source
    assert "if (typeof data.message === 'string' && data.message)" in source, (
        "api-client should prefer backend message for string error codes like "
        "INSUFFICIENT_BALANCE so chat UI shows a human-readable reason"
    )

