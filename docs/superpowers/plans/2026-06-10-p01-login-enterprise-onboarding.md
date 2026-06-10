# P01 Login And Enterprise Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining P01 gaps by adding enterprise onboarding northbound routes, wiring login success into a real create/join-enterprise completion path, and aligning the login page behavior with the PRD-backed mock-first contract.

**Architecture:** Keep the current mock-first auth surface in `app/team_panel/api_team/router_auth.py` as the northbound authority, extend it with the missing onboarding endpoints, and drive all frontend routing from `/api/me` and the new onboarding APIs. Preserve the existing login page entry points, but shift new-user completion from a passive `workbench?onboarding=...` hint into an active workbench onboarding flow implemented in the current frontend shell instead of inventing a separate subsystem.

**Tech Stack:** Python northbound router/service code, vanilla JavaScript frontend pages, pytest layer2/layer4 tests, existing node-based frontend contract harness

---

## File Structure

- Modify: `app/team_panel/api_team/router_auth.py`
  - Add minimal northbound onboarding helpers and routes for `create-enterprise`, `join-enterprise`, and `GET /api/enterprises/current`
  - Update in-memory profile/session state so `/api/me` reflects enterprise membership changes immediately
- Modify: `app/static/login.js`
  - Keep QR/phone login flow, but change post-login behavior so no-enterprise users land on a workbench onboarding mode that can actually complete enterprise entry
- Modify: `app/static/aiteam/pages/app-workbench.js`
  - Add the minimal onboarding completion UI/behavior for create/join enterprise inside the existing workbench shell
- Modify: `app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py`
  - Add failing tests for the new onboarding/current-enterprise routes and state reflection
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py`
  - Extend the node harness with onboarding API mocks and add frontend contract tests for onboarding completion and failure recovery
- Optional modify if required by current render contracts: `app/tests/aiteam/layer4_frontend_bff/test_workbench_page_rendering.py`
  - Only if workbench shell assertions must be updated for new onboarding rendering hooks

## Task 1: Backend Onboarding Northbound Contract

**Files:**
- Modify: `app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py`
- Modify: `app/team_panel/api_team/router_auth.py`

- [ ] **Step 1: Write the failing layer2 tests for create-enterprise, join-enterprise, and current enterprise**

```python
def test_onboarding_create_enterprise_updates_profile_and_current_enterprise():
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138000", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.20",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    create_handler = _request(
        "POST",
        "/api/auth/onboarding/create-enterprise",
        body={"name": "Acme AI Lab", "slug": "acme-ai-lab"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    create_body = _handler_json(create_handler)

    assert create_handler.status == 201
    assert create_body["name"] == "Acme AI Lab"
    assert create_body["slug"] == "acme-ai-lab"
    assert create_body["role"] == "owner"
    assert create_body["enterprise_id"].startswith("ent_")

    me_handler = _request("GET", "/api/me", headers={"Authorization": f"Bearer {access_token}"})
    me_body = _handler_json(me_handler)
    assert me_body["current_enterprise"]["enterprise_id"] == create_body["enterprise_id"]
    assert me_body["current_enterprise"]["role"] == "owner"
    assert "onboarding" not in me_body


def test_onboarding_join_enterprise_updates_profile_and_current_enterprise():
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138001", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.21",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-ACME01"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    join_body = _handler_json(join_handler)

    assert join_handler.status == 200
    assert join_body["enterprise_id"] == "ent_existing_acme"
    assert join_body["role"] == "member"

    current_handler = _request(
        "GET",
        "/api/enterprises/current",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    current_body = _handler_json(current_handler)
    assert current_handler.status == 200
    assert current_body["enterprise_id"] == "ent_existing_acme"


def test_onboarding_join_enterprise_rejects_invalid_code():
    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138002", "code": "888888"},
        headers={"User-Agent": "Safari QA"},
        client_ip="198.51.100.22",
    )
    access_token = _handler_json(verify_handler)["access_token"]

    join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-UNKNOWN"},
        headers={"Authorization": f"Bearer {access_token}"},
    )

    assert join_handler.status == 404
    assert "invite" in _handler_json(join_handler)["error"].lower()
```

- [ ] **Step 2: Run the targeted layer2 tests to verify the new routes fail**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q`
Expected: FAIL because `/api/auth/onboarding/create-enterprise`, `/api/auth/onboarding/join-enterprise`, and `/api/enterprises/current` are not routed yet

- [ ] **Step 3: Implement the minimal onboarding route logic in `router_auth.py`**

```python
def handle_create_enterprise(access_token: str | None, body: dict[str, Any] | None) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        if not access_token:
            raise AuthRouteError("Unauthorized", status=401)
        record = _ACCESS_TOKENS.get(access_token)
        if record is None or record["expires_at"] <= time.time():
            raise AuthRouteError("Unauthorized", status=401)

        payload = body or {}
        name = str(payload.get("name") or "").strip()
        if not name:
            raise AuthRouteError("Enterprise name is required", status=400)
        slug = str(payload.get("slug") or "").strip() or _slugify_enterprise_name(name)
        enterprise_id = f"ent_{secrets.token_hex(4)}"
        enterprise_summary = {
            "enterprise_id": enterprise_id,
            "name": name,
            "slug": slug,
            "role": "owner",
        }
        _bind_profile_to_enterprise(record, enterprise_summary)
        return AuthResult(201, enterprise_summary, [])


def handle_join_enterprise(access_token: str | None, body: dict[str, Any] | None) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        if not access_token:
            raise AuthRouteError("Unauthorized", status=401)
        record = _ACCESS_TOKENS.get(access_token)
        if record is None or record["expires_at"] <= time.time():
            raise AuthRouteError("Unauthorized", status=401)

        invite_code = str((body or {}).get("invite_code") or "").strip().upper()
        invite = _ENTERPRISE_INVITES.get(invite_code)
        if invite is None:
            raise AuthRouteError("Invite code is invalid or expired", status=404)
        if any(item.get("enterprise_id") == invite["enterprise_id"] for item in record["profile"].get("enterprises", [])):
            raise AuthRouteError("Already joined this enterprise", status=409)

        enterprise_summary = {
            "enterprise_id": invite["enterprise_id"],
            "name": invite["name"],
            "slug": invite["slug"],
            "role": invite["role"],
        }
        _bind_profile_to_enterprise(record, enterprise_summary)
        return AuthResult(200, enterprise_summary, [])


def handle_current_enterprise(access_token: str | None) -> AuthResult:
    with _LOCK:
        _prune_expired_state()
        if not access_token:
            raise AuthRouteError("Unauthorized", status=401)
        record = _ACCESS_TOKENS.get(access_token)
        if record is None or record["expires_at"] <= time.time():
            raise AuthRouteError("Unauthorized", status=401)
        current = record["profile"].get("current_enterprise")
        if current is None:
            raise AuthRouteError("Current enterprise not found", status=404)
        return AuthResult(200, dict(current), [])
```

- [ ] **Step 4: Wire the new routes into `app/api/routes.py` auth dispatch path**

```python
from team_panel.api_team.router_auth import (
    handle_create_enterprise,
    handle_current_enterprise,
    handle_join_enterprise,
)

if method == "POST" and request_path == "/api/auth/onboarding/create-enterprise":
    result = handle_create_enterprise(access_token_from_headers(handler.headers), body)
    return _send_json_header_list(handler, result.body, status=result.status, extra_headers=result.headers)
if method == "POST" and request_path == "/api/auth/onboarding/join-enterprise":
    result = handle_join_enterprise(access_token_from_headers(handler.headers), body)
    return _send_json_header_list(handler, result.body, status=result.status, extra_headers=result.headers)
if method == "GET" and request_path == "/api/enterprises/current":
    result = handle_current_enterprise(access_token_from_headers(handler.headers))
    return _send_json_header_list(handler, result.body, status=result.status, extra_headers=result.headers)
```

- [ ] **Step 5: Re-run the targeted layer2 tests**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q`
Expected: PASS for the new onboarding/current-enterprise cases and existing auth cases remain green

- [ ] **Step 6: Commit the backend onboarding contract increment**

```bash
git add app/team_panel/api_team/router_auth.py app/api/routes.py app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py
git commit -m "feat: add p01 auth onboarding routes"
```

## Task 2: Login Redirect And Onboarding Completion Frontend Flow

**Files:**
- Modify: `app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py`
- Modify: `app/static/login.js`
- Modify: `app/static/aiteam/pages/app-workbench.js`

- [ ] **Step 1: Write the failing frontend contract tests for workbench onboarding completion**

```python
def test_login_page_redirects_new_user_to_workbench_onboarding_mode():
    result = _run_login_page_node(
        phone="13800138000",
        code="888888",
        trigger_phone_verify=True,
        me_payload={"current_enterprise": None, "onboarding": {"action": "create_or_join_enterprise"}},
    )

    assert result["href"] == "http://localhost/app/workbench?onboarding=create_or_join_enterprise"


def test_workbench_onboarding_create_enterprise_completes_and_redirects():
    result = _run_login_page_node(
        phone="13800138000",
        code="888888",
        trigger_phone_verify=True,
        me_payload={"current_enterprise": None, "onboarding": {"action": "create_or_join_enterprise"}},
        trigger_create_enterprise=True,
        enterprise_name="Acme AI Lab",
    )

    assert any("/api/auth/onboarding/create-enterprise" in call["url"] for call in result["fetchCalls"])
    assert result["href"] == "http://localhost/app/workbench"


def test_workbench_onboarding_join_enterprise_shows_invalid_invite_error():
    result = _run_login_page_node(
        phone="13800138000",
        code="888888",
        trigger_phone_verify=True,
        me_payload={"current_enterprise": None, "onboarding": {"action": "create_or_join_enterprise"}},
        trigger_join_enterprise=True,
        invite_code="INV-UNKNOWN",
        join_should_fail=True,
    )

    assert any("/api/auth/onboarding/join-enterprise" in call["url"] for call in result["fetchCalls"])
    assert result["onboardingError"] == "Invite code is invalid or expired"
```

- [ ] **Step 2: Run the targeted frontend contract tests to verify they fail**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q`
Expected: FAIL because the node harness and current JS do not yet expose an actionable onboarding completion path

- [ ] **Step 3: Extend the node harness in `test_login_page_contract.py` to drive onboarding actions**

```python
def _run_login_page_node(
    *,
    phone: str = "",
    code: str = "",
    trigger_phone_send: bool = False,
    trigger_phone_verify: bool = False,
    trigger_create_enterprise: bool = False,
    trigger_join_enterprise: bool = False,
    enterprise_name: str = "",
    invite_code: str = "",
    join_should_fail: bool = False,
    me_payload: dict | None = None,
) -> dict:
    ...
```

```javascript
if (String(url).indexOf('/api/auth/onboarding/create-enterprise') !== -1) {
  return Promise.resolve({ ok: true, json: async () => ({ enterprise_id: 'ent_new', name: runtime.enterpriseName || 'Acme AI Lab', slug: 'acme-ai-lab', role: 'owner' }) });
}
if (String(url).indexOf('/api/auth/onboarding/join-enterprise') !== -1) {
  if (runtime.joinShouldFail) {
    return Promise.resolve({ ok: false, json: async () => ({ error: 'Invite code is invalid or expired' }) });
  }
  return Promise.resolve({ ok: true, json: async () => ({ enterprise_id: 'ent_existing_acme', name: 'Acme AI Lab', slug: 'acme-ai-lab', role: 'member' }) });
}
```

- [ ] **Step 4: Implement the minimal post-login onboarding completion flow in `login.js` and `app-workbench.js`**

```javascript
function _defaultPostLoginPath(profile) {
  if (profile && profile.current_enterprise) return '/app/workbench';
  if (profile && profile.onboarding && profile.onboarding.action === 'create_or_join_enterprise') {
    return '/app/workbench?onboarding=create_or_join_enterprise';
  }
  return '/app/workbench';
}
```

```javascript
async function submitCreateEnterprise(name) {
  const payload = await requestJson('/api/auth/onboarding/create-enterprise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name }),
    credentials: 'include',
  });
  window.location.href = scopedUrl('/app/workbench');
  return payload;
}

async function submitJoinEnterprise(inviteCode) {
  const payload = await requestJson('/api/auth/onboarding/join-enterprise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: inviteCode }),
    credentials: 'include',
  });
  window.location.href = scopedUrl('/app/workbench');
  return payload;
}
```

```javascript
function renderOnboardingPrompt() {
  if (!state.onboardingRequired) return '';
  return `
    <section class="workbench-onboarding" data-testid="workbench-onboarding">
      <h2>Enter your enterprise workspace</h2>
      <form id="create-enterprise-form">
        <input id="enterprise-name" placeholder="Enterprise name">
        <button type="submit">Create enterprise</button>
      </form>
      <form id="join-enterprise-form">
        <input id="invite-code" placeholder="Invite code">
        <button type="submit">Join enterprise</button>
      </form>
      <p id="onboarding-error"></p>
    </section>
  `;
}
```

- [ ] **Step 5: Re-run the targeted frontend contract tests**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q`
Expected: PASS for onboarding create/join and invalid-invite recovery; existing QR/phone contract tests remain green

- [ ] **Step 6: Commit the frontend onboarding flow increment**

```bash
git add app/static/login.js app/static/aiteam/pages/app-workbench.js app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py
git commit -m "feat: add p01 onboarding completion flow"
```

## Task 3: Final Verification Sweep

**Files:**
- Verify only

- [ ] **Step 1: Run the backend auth/onboarding verification suite**

Run: `pytest app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py -q`
Expected: PASS

- [ ] **Step 2: Run the login page frontend contract suite**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py -q`
Expected: PASS

- [ ] **Step 3: Run any workbench rendering test touched by onboarding shell changes**

Run: `pytest app/tests/aiteam/layer4_frontend_bff/test_workbench_page_rendering.py -q`
Expected: PASS, or no changes required if untouched

- [ ] **Step 4: Inspect git status to confirm only intended files changed**

Run: `git status --short`
Expected: only P01-related source, tests, plan/spec artifacts, and no unrelated drift

- [ ] **Step 5: Create the final implementation commit in the current worktree**

```bash
git add app/team_panel/api_team/router_auth.py app/api/routes.py app/static/login.js app/static/aiteam/pages/app-workbench.js app/tests/aiteam/layer2_team_panel/test_auth_northbound_routes.py app/tests/aiteam/layer4_frontend_bff/test_login_page_contract.py docs/superpowers/plans/2026-06-10-p01-login-enterprise-onboarding.md
git commit -m "feat: complete p01 login enterprise onboarding"
```
