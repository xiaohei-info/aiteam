from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PAGE_SHELL_PATH = ROOT / "static" / "aiteam" / "page-shell.js"
PAGES_DIR = ROOT / "static" / "aiteam" / "pages"

EXPECTED_PAGE_MODULES = {
    "app-workbench.js": ["getWorkbench", "/app/marketplace", "前往人才市场"],
    "app-marketplace.js": ["getTalentTemplates", "立即招募", "RATE_LIMITED"],
    "app-template-detail.js": ["getTemplate", "default_memory_config", "立即招募"],
    "app-chat.js": ["getConversation", "createRun", "tool_call", "getRunEvents"],
    "app-group.js": ["submitGroupMessage", "routing_decided", "task_created", "result_merged"],
}

FORBIDDEN_RUNTIME_ROUTES = [
    "/api/chat/start",
    "/api/chat/cancel",
    "/api/session/",
    "/api/sessions",
    "/api/runtime",
    "/api/kanban",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_page_shell_registers_p02_to_p06_route_modules() -> None:
    source = _read(PAGE_SHELL_PATH)
    expected_routes = [
        "app-workbench.js",
        "app-marketplace.js",
        "app-template-detail.js",
        "app-chat.js",
        "app-group.js",
        "handler: 'appWorkbench'",
        "handler: 'appMarketplace'",
        "handler: 'appTemplateDetail'",
        "handler: 'appChat'",
        "handler: 'appGroup'",
    ]
    for snippet in expected_routes:
        assert snippet in source, f"Missing P02-P06 page-shell route wiring snippet: {snippet}"



def test_page_shell_app_nav_exposes_workbench_marketplace_chat_group_office_org() -> None:
    source = _read(PAGE_SHELL_PATH)
    for snippet in [
        "'/app/workbench'",
        "'/app/marketplace'",
        "'/app/chat'",
        "'/app/group'",
        "'/app/office'",
        "'/app/org'",
    ]:
        assert snippet in source, f"Missing app navigation link: {snippet}"



def test_p02_to_p06_page_modules_exist_and_use_team_panel_contracts() -> None:
    for filename, required_snippets in EXPECTED_PAGE_MODULES.items():
        path = PAGES_DIR / filename
        assert path.exists(), f"Missing expected app page module: {path}"
        source = _read(path)
        for snippet in required_snippets:
            assert snippet in source, f"{filename} missing required contract/UX snippet: {snippet}"
        for forbidden in FORBIDDEN_RUNTIME_ROUTES:
            assert forbidden not in source, f"{filename} must not reference runtime/private route {forbidden}"



def test_group_page_uses_shared_timeline_client_contract() -> None:
    source = _read(PAGES_DIR / "app-group.js")
    for snippet in [
        "ns.timeline.connect",
        "ns.api.getRunEvents",
        "route_hint",
        "sender_id",
        "message: { text: text }",
    ]:
        assert snippet in source, f"Group page missing timeline/group contract snippet: {snippet}"



def test_chat_page_declares_upload_quote_retry_and_tool_call_ux() -> None:
    source = _read(PAGES_DIR / "app-chat.js")
    for snippet in [
        "ns.api.upload",
        "引用历史",
        "重试发送",
        "tool_call",
        "停止补拉",
    ]:
        assert snippet in source, f"Chat page missing expected UX snippet: {snippet}"
