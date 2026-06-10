"""Layer5 P01 login and enterprise onboarding flow tests."""

from tests.aiteam.layer2_team_panel.test_auth_northbound_routes import _handler_json, _request


def test_phone_login_create_enterprise_closes_to_current_enterprise():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138200"},
        client_ip="198.51.100.200",
    )
    assert send_handler.status == 200
    assert _handler_json(send_handler) == {"expires_in": 300}

    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138200", "code": "888888"},
        headers={"User-Agent": "Flow QA"},
        client_ip="198.51.100.200",
    )
    verify_body = _handler_json(verify_handler)
    assert verify_handler.status == 200
    access_token = verify_body["access_token"]

    me_before_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    me_before = _handler_json(me_before_handler)
    assert me_before_handler.status == 200
    assert me_before["current_enterprise"] is None
    assert me_before["onboarding"] == {"action": "create_or_join_enterprise"}

    create_handler = _request(
        "POST",
        "/api/auth/onboarding/create-enterprise",
        body={"name": "Flow Enterprise", "slug": "flow-enterprise"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    create_body = _handler_json(create_handler)
    assert create_handler.status == 201
    assert create_body["name"] == "Flow Enterprise"
    assert create_body["slug"] == "flow-enterprise"
    assert create_body["role"] == "owner"

    current_handler = _request(
        "GET",
        "/api/enterprises/current",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    current_body = _handler_json(current_handler)
    assert current_handler.status == 200
    assert current_body["enterprise_id"] == create_body["enterprise_id"]

    me_after_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    me_after = _handler_json(me_after_handler)
    assert me_after_handler.status == 200
    assert me_after["current_enterprise"]["enterprise_id"] == create_body["enterprise_id"]
    assert me_after["current_enterprise"]["role"] == "owner"
    assert "onboarding" not in me_after


def test_phone_login_join_enterprise_closes_to_current_enterprise():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138201"},
        client_ip="198.51.100.201",
    )
    assert send_handler.status == 200

    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138201", "code": "888888"},
        headers={"User-Agent": "Flow QA"},
        client_ip="198.51.100.201",
    )
    verify_body = _handler_json(verify_handler)
    assert verify_handler.status == 200
    access_token = verify_body["access_token"]

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

    me_after_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    me_after = _handler_json(me_after_handler)
    assert me_after_handler.status == 200
    assert me_after["current_enterprise"]["enterprise_id"] == "ent_existing_acme"
    assert me_after["current_enterprise"]["role"] == "member"
    assert "onboarding" not in me_after


def test_phone_login_invalid_invite_keeps_user_in_onboarding_state():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138202"},
        client_ip="198.51.100.202",
    )
    assert send_handler.status == 200

    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138202", "code": "888888"},
        headers={"User-Agent": "Flow QA"},
        client_ip="198.51.100.202",
    )
    verify_body = _handler_json(verify_handler)
    assert verify_handler.status == 200
    access_token = verify_body["access_token"]

    join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-UNKNOWN"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    join_body = _handler_json(join_handler)
    assert join_handler.status == 404
    assert "invite" in join_body["error"].lower()

    me_after_handler = _request(
        "GET",
        "/api/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    me_after = _handler_json(me_after_handler)
    assert me_after_handler.status == 200
    assert me_after["current_enterprise"] is None
    assert me_after["onboarding"] == {"action": "create_or_join_enterprise"}


def test_phone_login_duplicate_join_returns_conflict_without_losing_enterprise():
    send_handler = _request(
        "POST",
        "/api/auth/login/phone/send-code",
        body={"phone": "13800138203"},
        client_ip="198.51.100.203",
    )
    assert send_handler.status == 200

    verify_handler = _request(
        "POST",
        "/api/auth/login/phone/verify",
        body={"phone": "13800138203", "code": "888888"},
        headers={"User-Agent": "Flow QA"},
        client_ip="198.51.100.203",
    )
    verify_body = _handler_json(verify_handler)
    assert verify_handler.status == 200
    access_token = verify_body["access_token"]

    first_join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-ACME01"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert first_join_handler.status == 200

    second_join_handler = _request(
        "POST",
        "/api/auth/onboarding/join-enterprise",
        body={"invite_code": "INV-ACME01"},
        headers={"Authorization": f"Bearer {access_token}"},
    )
    second_join_body = _handler_json(second_join_handler)
    assert second_join_handler.status == 409
    assert "already" in second_join_body["error"].lower()

    current_handler = _request(
        "GET",
        "/api/enterprises/current",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    current_body = _handler_json(current_handler)
    assert current_handler.status == 200
    assert current_body["enterprise_id"] == "ent_existing_acme"
