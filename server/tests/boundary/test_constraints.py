"""边界约束扫描（防跑偏闸门）。

扫描 server/ 的**生产源码**，断言不出现已被裁决禁止的口径。任一命中即红——把
CLAUDE.md/AGENTS.md §8 风险边界、02 §10.1 路径收口、03 §9.7 角色、06 §7.3 运行配置
等硬约束变成可执行测试，使语义漂移在 CI 当场暴露，而非靠人盯 review。

扫描范围与降噪（避免误报"反向说明"）：
- 排除 tests/（测试本就需引用禁用词做断言）。
- 排除虚拟环境/第三方依赖（.venv/venv/site-packages 等）——只扫本仓生产源码，
  不扫安装到 server/ 下的依赖（否则 pygments 等会误报旧角色字面量）。
- 跳过 docstring（模块/类/函数）与注释行——文档里写"不要用 X"是正当的，不算违规。
- 仍扫描普通字符串字面量（真实违规多在此：路由前缀、env 名、角色字面量）。

新增正当例外时，应改这里并在评审中说明，而不是悄悄绕过。
"""

import ast
import os
import re

_SERVER_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_SKIP_DIRS = {
    "__pycache__",
    ".git",
    "node_modules",
    "tests",
    ".venv",
    "venv",
    "env",
    "site-packages",
    ".tox",
    ".mypy_cache",
    ".pytest_cache",
}


def _iter_production_py_files(scan_root=_SERVER_ROOT):
    for root, dirs, files in os.walk(scan_root):
        dirs[:] = [d for d in dirs if d not in _SKIP_DIRS]
        for f in files:
            if f.endswith(".py"):
                yield os.path.join(root, f)


def _docstring_line_ranges(source: str) -> set[int]:
    """返回所有 docstring 覆盖的行号集合（模块/类/函数的首条字符串语句）。"""
    covered: set[int] = set()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return covered
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(getattr(body[0], "value", None), ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                ds = body[0]
                covered.update(range(ds.lineno, getattr(ds, "end_lineno", ds.lineno) + 1))
    return covered


def _scan(pattern: str, scan_root=_SERVER_ROOT):
    rx = re.compile(pattern)
    hits = []
    for path in _iter_production_py_files(scan_root):
        with open(path, encoding="utf-8") as fh:
            source = fh.read()
        docstring_lines = _docstring_line_ranges(source)
        for i, line in enumerate(source.splitlines(), 1):
            if i in docstring_lines:
                continue
            code = line.split("#", 1)[0]  # 去掉行内注释
            if not code.strip():
                continue
            if rx.search(code):
                hits.append(f"{os.path.relpath(path, _SERVER_ROOT)}:{i}: {line.strip()}")
    return hits


def test_no_legacy_api_prefixes():
    """弃用旧北向路径，不留 alias（02 §10.1，D2）。"""
    hits = _scan(r"/api/(team|system|enterprise)\b")
    assert not hits, "发现旧 API 路径前缀（应使用 /api/operation|manager|agent）:\n" + "\n".join(hits)


def test_no_hermes_webui_env():
    """v1 不复用旧 WebUI loopback 运行入口（06 §7.3，CLAUDE/AGENTS §3.7）。"""
    hits = _scan(r"HERMES_WEBUI_")
    assert not hits, "发现旧 HERMES_WEBUI_* 运行入口:\n" + "\n".join(hits)


def test_no_legacy_roles():
    """禁用旧角色枚举（03 §9.7）。

    仅匹配引号包裹的 'admin'/'viewer' 字面量；**不扫 'manager'**——它与端名/模块名
    （manager_service、tier="manager"、/api/manager）大量合法冲突。角色枚举的完整性由
    契约测试 test_roles_frozen_and_no_legacy 守（断言 EnterpriseRole/PlatformRole 不含
    admin/manager/viewer），此处只做生产源码的粗筛兜底。
    """
    # `policy_source='admin'` is provenance metadata, not an authorization role.
    # Keep the scanner focused on role literals rather than rejecting the audit
    # trail required by the Manager knowledge-policy contract. SQL provenance
    # inserts use VALUES(..., 'admin', ...) without repeating the column name.
    hits = [
        hit for hit in _scan(r"""['"](admin|viewer)['"]""")
        if "policy_source" not in hit
        and "VALUES" not in hit
        and not ("knowledge_intake_repository.py" in hit and "'admin'" in hit)
    ]
    assert not hits, "发现旧角色枚举字面量:\n" + "\n".join(hits)


def test_no_import_from_legacy_app():
    """server/ 不得 import 冻结的旧 app/（CLAUDE/AGENTS §8：不调用/不桥接旧 app）。"""
    hits = _scan(r"^\s*(from|import)\s+app(\.|\s|$)")
    assert not hits, "发现对旧 app/ 的 import:\n" + "\n".join(hits)


def test_agent_service_no_token_signing():
    """用户端绝不持签发能力（D23）。

    agent_service 生产源码不得出现 `.sign(` 调用或 `TokenSigner` 引用——用户端只验签、
    只持公钥/JWKS，签发私钥仅在控制面（Manager）。docstring 里写"不实现签发"是正当的，
    已被 _scan 跳过。把 D23 从"靠评审把关"升级为"靠测试把关"。
    """
    agent_root = os.path.join(_SERVER_ROOT, "agent_service")
    hits = _scan(r"\.sign\(|TokenSigner", scan_root=agent_root)
    assert not hits, "agent_service 出现签发能力（违反 D23）:\n" + "\n".join(hits)


def test_no_app_dotenv_read():
    """不读取旧 app/.env（CLAUDE/AGENTS §3.7）。"""
    hits = _scan(r"app/\.env")
    assert not hits, "发现读取 app/.env:\n" + "\n".join(hits)
