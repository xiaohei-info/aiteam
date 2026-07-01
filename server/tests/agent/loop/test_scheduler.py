"""A3 验收：Loop 本地调度器（06 §7.6 / D19）。

核心验证（覆盖 issue 验收 + 红线）：
- Loop 本地调度测试：到点触发 enabled loop -> 复用 A1 start_run -> run 终态落库、事件并入
  conversation timeline（与私聊/群聊 run 同构）。
- 不依赖 hermes cron：判定用本地 cron.py，不经 runtime cron。
- 仅运行期执行：scheduler.start/stop 随进程；disable 后下一 tick 不再触发。
- 展示态不落 Loop 主状态（D6）。
- 幂等：同一分钟重复 fire_ready 不重复触发同一 loop。

到点判定用构造的 datetime 直接驱动 fire_ready（不依赖真实睡眠/事件循环时序）。
"""

import asyncio
from datetime import datetime

import pytest

from agent_service.loop.cron import CronError
from agent_service.loop.factory import build_loop_service
from agent_service.loop.models import Loop, LoopStatus
from agent_service.loop.scheduler import LoopScheduler
from agent_service.loop.service import LoopService
from agent_service.loop.store import InMemoryLoopRepository
from agent_service.mainline.factory import build_mainline_service
from agent_service.mainline.models import RunStatus
from shared.contracts.runspec import RunSpec


def _build(mainline=None):
    mainline = mainline or build_mainline_service()
    service, scheduler = build_loop_service(mainline=mainline)
    return mainline, service, scheduler


def test_due_loop_fires_and_starts_run_via_gateway():
    """到点：enabled loop 触发 -> 复用 A1 start_run -> run 终态 COMPLETED 落库。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    loop = service.create_loop(
        conversation_id=conv.id,
        cron="* * * * *",
        run_spec=RunSpec(system_prompt="每日巡检"),
        enabled=True,
    )

    outcomes = asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))

    assert len(outcomes) == 1
    assert outcomes[0].ok is True
    run_id = outcomes[0].run_id
    assert run_id is not None
    # run 终态落库（复用 A1 Run 主记录）。
    assert mainline.get_run(run_id).status is RunStatus.COMPLETED
    # loop 记了一次 fire。
    updated = service.get_loop(loop.id)
    assert updated.fire_count == 1
    assert updated.last_run_id == run_id


def test_fired_run_events_merge_into_conversation_timeline():
    """Loop 触发的 run 事件并入 conversation timeline（与私聊 run 同构，cursor 单调连续）。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    service.create_loop(
        conversation_id=conv.id, cron="* * * * *", run_spec=RunSpec(model="m1"),
        enabled=True,
    )

    asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))

    events = mainline.read_timeline(conv.id, 0)
    assert events  # 有归一业务事件
    cursors = [e.cursor for e in events]
    assert cursors == list(range(1, len(events) + 1))  # per-conversation 单调连续
    assert events[-1].type == "run_succeeded"
    # 前端只见业务事件：无 runtime 原生类型名（D6）。
    assert "text_delta" not in {e.type for e in events}


def test_disabled_loop_not_fired():
    """disabled loop 不进调度。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    loop = service.create_loop(
        conversation_id=conv.id, cron="* * * * *", enabled=False,
    )

    outcomes = asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))

    assert outcomes == []
    assert service.get_loop(loop.id).fire_count == 0


def test_enable_then_disable_stops_firing():
    """运行期 enable/disable 立即生效：disable 后下一 tick 不再触发（仅运行期执行）。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    loop = service.create_loop(
        conversation_id=conv.id, cron="* * * * *", enabled=True,
    )

    now = datetime(2026, 6, 20, 12, 30)
    out1 = asyncio.run(scheduler.fire_ready(now))
    assert len(out1) == 1 and out1[0].ok

    service.pause(loop.id)
    out2 = asyncio.run(scheduler.fire_ready(now))
    assert out2 == []  # disabled -> 不触发
    assert service.get_loop(loop.id).fire_count == 1


def test_same_minute_idempotent_no_double_fire():
    """幂等：同一分钟重复 fire_ready 不重复触发同一 loop。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    service.create_loop(conversation_id=conv.id, cron="* * * * *", enabled=True)

    now = datetime(2026, 6, 20, 12, 30)
    out1 = asyncio.run(scheduler.fire_ready(now))
    out2 = asyncio.run(scheduler.fire_ready(now))  # 同一分钟再 tick

    assert len(out1) == 1
    assert out2 == []  # 幂等：本分钟已触发
    assert len(mainline.list_runs(conv.id)) == 1


def test_next_minute_fires_again():
    """跨分钟：下一分钟到点可再次触发（fire_count 累计）。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    loop = service.create_loop(
        conversation_id=conv.id, cron="* * * * *", enabled=True,
    )

    asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))
    asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 31)))

    assert service.get_loop(loop.id).fire_count == 2
    assert len(mainline.list_runs(conv.id)) == 2


def test_cron_not_due_skipped():
    """cron 未到点：不触发（验证判定真用 cron.py，不无条件触发）。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    service.create_loop(
        conversation_id=conv.id, cron="0 9 * * *", enabled=True,  # 仅 9:00
    )

    outcomes = asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))

    assert outcomes == []


def test_invalid_cron_skipped_with_warning():
    """非法 cron：调度器跳过该 loop（不抛、不崩），日志告警。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    service.create_loop(
        conversation_id=conv.id, cron="not a cron", enabled=True,
    )

    outcomes = asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))

    assert outcomes == []  # 跳过，不崩


def test_scheduler_start_stop_lifecycle():
    """运行期 start/stop：start 后 running=True，stop 后 running=False（仅运行期执行）。"""
    mainline, service, scheduler = _build()

    assert scheduler.running is False

    async def scenario():
        scheduler.start()
        assert scheduler.running is True
        await scheduler.stop()
        assert scheduler.running is False

    asyncio.run(scenario())


def test_scheduler_start_idempotent():
    mainline, service, scheduler = _build()

    async def scenario():
        scheduler.start()
        task1 = scheduler._task  # noqa: SLF001
        scheduler.start()  # 重复 start 幂等
        assert scheduler._task is task1  # noqa: SLF001
        await scheduler.stop()

    asyncio.run(scenario())


def test_fire_does_not_mutate_loop_runspec_template():
    """每次触发复制模板，不在 loop 间/触发间共享可变 RunSpec。"""
    mainline, service, scheduler = _build()
    conv = mainline.create_conversation()
    loop = service.create_loop(
        conversation_id=conv.id, cron="* * * * *",
        run_spec=RunSpec(system_prompt="原始"), enabled=True,
    )

    asyncio.run(scheduler.fire_ready(datetime(2026, 6, 20, 12, 30)))

    # loop 上的模板未被触发改写。
    assert service.get_loop(loop.id).run_spec.system_prompt == "原始"


def test_loop_does_not_use_hermes_cron_or_persist_server_daemon():
    """红线回归：Loop 调度器不经 hermes cron、不做服务端常驻代跑。

    断言调度器不 import hermes / croniter；Loop 模型无 hermes/cron-binding 字段。
    （行为红线由 scheduler.start/stop + disable 测试覆盖；此处补结构性断言。）
    注意：模块 docstring 会写"不依赖 hermes cron"作为红线说明，属正当，故只查 import 行。
    """
    import inspect
    import re

    from agent_service.loop import scheduler as sched_mod

    src = inspect.getsource(sched_mod)
    import_lines = [ln for ln in src.splitlines() if re.match(r"\s*(from|import)\s", ln)]
    for ln in import_lines:
        assert "hermes" not in ln.lower(), f"scheduler import 了 hermes: {ln}"
        assert "croniter" not in ln.lower(), f"scheduler import 了 croniter: {ln}"
    # Loop 模型无 hermes 绑定字段（仅有中立 cron 字符串 + 中立 RunSpec）。
    fields = set(Loop.model_fields)
    assert not any("hermes" in f.lower() for f in fields)


def test_loop_status_is_loop_status_enum_not_display():
    """红线：loop 主状态用 LoopStatus（持久化枚举），非展示态（D6）。"""
    from shared.contracts.enums import DisplayState

    display_values = {s.value for s in DisplayState}
    loop_values = {s.value for s in LoopStatus}
    assert not (loop_values & display_values)
