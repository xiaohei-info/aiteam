from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]


def test_env_template_documents_admin_password():
    source = (ROOT / "app" / ".env.example").read_text(encoding="utf-8")
    assert "HERMES_WEBUI_PASSWORD=AIFred_2026" in source
