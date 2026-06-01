"""Layer3 Gateway test fixtures.

Reuses Layer2 conftest (DB + seeded enterprise data) and adds
Gateway-specific fixtures.
"""

import pytest

pytest_plugins = ["tests.aiteam.layer2_team_panel.conftest"]
