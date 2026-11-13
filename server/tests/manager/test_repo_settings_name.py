"""ensure_enterprise_name：只在企业名为空时写入，绝不覆盖管理员改过的名称。"""

from datetime import UTC, datetime

from shared.contracts.tenancy import TenantContext

from manager_service.settings_repository import SettingsRepository, SettingsRow

CTX = TenantContext(tenant_id="11111111-1111-4111-8111-111111111111", user_id="system", roles=["owner"])


def _row(name: str) -> SettingsRow:
    return SettingsRow(
        id="s-1", enterprise_name=name, contact_email="", contact_phone="", logo_url=None,
        invite_required=False, member_approval=False, max_employees=0, features={},
        updated_at=datetime(2026, 11, 13, tzinfo=UTC),
    )


class _Repo(SettingsRepository):
    """只替换读写两个落库方法，被测的 ensure_enterprise_name 用的是真实实现。"""

    def __init__(self, current: str | None):
        self._current = current
        self.written: list[dict] = []

    def get_settings(self, ctx: TenantContext) -> SettingsRow | None:
        return None if self._current is None else _row(self._current)

    def upsert_settings(self, ctx: TenantContext, **fields) -> SettingsRow:
        self.written.append(fields)
        return _row(fields.get("enterprise_name") or "")


def test_writes_when_no_settings_row():
    repo = _Repo(None)
    repo.ensure_enterprise_name(CTX, "星河科技")
    assert repo.written == [{"enterprise_name": "星河科技"}]


def test_writes_when_name_is_blank():
    repo = _Repo("")
    repo.ensure_enterprise_name(CTX, "星河科技")
    assert repo.written == [{"enterprise_name": "星河科技"}]


def test_keeps_name_the_admin_already_set():
    repo = _Repo("管理员改的名字")
    repo.ensure_enterprise_name(CTX, "星河科技")
    assert repo.written == []


def test_blank_incoming_name_is_ignored():
    repo = _Repo(None)
    repo.ensure_enterprise_name(CTX, "   ")
    assert repo.written == []
