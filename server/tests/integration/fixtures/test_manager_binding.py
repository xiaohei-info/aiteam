"""Regression tests for the test-only shared Manager binding harness."""

from starlette.datastructures import State

from tests.integration.fixtures.manager_binding import clear_binding_caches


class _App:
    def __init__(self) -> None:
        self.state = State()


def test_clear_binding_caches_uses_starlette_state_mapping() -> None:
    app = _App()
    app.state._auth_service = object()
    app.state._hindsight_runtime_service = object()
    app.state._hindsight_lease_store = object()
    app.state._operator_catalog = object()

    clear_binding_caches(app)

    assert not hasattr(app.state, "_auth_service")
    assert not hasattr(app.state, "_hindsight_runtime_service")
    assert not hasattr(app.state, "_hindsight_lease_store")
    assert hasattr(app.state, "_operator_catalog")
