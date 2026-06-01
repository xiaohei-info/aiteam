import importlib


def test_base_test_route_exposes_new_and_legacy_import_paths():
    base_port = importlib.import_module("tests.base._pytest_port")
    legacy_port = importlib.import_module("tests._pytest_port")
    base_conftest = importlib.import_module("tests.base.conftest")
    legacy_conftest = importlib.import_module("tests.conftest")

    assert base_port.BASE == legacy_port.BASE
    assert base_port.TEST_STATE_DIR == legacy_port.TEST_STATE_DIR
    assert base_conftest.TEST_BASE == legacy_conftest.TEST_BASE
