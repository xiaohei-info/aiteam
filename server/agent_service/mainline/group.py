"""群聊：自由讨论(@提及) / 规则编排(planner 拆解) 双模式（06 §7.6 / D19）。

群聊 = 单用户本机多专家协作（00 §19 已排除跨机器会话同步）。本模块在 A1 MainlineService 之上做一
层薄编排，**不重写 run/timeline/SSE/WS 主链**：

    post_and_dispatch(conv, user_text)
        - 读取会话 collaboration_mode（parity Manager 侧 Conversation）
        - free（默认）: 仅 @提及专家起 run（现有行为，不变）
        - orchestrated: planner 按 orchestration_brief 拆解任务树 -> 分专家并行执行 -> 聚合结果

防回环（红线，CLAUDE/AGENTS §8）：
- 只有 USER 角色消息进入编排；专家产出的文本绝不作为新一轮编排触发源。
- dispatch_for_expert 额外用 exclude_handle 排除发起方自身。
"""

from __future__ import annotations

import asyncio
import json
import re

from pydantic import BaseModel, ConfigDict, Field

from shared.contracts.runspec import RunSpec

from . import mentions
from .models import MessageRole, Run, Task
from .service import MainlineService

MAX_ORCHESTRATED_EXPERTS = 8
_SYNTHETIC_PLANNER_HANDLE = "__planner__"


class GroupExpert(BaseModel):
    """群聊里的一个专家（员工实例的本地最小投影）。"""

    model_config = ConfigDict(extra="forbid")

    handle: str
    system_prompt: str | None = None
    model: str | None = None
    display_name: str | None = Field(
        default=None,
        description="用于 @ 提及与人机展示的可读名（如中文名「李四」）；ASCII handle 与之不同名。"
        "为空则仅能用 ASCII handle 被 @到。Layer 2 fallback 的 alias 键。",
    )

    def to_run_spec(self) -> RunSpec:
        return RunSpec(system_prompt=self.system_prompt, model=self.model)


class Subtask(BaseModel):
    """planner 拆解出的一个子任务。"""

    model_config = ConfigDict(extra="forbid")
    title: str
    description: str = ""
    assignee: str = ""
    depends_on: list[int] = Field(default_factory=list)


class TaskNode(BaseModel):
    """持久化的编排任务树节点（镜像 MainlineService Task）。"""

    model_config = ConfigDict(extra="forbid")
    task_id: str
    title: str
    assignee: str = ""
    run_id: str | None = None
    depends_on: list[str] = Field(default_factory=list)


class DispatchResult(BaseModel):
    """一轮群聊编排的结果。"""

    model_config = ConfigDict(extra="forbid")

    triggered_handles: list[str] = Field(default_factory=list)
    runs: list[Run] = Field(default_factory=list)
    ignored_handles: list[str] = Field(
        default_factory=list,
        description="本轮 input 中未被 roster 命中的 @token 列表（保序，前缀 @）。"
        "前端据此给出负向可见提示（issue #414）。",
    )
    collaboration_mode: str = "free"
    orchestration_brief: str = ""
    default_route_hint: str = "auto"
    task_tree: list[TaskNode] = Field(default_factory=list)


def _inject_brief(spec: RunSpec, brief: str) -> RunSpec:
    """把编排指令注入 RunSpec.system_prompt（parity Manager 侧 planner 注入策略）。"""
    text = (brief or "").strip()
    if not text:
        return RunSpec(system_prompt=spec.system_prompt, model=spec.model)
    header = "【编排规则（必须严格遵守，优先级高于下方默认提示）】\n" f"{text}"
    base = (spec.system_prompt or "").strip()
    merged = f"{header}\n\n{base}" if base else header
    return RunSpec(system_prompt=merged, model=spec.model)


def _extract_json(text: str):
    cleaned = re.sub(r"```(?:json)?", "", text)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return None


def _parse_plan(text: str, roster_handles: list[str]) -> list[Subtask] | None:
    if not text or not roster_handles:
        return None
    raw = _extract_json(text)
    if not isinstance(raw, dict):
        return None
    items = raw.get("subtasks")
    if not items or not isinstance(items, list):
        return None
    subtasks: list[Subtask] = []
    emitted_handles: set[str] = set()
    for item in items[:MAX_ORCHESTRATED_EXPERTS]:
        if not isinstance(item, dict):
            continue
        assignee = str(item.get("assignee") or "").strip()
        if assignee and assignee not in roster_handles:
            continue
        if assignee in emitted_handles:
            continue
        deps = [int(d) for d in (item.get("depends_on") or []) if isinstance(d, (int, float)) and 0 <= d < MAX_ORCHESTRATED_EXPERTS]
        subtasks.append(Subtask(
            title=(str(item.get("title") or "").strip() or f"子任务 {len(subtasks) + 1}"),
            description=str(item.get("description") or "").strip(),
            assignee=assignee,
            depends_on=deps,
        ))
        if assignee:
            emitted_handles.add(assignee)
    if not subtasks:
        return None
    valid = set(range(len(subtasks)))
    for task in subtasks:
        task.depends_on = [d for d in task.depends_on if d in valid]
    return subtasks


def _fallback_plan(message_text: str, roster_handles: list[str]) -> list[Subtask]:
    head = message_text.strip().splitlines()[0][:40] if message_text.strip() else "协作任务"
    return [
        Subtask(title=f"处理: {head}", description=message_text.strip(), assignee=handle, depends_on=[])
        for handle in roster_handles[:MAX_ORCHESTRATED_EXPERTS]
    ]


class GroupChatService:
    """群聊编排器：自由讨论 / 规则编排双模式。"""

    def __init__(self, mainline: MainlineService, *, experts: list[GroupExpert]) -> None:
        self._mainline = mainline
        self._roster: dict[str, GroupExpert] = {e.handle: e for e in experts}

    @property
    def mainline(self) -> MainlineService:
        """底层主链（供路由层复用 A1 的 timeline/SSE/WS 与读接口）。"""
        return self._mainline

    async def post_and_dispatch(self, conversation_id: str, user_text: str) -> DispatchResult:
        """用户发言入口：按会话 collaboration_mode 分派到自由讨论 / 规则编排。"""
        conv = self._mainline.get_conversation(conversation_id)
        self._mainline.add_message(conversation_id, role=MessageRole.USER, content=user_text)

        if getattr(conv, "collaboration_mode", "free") == "orchestrated":
            return await self._dispatch_orchestrated(conv, user_text)

        experts, ignored = mentions.classify_mentions(user_text, self._roster)
        runs = await self._run_experts(
            conversation_id, [(_RunKey(e.handle), e.to_run_spec()) for e in experts]
        )
        return DispatchResult(
            triggered_handles=[e.handle for e in experts],
            runs=runs,
            ignored_handles=list(ignored),
            collaboration_mode="free",
            default_route_hint="auto",
            task_tree=[],
        )

    async def dispatch_for_expert(
        self, conversation_id: str, text: str, *, origin_handle: str
    ) -> list[Run]:
        """编排策略按某专家发起下一跳时用（排除发起方自身，防自激回环）。"""
        experts, _ignored = mentions.classify_mentions(text, self._roster, exclude_handle=origin_handle)
        return await self._run_experts(
            conversation_id, [(_RunKey(e.handle), e.to_run_spec()) for e in experts]
        )

    async def _dispatch_orchestrated(self, conv, user_text: str) -> DispatchResult:
        """规则编排：planner 拆解任务树 -> 分专家并行 -> 聚合。

        两入口：
        - 自由协作 orchestrated：仅走 brief + 自动 planner（自由拉 agent 的默认行为）。
        - 固定编排（solution_*_prompt 非空）：读取该会话自带的三阶段 prompts 作为固定编排规则
          （planner / subtask / aggregate），UI 只读；brief 不再覆盖。
        """
        brief = (getattr(conv, "orchestration_brief", "") or "").strip()
        # 固定编排 prompts（由 Operator solution_template 落到会话的快照）。
        sol_planner = (getattr(conv, "solution_planner_prompt", "") or "").strip()
        sol_subtask = (getattr(conv, "solution_subtask_prompt", "") or "").strip()
        sol_aggregate = (getattr(conv, "solution_aggregate_prompt", "") or "").strip()
        fixed = bool(sol_planner or sol_subtask or sol_aggregate)
        planner_handle = getattr(conv, "planner_employee_id", None) or None

        if planner_handle and planner_handle in self._roster:
            planner = self._roster[planner_handle]
            executor_handles = [h for h in self._roster if h != planner_handle]
        else:
            planner_handle = _SYNTHETIC_PLANNER_HANDLE
            default_prompt = (
                "你是协作主持人(planner)。请按【编排规则】把用户任务拆解为可并行子任务，"
                "只输出 JSON: {\"subtasks\":[{\"title\",\"description\",\"assignee\",\"depends_on\":[]}]}"
            )
            # 固定编排：syst 级提示词 = 方案自带的 planner prompt；自由协作回退默认。
            planner = GroupExpert(
                handle=_SYNTHETIC_PLANNER_HANDLE,
                system_prompt=sol_planner or default_prompt,
            )
            executor_handles = list(self._roster)

        # 1) planner 拆解：固定编排直接用方案 prompt（叠加用户任务上下文）；自由协作走 brief。
        planner_rule = sol_planner if fixed else brief
        planner_spec = _inject_brief(
            planner.to_run_spec(),
            planner_rule + ("\n\n用户任务：" + user_text if user_text else planner_rule),
        )
        planner_run = await self._mainline.start_run(conv.id, run_spec=planner_spec)
        plan_text = self._run_completed_text(planner_run)

        # 2) 解析 plan；无法解析（如 fake runtime）则降级为每专家一子任务。
        subtasks = _parse_plan(plan_text, executor_handles) or _fallback_plan(
            user_text, executor_handles
        )

        # 3) 建任务树：根任务(planner) + 每个子任务。
        root_task = self._mainline.create_task(
            conv.id, title=user_text[:60] or "协作编排", run_id=planner_run.id,
        )
        task_nodes: list[TaskNode] = [
            TaskNode(task_id=root_task.id, title=user_text[:60] or "协作编排",
                     assignee=planner_handle or "", run_id=planner_run.id),
        ]
        spec_by_assignee: dict[str, RunSpec] = {}
        tasks_by_assignee: dict[str, Task] = {}
        for sub in subtasks:
            assignee = sub.assignee or (executor_handles[0] if executor_handles else "")
            task = self._mainline.create_task(conv.id, title=sub.title)
            tasks_by_assignee[assignee] = task
            # 子任务注入：固定编排用方案级 subtask_prompt；自由协作用 brief + 子任务标题。
            if fixed:
                sub_rule = sol_subtask + ("\n\n子任务：" + sub.title + ("\n" + sub.description).rstrip()).strip()
            else:
                sub_rule = brief + ("\n\n子任务：" + sub.title + ("\n" + sub.description).rstrip()).strip()
            spec_by_assignee[assignee] = _inject_brief(
                self._roster[assignee].to_run_spec() if assignee in self._roster else RunSpec(),
                sub_rule,
            )
            task_nodes.append(TaskNode(
                task_id=task.id, title=sub.title, assignee=assignee, depends_on=[root_task.id],
            ))

        # 4) 并行执行各专家子任务（编排规则 + 子任务上下文注入）。
        runs: list[Run] = [planner_run]
        run_items = [
            (_RunKey(sub.assignee), spec_by_assignee[sub.assignee], tasks_by_assignee[sub.assignee])
            for sub in subtasks if sub.assignee in spec_by_assignee
        ]
        if run_items:
            runs.extend(await self._run_experts(conv.id, run_items))

        # 5) 聚合：固定编排用方案级 aggregate_prompt；自由协作用 brief + 默认汇总指令。
        if fixed:
            aggregate_rule = sol_aggregate
        else:
            aggregate_rule = brief + "\n\n请汇总下列各成员产出，合并为一个面向用户的最终交付。"
        aggregate_spec = _inject_brief(planner.to_run_spec(), aggregate_rule)
        runs.append(await self._mainline.start_run(conv.id, run_spec=aggregate_spec))

        return DispatchResult(
            triggered_handles=[sub.assignee for sub in subtasks],
            runs=runs,
            collaboration_mode="orchestrated",
            orchestration_brief=brief,
            default_route_hint="orchestration",
            task_tree=task_nodes,
        )

    async def _run_experts(self, conversation_id, items) -> list[Run]:
        """并发起 runs。

        items 元素为二元组 (key, spec) 或三元组 (key, spec, task)。
        key 仅用于唯一标识每个元素、避免同专家被去重。
        """
        if not items:
            return []

        async def _start(item):
            if len(item) == 3:
                _, spec, task = item
                return await self._mainline.start_run(
                    conversation_id, run_spec=spec, task_id=task.id
                )
            _, spec = item
            return await self._mainline.start_run(conversation_id, run_spec=spec)

        return list(await asyncio.gather(*(_start(i) for i in items)))

    def _run_completed_text(self, run: Run) -> str:
        """从该 run 已落地的 timeline 终态事件取出 final_text。"""
        try:
            events = self._mainline.read_timeline(run.conversation_id, 0)
        except Exception:  # noqa: BLE001
            return ""
        run_id = getattr(run, "id", None)
        for ev in reversed(events):
            if getattr(ev, "run_id", None) != run_id:
                continue
            if getattr(ev, "type", "") == "run_succeeded":
                payload = getattr(ev, "payload", {}) or {}
                return str(payload.get("final_text") or "")
        return ""


class _RunKey:
    """仅用于在 items 内保留重复专家的轻量 key。"""

    model_config = ConfigDict(extra="forbid")

    def __init__(self, handle: str) -> None:
        self.handle = handle

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _RunKey) and other.handle == self.handle

    def __hash__(self) -> int:
        return id(self)
