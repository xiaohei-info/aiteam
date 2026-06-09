from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
README = ROOT / "README.md"
ENV_EXAMPLE = ROOT / ".env.example"
FIXTURES = ROOT / "tests" / "aiteam" / "layer1_data" / "fixtures.py"
REQUIREMENTS_DEV = ROOT / "requirements-dev.txt"


def test_backend_verification_docs_match_repo_prerequisites():
    readme = README.read_text(encoding="utf-8")
    env_example = ENV_EXAMPLE.read_text(encoding="utf-8")
    fixtures = FIXTURES.read_text(encoding="utf-8")
    requirements_dev = REQUIREMENTS_DEV.read_text(encoding="utf-8")

    assert "psycopg2-binary" in requirements_dev
    assert "pip install -r app/requirements-dev.txt" in readme
    assert "python -m venv app/.venv" in readme
    assert "source app/.venv/bin/activate" in readme
    assert "docker" in readme.lower()
    assert "app/tests/aiteam/layer1_data/fixtures.py" in readme
    assert "TEST_DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test" in readme
    assert "TEST_DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test" in env_example
    assert "DATABASE_URL=postgresql://aiteam:aiteam_test@127.0.0.1:5433/aiteam_test" in env_example
    assert '_DB_PASSWORD = "aiteam_test"' in fixtures
