"""pytest 引导：把 server/ 加入 sys.path，使 `import shared...` 可用。

镜像 app/ 的 path 约定，但 server/ 是 v1 全新包根，与 app/ 完全隔离（不互相 import）。
"""

import os
import sys

_SERVER_ROOT = os.path.dirname(os.path.abspath(__file__))
if _SERVER_ROOT not in sys.path:
    sys.path.insert(0, _SERVER_ROOT)

# Operation app builds its system-account repository at import time. Tests use
# explicit non-secret defaults so app assembly checks do not depend on local env.
os.environ.setdefault("OPERATION_SYSTEM_USERNAME", "sysadmin")
os.environ.setdefault("OPERATION_SYSTEM_PASSWORD", "changeme-me")
os.environ.setdefault("SERVICE_TOKEN", "test-service-token")

# FAIL-CLOSED downstream dependency: shared/crypto/_default_fernet and
# manager_service._build_operator_catalog must not fall back to dev keys / fake clients in
# tests. Tests intentionally proving the fail-closed path must unset these per-test.
os.environ.setdefault("MANAGER_CREDENTIAL_KEY", "mrykCW-P5krNV2nZgyx9CuuOimy4LA5BOJ0rS4i_JHo=")
os.environ.setdefault("OPERATOR_URL", "http://test-operator.local:8000")
