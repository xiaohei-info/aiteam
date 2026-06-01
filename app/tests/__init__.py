"""Shared test package namespace for base and aiteam test routes."""

from pathlib import Path


_BASE_TESTS_DIR = Path(__file__).with_name("base")
if _BASE_TESTS_DIR.is_dir():
    # Keep legacy imports like ``tests.conftest`` and ``tests.test_x`` working
    # after the Hermes-webui suite moved under tests/base/.
    __path__.append(str(_BASE_TESTS_DIR))
