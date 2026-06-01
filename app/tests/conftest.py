"""Compatibility shim for shared pytest fixtures.

The Hermes-webui base suite lives under ``tests/base`` now, but pytest still
loads ``tests/conftest.py`` for the whole ``app/tests`` tree. Re-export the
base fixtures here so existing collection semantics stay unchanged.
"""

from tests.base.conftest import *  # noqa: F401,F403
