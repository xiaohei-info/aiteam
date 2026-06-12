"""Layer4 frontend/BFF fixtures.

The parent ``tests/aiteam/conftest.py`` pulls in a *no-op* ``test_server``
fixture from the Layer2 suite (Layer2 only needs PostgreSQL, not the web
server). Layer4 page/route tests, however, make real HTTP requests against a
running server via ``base_url``. Re-import the real session-scoped autouse
``test_server`` from the base suite so it shadows the Layer2 no-op for this
subtree only.
"""

from tests.base.conftest import test_server, base_url  # noqa: F401
