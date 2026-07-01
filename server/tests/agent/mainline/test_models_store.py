"""A1.1 验收：本地主链领域模型 + 仓储。

覆盖：主状态流转、列表有序、不存在报 NotFound、展示态不出现在持久化模型字段。
只 import shared.contracts.*（枚举），不重定义。
"""

import pytest

from agent_service.mainline.models import (
    Conversation,
    Message,
    MessageRole,
    Run,
    RunStatus,
    Task,
    TaskStatus,
)
from agent_service.mainline.store import (
    InMemoryConversationRepository,
    InMemoryMessageRepository,
    InMemoryRunRepository,
    InMemoryTaskRepository,
)
from shared.contracts.enums import ConversationState, DisplayState
from shared.errors import NotFound


def test_conversation_uses_shared_state_enum():
    conv = Conversation(id="c1")
    assert conv.state is ConversationState.ACTIVE
    # 主状态枚举来自 shared.contracts（未重定义）。
    assert isinstance(conv.state, ConversationState)


def test_persistent_models_carry_no_display_state():
    """D6：展示态绝不作为持久化字段。"""
    display_values = {s.value for s in DisplayState}
    for model in (Conversation, Message, Run, Task):
        fields = set(model.model_fields)
        assert "display_state" not in fields
        assert "display" not in fields
        # 任何字段默认值都不应是展示态枚举值
        for name, info in model.model_fields.items():
            assert info.default not in display_values, f"{model.__name__}.{name} 不得默认展示态"


def test_conversation_repo_crud_and_state_transition():
    repo = InMemoryConversationRepository()
    repo.create(Conversation(id="c1"))
    assert repo.get("c1").state is ConversationState.ACTIVE
    updated = repo.set_state("c1", ConversationState.ARCHIVED)
    assert updated.state is ConversationState.ARCHIVED
    assert repo.get("c1").state is ConversationState.ARCHIVED


def test_conversation_repo_missing_raises_notfound():
    repo = InMemoryConversationRepository()
    with pytest.raises(NotFound):
        repo.get("nope")
    with pytest.raises(NotFound):
        repo.set_state("nope", ConversationState.PAUSED)


def test_message_repo_list_per_conversation():
    repo = InMemoryMessageRepository()
    repo.add(Message(id="m1", conversation_id="c1", role=MessageRole.USER, content="hi"))
    repo.add(Message(id="m2", conversation_id="c1", role=MessageRole.EMPLOYEE, content="yo"))
    repo.add(Message(id="m3", conversation_id="c2", role=MessageRole.USER, content="other"))
    assert [m.id for m in repo.list("c1")] == ["m1", "m2"]
    assert [m.id for m in repo.list("c2")] == ["m3"]


def test_run_repo_finalize():
    repo = InMemoryRunRepository()
    repo.create(Run(id="r1", conversation_id="c1"))
    assert repo.get("r1").status is RunStatus.RUNNING
    final = repo.finalize("r1", RunStatus.COMPLETED, session_id="s1",
                          error=None, usage={"input_tokens": 1})
    assert final.status is RunStatus.COMPLETED
    assert final.session_id == "s1"
    assert final.usage == {"input_tokens": 1}


def test_run_repo_missing_raises_notfound():
    with pytest.raises(NotFound):
        InMemoryRunRepository().get("nope")


def test_task_repo_status_transition():
    repo = InMemoryTaskRepository()
    repo.create(Task(id="t1", conversation_id="c1", title="do x"))
    assert repo.get("t1").status is TaskStatus.PENDING
    assert repo.set_status("t1", TaskStatus.DONE).status is TaskStatus.DONE


def test_task_repo_missing_raises_notfound():
    with pytest.raises(NotFound):
        InMemoryTaskRepository().get("nope")

def test_conversation_read_status_defaults_to_none():
    """A1.1 验收：新会话阅读状态默认为未读（None）。"""
    conv = Conversation(id="c1")
    assert conv.last_read_at is None
    assert conv.last_read_message_id is None


def test_conversation_mark_read_updates_fields():
    """A1.1 验收：mark_read 设 last_read_message_id，clear 清回 None。"""
    from datetime import datetime, timezone
    repo = InMemoryConversationRepository()
    repo.create(Conversation(id="c1"))
    ts = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)
    updated = repo.update_read_status("c1", last_read_at=ts, last_read_message_id="msg_abc")
    assert updated.last_read_at == ts
    assert updated.last_read_message_id == "msg_abc"
    # clear: 空串 message_id 视为 None
    cleared = repo.update_read_status("c1", last_read_message_id="")
    assert cleared.last_read_message_id is None
    assert cleared.last_read_at == ts  # 未再传则不改变


def test_conversation_read_status_missing_raises_notfound():
    repo = InMemoryConversationRepository()
    with pytest.raises(NotFound):
        repo.update_read_status("nope", last_read_message_id="x")
