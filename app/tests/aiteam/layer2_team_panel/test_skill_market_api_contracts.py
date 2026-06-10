from __future__ import annotations

from tests.aiteam.layer0_contracts.test_host_routing import _delete, _get, _patch, _post


class TestSkillCatalog:
    def test_get_skill_catalog_returns_200_and_envelope(self, seeded_enterprise):
        status, body = _get('/api/team/skills/catalog')
        assert status == 200, body
        assert 'items' in body
        assert 'total' in body
        assert isinstance(body['items'], list)

    def test_get_skill_catalog_supports_search_and_installed_only(self, seeded_enterprise):
        create_status, _ = _post('/api/team/skills/installs', {
            'skill_code': 'web-search',
            'scope_mode': 'selected_employees',
            'employee_ids': [seeded_enterprise['employee_id']],
        })
        assert create_status == 201

        status, body = _get('/api/team/skills/catalog?q=web&installed_only=true')
        assert status == 200, body
        assert body['total'] == 1
        assert body['items'][0]['skill_code'] == 'web-search'
        assert body['items'][0]['installed']['scope_mode'] == 'selected_employees'


class TestSkillInstalls:
    def test_post_install_creates_authorized_skill_install(self, seeded_enterprise):
        status, body = _post(
            '/api/team/skills/installs',
            {
                'skill_code': 'web-search',
                'display_name': 'Web Search',
                'description': 'Search the web',
                'source_marketplace': 'builtin',
                'version': '1.0.0',
                'latest_version': '1.1.0',
                'scope_mode': 'selected_employees',
                'employee_ids': [seeded_enterprise['employee_id']],
            },
        )
        assert status == 201, body
        assert body['skill_code'] == 'web-search'
        assert body['grants'][0]['employee_id'] == seeded_enterprise['employee_id']
        assert body['install_status'] == 'update_available'

        detail_status, employee_body = _get(f"/api/team/employees/{seeded_enterprise['employee_id']}")
        assert detail_status == 200, employee_body
        assert 'web-search' in employee_body['profile_config']['skills']

    def test_get_installs_lists_active_installs(self, seeded_enterprise):
        _post('/api/team/skills/installs', {
            'skill_code': 'slides',
            'display_name': 'Slides',
            'description': 'Prepare slides',
            'source_marketplace': 'builtin',
            'scope_mode': 'all_employees',
        })
        status, body = _get('/api/team/skills/installs')
        assert status == 200, body
        assert body['total'] >= 1
        install = body['items'][0]
        for key in ('install_id', 'skill_code', 'scope_mode', 'version', 'grants'):
            assert key in install
        assert install["audit_status"] == "skill.install"
        assert install["audit_recorded_at"]

    def test_patch_install_updates_version_and_scope(self, seeded_enterprise):
        _, created = _post('/api/team/skills/installs', {
            'skill_code': 'reporting',
            'display_name': 'Reporting',
            'scope_mode': 'selected_employees',
            'employee_ids': [seeded_enterprise['employee_id']],
            'version': '1.0.0',
            'latest_version': '1.0.0',
        })
        status, body = _patch(f"/api/team/skills/installs/{created['install_id']}", {
            'scope_mode': 'all_employees',
            'version': '1.1.0',
            'latest_version': '1.1.0',
        })
        assert status == 200, body
        assert body['scope_mode'] == 'all_employees'
        assert body['version'] == '1.1.0'
        assert body['install_status'] == 'active'
        assert {grant['employee_id'] for grant in body['grants']} == {'emp_member', 'emp_planner', seeded_enterprise['employee_id']}

    def test_delete_install_revokes_skill_and_hides_from_profile(self, seeded_enterprise):
        _, created = _post('/api/team/skills/installs', {
            'skill_code': 'forecasting',
            'display_name': 'Forecasting',
            'scope_mode': 'selected_employees',
            'employee_ids': [seeded_enterprise['employee_id']],
        })
        status, body = _delete(f"/api/team/skills/installs/{created['install_id']}")
        assert status == 200, body
        assert body['status'] == 'uninstalled'

        detail_status, employee_body = _get(f"/api/team/employees/{seeded_enterprise['employee_id']}")
        assert detail_status == 200, employee_body
        assert 'forecasting' not in employee_body['profile_config']['skills']

    def test_patch_employee_rejects_unauthorized_skill_add(self, seeded_enterprise):
        status, body = _patch(f"/api/team/employees/{seeded_enterprise['employee_id']}", {'skills_add': ['not-installed']})
        assert status == 403, body
        assert body['error'] == 'SKILL_NOT_AUTHORIZED'
