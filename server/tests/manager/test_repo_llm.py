"""llm_repository.py branch coverage (issue #265)."""
from __future__ import annotations

from datetime import datetime

from manager_service.llm_repository import LlmRepository
from ._fake_router import FakeCursor, FakeRouter, ctx


def _prov_row(pid="p-1", name="OpenAI", key="openai", url="https://api.openai.com",
              active=True, mcount=3):
    from datetime import datetime
    return (pid, name, key, url, active, mcount, datetime.utcnow())


def _model_row(mid="m-1", pid="p-1", uid="gpt-4", name="GPT-4", cw=8192,
               inp="0.03", out="0.06", active=True):
    return (mid, pid, uid, name, cw, inp, out, active)


def test_list_providers_with_keyword():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_prov_row()]))
    rows = LlmRepository(router).list_providers(ctx(), keyword="open")
    assert len(rows) == 1

def test_list_providers_no_keyword():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_prov_row()]))
    rows = LlmRepository(router).list_providers(ctx())
    assert len(rows) == 1

def test_get_provider_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_prov_row()))
    assert LlmRepository(router).get_provider(ctx(), "p-1") is not None

def test_get_provider_not_found():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=None))
    assert LlmRepository(router).get_provider(ctx(), "x") is None

def test_create_provider():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_prov_row()))
    row = LlmRepository(router).create_provider(ctx(), name="X", provider_key="x", base_url=None)
    assert row.name == "OpenAI"

def test_update_provider():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_prov_row(name="Updated")))
    row = LlmRepository(router).update_provider(ctx(), "p-1", name="Updated", base_url=None, is_active=None)
    assert row is not None

def test_update_provider_no_fields():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_prov_row()))
    row = LlmRepository(router).update_provider(ctx(), "p-1", name=None, base_url=None, is_active=None)
    assert row is not None

def test_delete_provider():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=1))
    assert LlmRepository(router).delete_provider(ctx(), "p-1") is True

def test_list_models():
    router = FakeRouter()
    router.queue(FakeCursor(fetchall=[_model_row()]))
    rows = LlmRepository(router).list_models(ctx())
    assert len(rows) == 1

def test_create_model():
    router = FakeRouter()
    router.queue(FakeCursor(fetchone=_model_row()))
    row = LlmRepository(router).create_model(
        ctx(), provider_id="p-1", model_uid="gpt-4", model_name="GPT-4",
        context_window=8192, input_price="0.03", output_price="0.06",
    )
    assert row.model_uid == "gpt-4"

def test_delete_model():
    router = FakeRouter()
    router.queue(FakeCursor(rowcount=1))
    assert LlmRepository(router).delete_model(ctx(), "m-1") is True
