"""ensure_enterprise_name：只在企业名为空时写入，绝不覆盖管理员改过的名称。"""

from types import SimpleNamespace

from shared.contracts.tenancy import TenantContext

from manager_service.settings_repository import SettingsRepository

CTX = TenantContext(tenant_id="11111111-1111-4111-8111-111111111111", user_id="system", roles=["owner"])


class _Repo(SettingsRepository):
    def __init__(self, current):
        self._current = current
        self.written = []

    def get_settings(self, ctx):
        return None if self._current is None else SimpleNamespace(enterprise_name=self._current)

    def upsert_settings(self, ctx, **fields):
        self.written.append(fields)


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
