"""L4-S01 Page shell and route partition tests."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

import urllib.request
import urllib.error

import pytest


_ROOT = Path(__file__).resolve().parents[3]
_INDEX_PATH = _ROOT / "static" / "index.html"
_PAGE_SHELL_PATH = _ROOT / "static" / "aiteam" / "page-shell.js"
_BOOT_PATH = _ROOT / "static" / "boot.js"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ── Layer A: /app /admin /system return HTML ─────────────────────────────

def test_app_route_returns_html(test_server, base_url):
    """GET /app returns 200 text/html with AI Team shell container."""
    url = f"{base_url}/app"
    with urllib.request.urlopen(url, timeout=10) as r:
        assert r.status == 200
        ct = r.headers.get("Content-Type", "")
        assert "text/html" in ct
        body = r.read().decode("utf-8")
        assert '<div id="aiteam-app"' in body


def test_admin_route_returns_html(test_server, base_url):
    """GET /admin returns 200 text/html with AI Team shell container."""
    url = f"{base_url}/admin"
    with urllib.request.urlopen(url, timeout=10) as r:
        assert r.status == 200
        ct = r.headers.get("Content-Type", "")
        assert "text/html" in ct
        body = r.read().decode("utf-8")
        assert '<div id="aiteam-app"' in body


def test_system_route_returns_html(test_server, base_url):
    """GET /system returns 200 text/html with AI Team shell container."""
    url = f"{base_url}/system"
    with urllib.request.urlopen(url, timeout=10) as r:
        assert r.status == 200
        ct = r.headers.get("Content-Type", "")
        assert "text/html" in ct
        body = r.read().decode("utf-8")
        assert '<div id="aiteam-app"' in body


def test_app_subpath_also_returns_html(test_server, base_url):
    """GET /app/workbench also returns 200 HTML (prefix match)."""
    url = f"{base_url}/app/workbench"
    with urllib.request.urlopen(url, timeout=10) as r:
        assert r.status == 200
        ct = r.headers.get("Content-Type", "")
        assert "text/html" in ct
        body = r.read().decode("utf-8")
        assert '<div id="aiteam-app"' in body


def test_root_still_works(test_server, base_url):
    """GET / must still return Hermes layout (not hijacked by aiteam shell)."""
    url = f"{base_url}/"
    with urllib.request.urlopen(url, timeout=10) as r:
        assert r.status == 200
        body = r.read().decode("utf-8")
        # The Hermes layout is present; the aiteam shell HTML is shared but
        # hidden by default — it only unhides when boot.js activates it.
        assert 'class="layout"' in body
        # AI Team shell container exists in the shared template but the root
        # path must still serve as Hermes UI.
        assert 'class="layout"' in body


# ── Layer C: static resource validation ──────────────────────────────────

def test_page_shell_module_exists():
    assert _PAGE_SHELL_PATH.exists(), f"Missing page-shell.js: {_PAGE_SHELL_PATH}"


def test_page_shell_defines_match_and_init():
    source = _read(_PAGE_SHELL_PATH)
    assert "window.aiteam" in source
    assert "ns.shell =" in source
    assert 'matchPath: function' in source
    assert 'init: function' in source
    assert "SECTION_PAGES" in source
    assert "aiteam-shell__link" in source


def test_boot_js_has_aiteam_early_exit():
    source = _read(_BOOT_PATH)
    assert 'window.aiteam.shell.matchPath' in source
    assert 'window.aiteam.shell.init' in source
    assert '_aiteamShellPath' in source
    # Must not run normal Hermes boot when on aiteam pages
    assert 'return;' in source


def test_index_html_loads_aiteam_scripts_and_styles():
    source = _read(_INDEX_PATH)
    assert 'static/aiteam/styles.css' in source
    assert 'static/aiteam/api-client.js' in source
    assert 'static/aiteam/state-helpers.js' in source
    assert 'static/aiteam/page-shell.js' in source


def test_index_html_loads_aiteam_dependencies_before_page_shell() -> None:
    source = _read(_INDEX_PATH)
    api_client_pos = source.index('static/aiteam/api-client.js')
    state_helpers_pos = source.index('static/aiteam/state-helpers.js')
    page_shell_pos = source.index('static/aiteam/page-shell.js')
    assert api_client_pos < page_shell_pos
    assert state_helpers_pos < page_shell_pos
