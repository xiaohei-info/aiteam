from __future__ import annotations

import pytest

from manager_service.llm_service import LlmService
from shared.errors import Forbidden
from ._fake_router import ctx


class _Repo:
    def create_provider(self, *args, **kwargs):
        raise AssertionError("member must not reach provider write")

    def update_provider(self, *args, **kwargs):
        raise AssertionError("member must not reach provider write")

    def delete_provider(self, *args, **kwargs):
        raise AssertionError("member must not reach provider write")

    def get_provider(self, *args, **kwargs):
        raise AssertionError("member must not reach model write")

    def create_model(self, *args, **kwargs):
        raise AssertionError("member must not reach model write")

    def delete_model(self, *args, **kwargs):
        raise AssertionError("member must not reach model write")


def test_llm_writes_require_owner_or_enterprise_admin():
    service = LlmService(_Repo())
    member = ctx(roles=["member"])
    with pytest.raises(Forbidden):
        service.create_provider(member, name="provider", provider_key="p", base_url=None)
    with pytest.raises(Forbidden):
        service.patch_provider(member, "provider-1", name=None, base_url=None, is_active=None)
    with pytest.raises(Forbidden):
        service.delete_provider(member, "provider-1")
    with pytest.raises(Forbidden):
        service.create_model(member, provider_id="provider-1", model_uid="m", model_name="M", context_window=None, input_price=None, output_price=None)
    with pytest.raises(Forbidden):
        service.delete_model(member, "model-1")
