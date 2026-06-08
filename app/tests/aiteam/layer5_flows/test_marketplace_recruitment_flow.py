"""Layer5 marketplace recruitment flow tests for P03/P04 -> B01/P02 closure."""

from tests.aiteam.layer0_contracts.test_host_routing import _get, _post


def test_marketplace_recruitment_closes_to_workbench_employee_and_chat(seeded_enterprise):
    status, resp = _post(
        "/api/team/recruitments",
        {
            "template_id": seeded_enterprise["template_id"],
            "display_name": "Flow Analyst",
            "idempotency_key": "idem_l5_marketplace_recruit",
        },
    )
    assert status == 201, resp
    assert resp["status"] == "succeeded"
    assert resp["conversation_id"].startswith("conv_")
    assert resp["navigation"]["workbench"] == "/app/workbench"
    assert resp["navigation"]["employee_admin"].endswith(resp["employee_id"])
    assert resp["navigation"]["chat"].endswith(resp["conversation_id"])

    list_status, employees = _get("/api/team/employees?role=owner")
    assert list_status == 200, employees
    created = next((item for item in employees["employees"] if item["employee_id"] == resp["employee_id"]), None)
    assert created is not None, employees
    assert created["display_name"] == "Flow Analyst"
    assert created["status"] == "active"

    detail_status, detail = _get(f"/api/team/employees/{resp['employee_id']}?role=owner")
    assert detail_status == 200, detail
    assert detail["profile_config"]["profile_name"] == resp["profile_name"]
    assert detail["status"] == "active"

    conversation_status, conversation = _get(f"/api/team/conversations/{resp['conversation_id']}")
    assert conversation_status == 200, conversation
    assert conversation["conversation_id"] == resp["conversation_id"]
    assert conversation["status"] == "active"
    assert conversation["employee_ref"]["employee_id"] == resp["employee_id"]

    workbench_status, workbench = _get("/api/team/workbench")
    assert workbench_status == 200, workbench
    team_items = workbench["employees"]
    recruited_card = next((item for item in team_items if item["employee_id"] == resp["employee_id"]), None)
    assert recruited_card is not None, workbench
    assert recruited_card["conversation_id"] == resp["conversation_id"]
