"""Tests for the hand-curated API docs (Swagger UI + OpenAPI index).

The backend has no web framework, so the OpenAPI document is built from a
whitelist registry of endpoints actually consumed by the Team Panel frontend.
These tests pin:
- the registry produces a healthy number of real paths (~90),
- known endpoints across every domain are present with correct methods,
- all entries carry complete schemas (summary, responses, request bodies),
- the two GET routes (/api/docs, /api/openapi.json) are wired into handle_get.
"""
import io
import json
import re
from urllib.parse import urlparse

import api.routes as routes
from api import api_docs


class _FakeHandler:
    def __init__(self):
        self.status = None
        self.headers = {}
        self.wfile = io.BytesIO()

    def send_response(self, status):
        self.status = status

    def send_header(self, key, value):
        self.headers[key] = value

    def end_headers(self):
        pass

    def body_text(self):
        return self.wfile.getvalue().decode("utf-8")

    def json_body(self):
        return json.loads(self.body_text())


class TestOpenApiSpec:
    def test_spec_has_openapi_structure(self):
        spec = api_docs.build_openapi_spec()
        assert spec["openapi"].startswith("3.")
        assert spec["info"]["title"]
        assert isinstance(spec["paths"], dict)

    def test_finds_frontend_api_count(self):
        """The whitelist should contain ~90 endpoints actively used by the frontend."""
        paths = api_docs.build_openapi_spec()["paths"]
        op_count = sum(len(methods) for methods in paths.values())
        assert op_count >= 85, f"only {op_count} operations — registry may be incomplete"
        # Sanity: should not explode past reasonable upper bound
        assert op_count <= 120, f"{op_count} operations — too many, check for stale entries"

    def test_known_endpoints_present_with_methods(self):
        paths = api_docs.build_openapi_spec()["paths"]
        expected = {
            ("/api/team/workbench", "get"),
            ("/api/team/runs", "post"),
            ("/api/team/runs/{id}/stream", "get"),
            ("/api/team/employees/{id}", "patch"),
            ("/api/me", "get"),
            ("/api/auth/status", "get"),
            ("/api/auth/logout", "post"),
            ("/api/auth/refresh", "post"),
            ("/api/enterprises/current", "get"),
            ("/api/team/knowledge-bases", "get"),
            ("/api/system-admin/health", "get"),
            ("/health", "get"),
        }
        for path, method in expected:
            assert path in paths, f"missing path {path}"
            assert method in paths[path], f"{path} missing method {method}; has {sorted(paths[path])}"

    def test_docs_cover_current_frontend_northbound_paths(self):
        paths = api_docs.build_openapi_spec()["paths"]
        expected_paths = {
            "/health",
            "/api/auth/status",
            "/api/auth/login",
            "/api/auth/logout",
            "/api/auth/refresh",
            "/api/auth/login/wechat/init",
            "/api/auth/login/wechat/poll",
            "/api/auth/login/wechat/callback",
            "/api/auth/login/phone/send-code",
            "/api/auth/login/phone/verify",
            "/api/me",
            "/api/enterprises/current",
            "/api/auth/onboarding/create-enterprise",
            "/api/auth/onboarding/join-enterprise",
            "/api/enterprise-admin/invites",
            "/api/system-admin/health",
            "/api/system-admin/enterprises",
            "/api/system-admin/enterprises/export",
            "/api/system-admin/finance/overview",
            "/api/system-admin/finance/reports",
            "/api/system-admin/templates",
            "/api/system-admin/solutions",
            "/api/team/audit-events",
            "/api/team/billing/balance",
            "/api/team/billing/recharges",
            "/api/team/billing/usage/overview",
            "/api/team/billing/usage/records",
            "/api/team/billing/usage/records/export",
            "/api/team/employees",
            "/api/team/employees/export",
            "/api/team/office/feed",
            "/api/team/office/scene",
            "/api/team/runs/{id}/stream",
            "/api/team/settings",
        }
        missing = sorted(path for path in expected_paths if path not in paths)
        assert not missing, f"frontend-used northbound paths missing from docs: {missing}"

    def test_paths_are_clean(self):
        paths = api_docs.build_openapi_spec()["paths"]
        for p in paths:
            assert p.startswith("/api/") or p == "/health", f"non-api path leaked: {p!r}"
            assert " " not in p and "%" not in p, f"garbage literal leaked: {p!r}"
            for ph in re.findall(r"\{(\w+)\}", p):
                assert ph == "id" or ph == "mid", f"unexpected placeholder {ph!r} in {p!r}"

    def test_all_entries_have_summary_and_response(self):
        """Every whitelist entry must carry at least summary and 200 response."""
        paths = api_docs.build_openapi_spec()["paths"]
        for path, methods in paths.items():
            for method, op in methods.items():
                assert op.get("summary"), f"{method.upper()} {path} has no summary"
                # Must have at least one success response (2xx)
                has_2xx = any(str(code).startswith("2") for code in op.get("responses", {}))
                assert has_2xx, f"{method.upper()} {path} has no 2xx response; responses={list(op.get('responses', {}).keys())}"
                # Every summary should be readable (not an auto-generated method+path string)
                summary = op["summary"]
                assert not summary.startswith(f"{method.upper()} "), \
                    f"{method.upper()} {path} summary looks auto-generated: {summary!r}"

    def test_all_tags_covered(self):
        """Key business domains must have entries."""
        paths = api_docs.build_openapi_spec()["paths"]
        all_tags = set()
        for methods in paths.values():
            for op in methods.values():
                all_tags.update(op.get("tags", []))
        required_tags = {
            "auth", "onboarding", "workbench", "knowledge-base", "talent-market",
            "conversation", "org", "run", "upload", "employee", "skill",
            "billing", "connector", "llm", "collaboration", "solution",
            "memory", "settings", "enterprise-admin", "system-admin",
        }
        missing = required_tags - all_tags
        assert not missing, f"tags missing from registry: {missing}"

    def test_operations_carry_tag_and_responses(self):
        paths = api_docs.build_openapi_spec()["paths"]
        op = paths["/api/team/workbench"]["get"]
        assert op["tags"] == ["workbench"]
        assert "200" in op["responses"]

    def test_id_paths_declare_path_parameter(self):
        paths = api_docs.build_openapi_spec()["paths"]
        op = paths["/api/team/employees/{id}"]["patch"]
        assert any(prm["name"] == "id" and prm["in"] == "path" for prm in op["parameters"])

    def test_id_param_auto_added(self):
        """Paths containing {id} should automatically get an id path parameter."""
        paths = api_docs.build_openapi_spec()["paths"]
        for path, methods in paths.items():
            if "{id}" not in path:
                continue
            for method, op in methods.items():
                params = op.get("parameters", [])
                assert any(p["name"] == "id" and p["in"] == "path" for p in params), \
                    f"{method.upper()} {path} missing auto id path param"

    # ── Domain-specific contract checks ──

    def test_documents_team_run_request_and_response(self):
        paths = api_docs.build_openapi_spec()["paths"]
        op = paths["/api/team/runs"]["post"]
        assert "requestBody" in op
        req_schema = op["requestBody"]["content"]["application/json"]["schema"]
        assert "employee_id" in req_schema["required"]
        assert "conversation_id" in req_schema["required"]
        assert "message" in req_schema["required"]
        req_example = op["requestBody"]["content"]["application/json"]["example"]
        assert req_example["message"]["text"]
        success_201 = op["responses"]["201"]
        body_201 = success_201["content"]["application/json"]["schema"]
        assert "run_id" in body_201["required"]
        assert "stream_url" in body_201["required"]
        assert "events_url" in body_201["required"]
        assert "runtime_handle" in body_201["required"]
        assert "402" in op["responses"]

    def test_documents_knowledge_base_shapes(self):
        paths = api_docs.build_openapi_spec()["paths"]
        get_op = paths["/api/team/knowledge-bases"]["get"]
        list_200 = get_op["responses"]["200"]["content"]["application/json"]["schema"]
        assert "knowledge_bases" in list_200["required"]

        post_op = paths["/api/team/knowledge-bases"]["post"]
        post_req = post_op["requestBody"]["content"]["application/json"]["schema"]
        assert post_req["required"] == ["name"]
        assert "201" in post_op["responses"]

        search_op = paths["/api/team/knowledge-bases/{id}/search"]["get"]
        assert any(param["name"] == "q" and param["in"] == "query" for param in search_op["parameters"])
        assert "400" in search_op["responses"]

    def test_documents_onboarding_and_sse(self):
        paths = api_docs.build_openapi_spec()["paths"]

        onboarding = paths["/api/auth/onboarding/create-enterprise"]["post"]
        onboarding_req = onboarding["requestBody"]["content"]["application/json"]["schema"]
        assert "name" in onboarding_req["required"]
        onboarding_201 = onboarding["responses"]["201"]["content"]["application/json"]["schema"]
        assert "enterprise_id" in onboarding_201["required"]
        assert "role" in onboarding_201["required"]

        sse = paths["/api/team/runs/{id}/stream"]["get"]
        assert "text/event-stream" in sse["responses"]["200"]["content"]
        sse_example = sse["responses"]["200"]["content"]["text/event-stream"]["example"]
        assert "event: timeline" in sse_example

    def test_documents_workbench_group_and_settings(self):
        paths = api_docs.build_openapi_spec()["paths"]

        workbench = paths["/api/team/workbench"]["get"]
        wb_200 = workbench["responses"]["200"]["content"]["application/json"]["schema"]
        assert "navigation" in wb_200["properties"]
        assert "permissions" in wb_200["properties"]
        assert "empty_state" in wb_200["properties"]

        group_create = paths["/api/team/group-conversations"]["post"]
        group_req = group_create["requestBody"]["content"]["application/json"]["schema"]
        assert "title" in group_req["required"]
        assert "member_employee_ids" in group_req["required"]
        group_201 = group_create["responses"]["201"]["content"]["application/json"]["schema"]
        assert "conversation_id" in group_201["required"]

        settings = paths["/api/team/settings"]["get"]
        settings_200 = settings["responses"]["200"]["content"]["application/json"]["schema"]
        assert "invite_code" in settings_200["properties"]
        assert "notification_policy" in settings_200["properties"]

        settings_patch = paths["/api/team/settings"]["patch"]
        settings_patch_req = settings_patch["requestBody"]["content"]["application/json"]["schema"]
        assert "notification_policy" in settings_patch_req["properties"]

    def test_documents_billing_connectors_and_memories(self):
        paths = api_docs.build_openapi_spec()["paths"]

        balance = paths["/api/team/billing/balance"]["get"]
        balance_200 = balance["responses"]["200"]["content"]["application/json"]["schema"]
        assert "balance_cents" in balance_200["required"]
        assert "low_balance_warning" in balance_200["required"]

        recharge = paths["/api/team/billing/recharges"]["post"]
        recharge_req = recharge["requestBody"]["content"]["application/json"]["schema"]
        assert "amount" in recharge_req["required"]
        assert "payment_method" in recharge_req["required"]
        assert "201" in recharge["responses"]

        connectors = paths["/api/team/connectors"]["get"]
        conn_200 = connectors["responses"]["200"]["content"]["application/json"]["schema"]
        assert "connectors" in conn_200["required"]
        assert "definitions" in conn_200["required"]

        connector_grants = paths["/api/team/connectors/{id}/grants"]["patch"]
        grants_req = connector_grants["requestBody"]["content"]["application/json"]["schema"]
        assert "grant" in grants_req["required"]
        assert "revoke" in grants_req["required"]

        memories = paths["/api/team/memories"]["get"]
        mem_200 = memories["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in mem_200["required"]

        # Memory CRUD: create and update
        memory_create = paths["/api/team/memories"]["post"]
        memory_create_req = memory_create["requestBody"]["content"]["application/json"]["schema"]
        assert "employee_id" in memory_create_req["required"]
        assert "content" in memory_create_req["required"]

        memory_patch = paths["/api/team/memories/{id}"]["patch"]
        memory_patch_req = memory_patch["requestBody"]["content"]["application/json"]["schema"]
        assert "review" in memory_patch_req["properties"]

    def test_documents_enterprise_and_system_admin_surfaces(self):
        paths = api_docs.build_openapi_spec()["paths"]

        invites = paths["/api/enterprise-admin/invites"]["post"]
        invite_req = invites["requestBody"]["content"]["application/json"]["schema"]
        assert "phone" in invite_req["required"]
        assert "role" in invite_req["required"]
        assert "permissions" in invite_req["required"]

        sys_health = paths["/api/system-admin/health"]["get"]
        assert "description" in sys_health["responses"]["200"]

        sys_finance = paths["/api/system-admin/finance/overview"]["get"]
        finance_200 = sys_finance["responses"]["200"]["content"]["application/json"]["schema"]
        assert "summary" in finance_200["required"]
        assert "trend" in finance_200["required"]

        enterprises = paths["/api/system-admin/enterprises"]["get"]
        enterprises_200 = enterprises["responses"]["200"]["content"]["application/json"]["schema"]
        assert "enterprises" in enterprises_200["required"]

        ent_actions = paths["/api/system-admin/enterprises/{id}/actions"]["post"]
        action_req = ent_actions["requestBody"]["content"]["application/json"]["schema"]
        assert "action" in action_req["required"]
        action_200 = ent_actions["responses"]["200"]["content"]["application/json"]["schema"]
        assert "audit_event_id" in action_200["required"]

    def test_documents_auth_employee_and_template_surfaces(self):
        paths = api_docs.build_openapi_spec()["paths"]

        phone_send = paths["/api/auth/login/phone/send-code"]["post"]
        send_req = phone_send["requestBody"]["content"]["application/json"]["schema"]
        assert "phone" in send_req["required"]
        assert "200" in phone_send["responses"]

        phone_verify = paths["/api/auth/login/phone/verify"]["post"]
        verify_req = phone_verify["requestBody"]["content"]["application/json"]["schema"]
        assert "phone" in verify_req["required"]
        assert "code" in verify_req["required"]
        verify_200 = phone_verify["responses"]["200"]["content"]["application/json"]["schema"]
        assert "phone" in verify_200["required"]
        assert "access_token" in verify_200["required"]

        employees = paths["/api/team/employees"]["get"]
        employees_200 = employees["responses"]["200"]["content"]["application/json"]["schema"]
        assert "employees" in employees_200["required"]
        employee_create = paths["/api/team/employees"]["post"]
        create_req = employee_create["requestBody"]["content"]["application/json"]["schema"]
        assert "display_name" in create_req["required"]

        employee_detail = paths["/api/team/employees/{id}"]["get"]
        employee_detail_200 = employee_detail["responses"]["200"]["content"]["application/json"]["schema"]
        assert "profile_config" in employee_detail_200["properties"]

        templates = paths["/api/team/talent-market/templates"]["get"]
        templates_200 = templates["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in templates_200["required"]
        template_detail = paths["/api/team/talent-market/templates/{id}"]["get"]
        template_detail_200 = template_detail["responses"]["200"]["content"]["application/json"]["schema"]
        assert "default_skills" in template_detail_200["properties"]

        recruit = paths["/api/team/recruitments"]["post"]
        recruit_req = recruit["requestBody"]["content"]["application/json"]["schema"]
        assert "template_id" in recruit_req["required"]
        recruit_201 = recruit["responses"]["201"]["content"]["application/json"]["schema"]
        assert "employee_id" in recruit_201["required"]

    def test_documents_group_detail_connector_detail_and_memory_mutations(self):
        paths = api_docs.build_openapi_spec()["paths"]

        group_detail = paths["/api/team/group-conversations/{id}"]["get"]
        group_detail_200 = group_detail["responses"]["200"]["content"]["application/json"]["schema"]
        assert "members" in group_detail_200["properties"]
        assert "timeline" in group_detail_200["properties"]

        group_add_member = paths["/api/team/group-conversations/{id}/members"]["post"]
        add_req = group_add_member["requestBody"]["content"]["application/json"]["schema"]
        assert "employee_id" in add_req["required"]

        connector_create = paths["/api/team/connectors"]["post"]
        connector_create_req = connector_create["requestBody"]["content"]["application/json"]["schema"]
        assert "name" in connector_create_req["required"]
        assert "provider_code" in connector_create_req["required"]

        connector_detail = paths["/api/team/connectors/{id}"]["get"]
        connector_detail_200 = connector_detail["responses"]["200"]["content"]["application/json"]["schema"]
        assert "credential_mask" in connector_detail_200["properties"]
        connector_patch = paths["/api/team/connectors/{id}"]["patch"]
        connector_patch_req = connector_patch["requestBody"]["content"]["application/json"]["schema"]
        assert "config" in connector_patch_req["properties"]

        memory_create = paths["/api/team/memories"]["post"]
        memory_create_req = memory_create["requestBody"]["content"]["application/json"]["schema"]
        assert "employee_id" in memory_create_req["required"]
        assert "content" in memory_create_req["required"]

        memory_patch = paths["/api/team/memories/{id}"]["patch"]
        memory_patch_req = memory_patch["requestBody"]["content"]["application/json"]["schema"]
        assert "review" in memory_patch_req["properties"]

    def test_documents_frontend_long_tail_team_surfaces(self):
        paths = api_docs.build_openapi_spec()["paths"]

        workbench_state = paths["/api/team/workbench/state"]["post"]
        workbench_state_req = workbench_state["requestBody"]["content"]["application/json"]["schema"]
        assert "conversation_id" in workbench_state_req["properties"]
        assert "mark_read" in workbench_state_req["properties"]

        employee_conversations = paths["/api/team/employees/{id}/conversations"]["get"]
        assert "200" in employee_conversations["responses"]
        employee_conversations_200 = employee_conversations["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in employee_conversations_200["required"]

        retry_run = paths["/api/team/runs/{id}/retry"]["post"]
        retry_req = retry_run["requestBody"]["content"]["application/json"]["schema"]
        assert "idempotency_key" in retry_req["properties"]
        retry_200 = retry_run["responses"]["200"]["content"]["application/json"]["schema"]
        assert "retry_of_run_id" in retry_200["properties"]

        abort_run = paths["/api/team/runs/{id}/abort"]["post"]
        abort_req = abort_run["requestBody"]["content"]["application/json"]["schema"]
        assert "reason" in abort_req["properties"]
        abort_200 = abort_run["responses"]["200"]["content"]["application/json"]["schema"]
        assert "aborted" in abort_200["required"]

        uploads = paths["/api/team/uploads"]["post"]
        uploads_req = uploads["requestBody"]["content"]["application/json"]["schema"]
        assert "name" in uploads_req["required"]
        uploads_201 = uploads["responses"]["201"]["content"]["application/json"]["schema"]
        assert "asset_id" in uploads_201["required"]
        assert "preview_url" in uploads_201["properties"]

        office_scene = paths["/api/team/office/scene"]["get"]
        office_scene_200 = office_scene["responses"]["200"]["content"]["application/json"]["schema"]
        assert "scene" in office_scene_200["properties"]
        assert "refresh_cursor" in office_scene_200["properties"]

        office_feed = paths["/api/team/office/feed"]["get"]
        office_feed_200 = office_feed["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in office_feed_200["required"]
        assert "refresh_hint_ms" in office_feed_200["properties"]

        group_messages = paths["/api/team/group-conversations/{id}/messages"]["post"]
        group_messages_req = group_messages["requestBody"]["content"]["application/json"]["schema"]
        assert "text" in group_messages_req["properties"]
        group_messages_200 = group_messages["responses"]["200"]["content"]["application/json"]["schema"]
        assert "accepted" in group_messages_200["required"]

        billing_usage = paths["/api/team/billing/usage/overview"]["get"]
        billing_usage_200 = billing_usage["responses"]["200"]["content"]["application/json"]["schema"]
        assert "summary" in billing_usage_200["required"]

        billing_records = paths["/api/team/billing/usage/records"]["get"]
        billing_records_200 = billing_records["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in billing_records_200["required"]

        skills_catalog = paths["/api/team/skills/catalog"]["get"]
        skills_catalog_200 = skills_catalog["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in skills_catalog_200["required"]

        skills_install_create = paths["/api/team/skills/installs"]["post"]
        skills_install_create_req = skills_install_create["requestBody"]["content"]["application/json"]["schema"]
        assert "skill_code" in skills_install_create_req["required"]

        skills_install_patch = paths["/api/team/skills/installs/{id}"]["patch"]
        skills_install_patch_req = skills_install_patch["requestBody"]["content"]["application/json"]["schema"]
        assert "enabled" in skills_install_patch_req["properties"]

        solutions = paths["/api/team/solutions"]["get"]
        solutions_200 = solutions["responses"]["200"]["content"]["application/json"]["schema"]
        assert "solutions" in solutions_200["required"]

        apply_solution = paths["/api/team/solutions/{id}/apply"]["post"]
        apply_solution_req = apply_solution["requestBody"]["content"]["application/json"]["schema"]
        assert "mode" in apply_solution_req["required"]
        apply_solution_200 = apply_solution["responses"]["200"]["content"]["application/json"]["schema"]
        assert "apply_record_id" in apply_solution_200["required"]

        collaboration_template = paths["/api/team/collaboration-template"]["get"]
        collaboration_template_200 = collaboration_template["responses"]["200"]["content"]["application/json"]["schema"]
        assert "template" in collaboration_template_200["properties"]

        collaboration_template_save = paths["/api/team/collaboration-template"]["post"]
        collaboration_template_save_req = collaboration_template_save["requestBody"]["content"]["application/json"]["schema"]
        assert "planner_prompt" in collaboration_template_save_req["properties"]

        llm_providers = paths["/api/team/llm-providers"]["get"]
        llm_providers_200 = llm_providers["responses"]["200"]["content"]["application/json"]["schema"]
        assert "providers" in llm_providers_200["required"]

        llm_provider_create = paths["/api/team/llm-providers"]["post"]
        llm_provider_create_req = llm_provider_create["requestBody"]["content"]["application/json"]["schema"]
        assert "provider_key" in llm_provider_create_req["required"]

    def test_documents_system_admin_content_and_enterprise_surfaces(self):
        paths = api_docs.build_openapi_spec()["paths"]

        enterprises = paths["/api/system-admin/enterprises"]["get"]
        enterprises_200 = enterprises["responses"]["200"]["content"]["application/json"]["schema"]
        assert "enterprises" in enterprises_200["required"]

        enterprise_detail = paths["/api/system-admin/enterprises/{id}"]["get"]
        enterprise_detail_200 = enterprise_detail["responses"]["200"]["content"]["application/json"]["schema"]
        assert "id" in enterprise_detail_200["required"]
        assert "status" in enterprise_detail_200["properties"]

        enterprise_quota = paths["/api/system-admin/enterprises/{id}/quota"]["get"]
        enterprise_quota_200 = enterprise_quota["responses"]["200"]["content"]["application/json"]["schema"]
        assert "employee_quota" in enterprise_quota_200["required"]
        assert "storage_quota_mb" in enterprise_quota_200["required"]

        enterprise_export = paths["/api/system-admin/enterprises/export"]["get"]
        export_200 = enterprise_export["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in export_200["required"]
        assert "total" in export_200["required"]

        sys_templates_get = paths["/api/system-admin/templates"]["get"]
        sys_templates_get_200 = sys_templates_get["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in sys_templates_get_200["required"]

        sys_templates_post = paths["/api/system-admin/templates"]["post"]
        sys_templates_post_req = sys_templates_post["requestBody"]["content"]["application/json"]["schema"]
        assert "name" in sys_templates_post_req["required"]
        assert "role_name" in sys_templates_post_req["required"]

        sys_solutions_get = paths["/api/system-admin/solutions"]["get"]
        sys_solutions_get_200 = sys_solutions_get["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in sys_solutions_get_200["required"]

        sys_solutions_post = paths["/api/system-admin/solutions"]["post"]
        sys_solutions_post_req = sys_solutions_post["requestBody"]["content"]["application/json"]["schema"]
        assert "name" in sys_solutions_post_req["required"]
        assert "template_ids" in sys_solutions_post_req["required"]

    def test_documents_join_enterprise(self):
        paths = api_docs.build_openapi_spec()["paths"]
        join_op = paths["/api/auth/onboarding/join-enterprise"]["post"]
        join_req = join_op["requestBody"]["content"]["application/json"]["schema"]
        assert "invite_code" in join_req["required"]
        join_200 = join_op["responses"]["200"]["content"]["application/json"]["schema"]
        assert "enterprise_id" in join_200["required"]

    def test_documents_auth_login_and_wechat_flow(self):
        paths = api_docs.build_openapi_spec()["paths"]

        auth_status = paths["/api/auth/status"]["get"]
        auth_status_200 = auth_status["responses"]["200"]["content"]["application/json"]["schema"]
        assert "auth_enabled" in auth_status_200["required"]
        assert "logged_in" in auth_status_200["required"]

        # Password login
        login = paths["/api/auth/login"]["post"]
        login_req = login["requestBody"]["content"]["application/json"]["schema"]
        assert login_req["required"] == ["password"]
        assert "email" not in login_req["properties"]
        login_example = login["requestBody"]["content"]["application/json"]["example"]
        assert list(login_example) == ["password"]

        refresh = paths["/api/auth/refresh"]["post"]
        refresh_200 = refresh["responses"]["200"]["content"]["application/json"]["schema"]
        assert "access_token" in refresh_200["required"]
        assert "expires_in" in refresh_200["required"]

        logout = paths["/api/auth/logout"]["post"]
        logout_req = logout["requestBody"]["content"]["application/json"]["schema"]
        assert "all_devices" in logout_req["properties"]

        # WeChat init
        wx_init = paths["/api/auth/login/wechat/init"]["post"]
        wx_init_200 = wx_init["responses"]["200"]["content"]["application/json"]["schema"]
        assert "qr_url" in wx_init_200["required"]
        assert "expires_in" in wx_init_200["required"]

        # WeChat poll
        wx_poll = paths["/api/auth/login/wechat/poll"]["get"]
        assert any(p["name"] == "state" and p["in"] == "query" for p in wx_poll["parameters"])

        # WeChat callback
        wx_cb = paths["/api/auth/login/wechat/callback"]["post"]
        wx_cb_req = wx_cb["requestBody"]["content"]["application/json"]["schema"]
        assert "state" in wx_cb_req["required"]
        assert "code" in wx_cb_req["required"]
        wx_cb_200 = wx_cb["responses"]["200"]["content"]["application/json"]["schema"]
        assert "access_token" in wx_cb_200["required"]
        assert "wechat_union_id" in wx_cb_200["required"]
        assert "wechat_open_id" in wx_cb_200["required"]

        current_enterprise = paths["/api/enterprises/current"]["get"]
        current_enterprise_200 = current_enterprise["responses"]["200"]["content"]["application/json"]["schema"]
        assert "enterprise_id" in current_enterprise_200["required"]
        assert "role" in current_enterprise_200["required"]

        passkey_options = paths["/api/auth/passkey/options"]["post"]
        passkey_options_200 = passkey_options["responses"]["200"]["content"]["application/json"]["schema"]
        assert "ok" in passkey_options_200["required"]
        assert "publicKey" in passkey_options_200["required"]

        passkey_login = paths["/api/auth/passkey/login"]["post"]
        passkey_login_200 = passkey_login["responses"]["200"]["content"]["application/json"]["schema"]
        assert "ok" in passkey_login_200["required"]

    def test_documents_real_health_and_system_export_shape(self):
        paths = api_docs.build_openapi_spec()["paths"]

        health = paths["/health"]["get"]
        assert any(param["name"] == "deep" and param["in"] == "query" for param in health["parameters"])

        export_enterprises = paths["/api/system-admin/enterprises/export"]["get"]
        export_200 = export_enterprises["responses"]["200"]["content"]["application/json"]["schema"]
        assert "items" in export_200["required"]
        assert "total" in export_200["required"]

    def test_documents_onboarding_flow(self):
        paths = api_docs.build_openapi_spec()["paths"]

        probe = paths["/api/onboarding/probe"]["post"]
        probe_req = probe["requestBody"]["content"]["application/json"]["schema"]
        assert "provider" in probe_req["required"]
        assert "base_url" in probe_req["required"]

        oauth_start = paths["/api/onboarding/oauth/start"]["post"]
        oauth_start_req = oauth_start["requestBody"]["content"]["application/json"]["schema"]
        assert "provider" in oauth_start_req["required"]
        oauth_start_200 = oauth_start["responses"]["200"]["content"]["application/json"]["schema"]
        assert "flow_id" in oauth_start_200["required"]


class TestSwaggerUiHtml:
    def test_html_references_spec_url(self):
        html = api_docs.swagger_ui_html()
        assert "接口目录" in html
        assert "/api/openapi.json" in html
        assert "/api/team/runs" in html
        assert "method-post" in html
        assert "unpkg.com" not in html
        assert "SwaggerUIBundle" not in html

    def test_html_has_zh_CN_lang(self):
        html = api_docs.swagger_ui_html()
        assert 'lang="zh-CN"' in html

    def test_html_renders_human_readable_sections(self):
        html = api_docs.swagger_ui_html()
        assert "接口用途" in html
        assert "认证方式" in html
        assert "响应格式" in html
        assert "请求 JSON 示例" in html
        assert "前端 fetch 示例" in html
        assert "响应 JSON 示例" in html
        assert "字段说明" in html
        assert "复制后可直接修改字段值发起调用" in html

    def test_html_shows_login_request_example_without_email(self):
        html = api_docs.swagger_ui_html()
        start = html.index('id="post--api-auth-login"')
        end = html.index('id="post--api-auth-login-phone-send-code"', start)
        login_html = html[start:end]
        assert "&quot;password&quot;" in login_html
        assert "&quot;email&quot;" not in login_html
        assert "curl" in html

    def test_html_documents_auth_and_special_response_types(self):
        html = api_docs.swagger_ui_html()
        assert "credentials: &#x27;include&#x27;" in html
        assert "X-Hermes-CSRF-Token" in html
        assert "text/event-stream" in html
        assert "text/csv" in html


class TestRouteWiring:
    def test_openapi_json_route(self):
        handler = _FakeHandler()
        routes.handle_get(handler, urlparse("http://example.com/api/openapi.json"))
        assert handler.status == 200
        assert "application/json" in handler.headers.get("Content-Type", "")
        assert handler.json_body()["openapi"].startswith("3.")

    def test_docs_route_serves_html(self):
        handler = _FakeHandler()
        routes.handle_get(handler, urlparse("http://example.com/api/docs"))
        assert handler.status == 200
        assert "text/html" in handler.headers.get("Content-Type", "")
        assert "接口目录" in handler.body_text()
        assert "/api/openapi.json" in handler.body_text()
