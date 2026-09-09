"""Test-only defaults for direct Settings construction.

Production entrypoints use load_settings(), which requires an explicit
AITEAM_ENV. Unit tests that construct Settings directly retain a development
profile without inheriting a developer's ambient environment.
"""

import os

os.environ.setdefault("AITEAM_ENV", "development")
