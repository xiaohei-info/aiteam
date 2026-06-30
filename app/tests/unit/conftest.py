"""Unit-level conftest — disable the session-wide web server fixture.

Pure domain tests (state machines, value objects) don't need the full
Hermes web server. The root conftest's autouse ``test_server`` fixture
tries to spawn it and times out in environments without the agent runtime.
Override it here so unit tests run in isolation.
"""
import pytest


@pytest.fixture(scope="session", autouse=True)
def test_server():
    """No-op: unit tests don't need the test server."""
    yield None
