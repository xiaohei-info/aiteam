"""pytest 引导：把 server/ 加入 sys.path，使 `import shared...` 可用。

镜像 app/ 的 path 约定，但 server/ 是 v1 全新包根，与 app/ 完全隔离（不互相 import）。
"""

import os
import sys

_SERVER_ROOT = os.path.dirname(os.path.abspath(__file__))
if _SERVER_ROOT not in sys.path:
    sys.path.insert(0, _SERVER_ROOT)
