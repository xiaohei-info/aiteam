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
from .execution_orchestrator import ExecutionOrchestrator
from .models import MessageRole, Run, Task
from .service import MainlineService

MAX_ORCHESTRATED_EXPERTS = 8
_SYNTHETIC_PLANNER_HANDLE = "__planner__"


class GroupExpert(BaseModel):
    """群聊里的一个专家（员工实例的本地最小投影）。

    AITEAM-689 (M1)：补齐 employee_id/provider_ref/thinking_level/skills/knowledge_refs/
    connector_refs/memory_policy，使群聊入口可基于专家快照派生 RunSpec（M1 #4）。
    employee_id 是被 @ 专家的真实员工标识，供 ExecutionOrchestrator 冻结快照；
    handle 仅作 @提及路由键（前端可用 display_name/employee_id 作为稳定 handle）。
    """

    model_config = ConfigDict(extra="forbid")

    handle: str
    system_prompt: str | None = None
    model: str | None = None
    display_name: str | None = Field(
        default=None,
        description="用于 @ 提及与人机展示的可读名（如中文名「李四」）；ASCII handle 与之不同名。"
        "为空则仅能用 ASCII handle 被 @到。Layer 2 fallback 的 alias 键。",
    )
    # ── M1 专家快照派生字段 ──────────────────────────────────────────────
    employee_id: str | None = Field(
        default=None, description="被 @ 专家的真实员工标识；编排服务据此冻结快照派生 RunSpec"
    )
    provider_ref: str | None = Field(default=None, description="provider 配置引用（04 §6.7）")
    thinking_level: str | None = Field(default=None, description="思考深度：none/basic/deep")
    skills: list[str] = Field(default_factory=list, description="技能引用列表")
    knowledge_refs: list[str] = Field(default_factory=list, description="已授权知识集引用")
    connector_refs: list[str] = Field(default_factory=list, description="连接器引用列表")
    memory_policy: dict | None = Field(default=None, description="记忆策略（04 §6.6，mem0）")

    def to_run_spec(self) -> RunSpec:
        """由 roster 最小投影构造 RunSpec（编排服务不在场时的兼容路径）。"""
        return RunSpec(
            system_prompt=self.system_prompt,
            model=self.model,
            provider_ref=self.provider_ref,
            thinking_level=self.thinking_level,
        )


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
        return spec
    header = "【编排规则（必须严格遵守，优先级高于下方默认提示）】\n" f"{text}"
    base = (spec.system_prompt or "").strip()
    merged = f"{header}\n\n{base}" if base else header
    return spec.model_copy(update={"system_prompt": merged})


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

    def __init__(
        self,
        mainline: MainlineService,
        *,
        experts: list[GroupExpert],
        orchestrator: ExecutionOrchestrator | None = None,
        tenant_id: str = "local",
        member_id: str = "local",
    ) -> None:
        self._mainline = mainline
        self._roster: dict[str, GroupExpert] = {e.handle: e for e in experts}
        # 专家快照驱动统一执行编排（AITEAM-689 / M1）；在场时按被 @ 专家逐个派生。
        self._orchestrator = orchestrator
        self._tenant_id = tenant_id
        self._member_id = member_id

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
        run_items = self._experts_to_run_items(experts)
        runs = await self._run_experts(conversation_id, run_items)

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
        return await self._run_experts(conversation_id, self._experts_to_run_items(experts))


    def _experts_to_run_items(self, experts: list[GroupExpert]) -> list:
        """把 roster 专家列表转成 _run_experts 的 items。

        M1：编排服务在场且专家带 employee_id → 据快照派生 RunSpec + 绑定元数据；
        否则回退到 roster 最小投影（向后兼容）。每个 item 形状：
            (_RunKey(handle), RunSpec, RunBinding|None, task|None)
        task 仅在编排执行阶段由调用方注入；自由讨论无 task。
        """
        items = []
        for e in experts:
            if self._orchestrator is not None and (e.employee_id or "").strip():
                prepared = self._orchestrator.prepare_private_run(
                    _BoundConversation(e.employee_id),
                    tenant_id=self._tenant_id,
                    member_id=self._member_id,
                )
                items.append((_RunKey(e.handle), prepared.run_spec, prepared.binding, None))
            else:
                items.append((_RunKey(e.handle), e.to_run_spec(), None, None))
        return items

    def _prepare_expert_spec(self, expert: GroupExpert):
        """从本地专家快照派生 RunSpec；无编排器时保留旧的 roster 兼容路径。"""
        if self._orchestrator is not None and (expert.employee_id or "").strip():
            prepared = self._orchestrator.prepare_private_run(
                _BoundConversation(expert.employee_id),
                tenant_id=self._tenant_id,
                member_id=self._member_id,
            )
            return prepared.run_spec, prepared.binding
        return expert.to_run_spec(), None

    async def _dispatch_orchestrated(self, conv, user_text: str) -> DispatchResult:
        """规则编排：planner 拆解任务树 -> 分专家并行 -> 聚合。

        两入口：
        - 自由协作 orchestrated：仅走 brief + 自动 planner（自由拉 agent 的默认行为）。
        - 固定编排（solution_*_prompt 非空）：读取该会话自带的三阶段 prompts 作为固定编排规则
          （planner / subtask / aggregate），UI 只读；brief 不再覆盖。
        """
        brief = (getattr(conv, "orchestration_brief", "") or "").strip()
        # 固定编排 prompts（由 Operator solution_template 落到会话的快照）。
        fixed_prompts = bool((getattr(conv, "solution_instance_id", None) or "").strip())
        sol_planner = (getattr(conv, "solution_planner_prompt", "") or "").strip()
        sol_subtask = (getattr(conv, "solution_subtask_prompt", "") or "").strip()
        sol_aggregate = (getattr(conv, "solution_aggregate_prompt", "") or "").strip()
        fixed = fixed_prompts and bool(sol_planner or sol_subtask or sol_aggregate)
        planner_handle = getattr(conv, "planner_employee_id", None) or None

        # Fixed orchestration must only dispatch to solution-bound experts (roster ∩ solution_experts).
        bound_handles: set[str] = set(getattr(conv, "solution_expert_employee_ids", None) or [])
        roster_handles = set(self._roster)
        if fixed_prompts:
            if not bound_handles:
                raise RuntimeError("solution instance has no expert_employee_ids; cannot run fixed orchestration")
            allowed_handles = roster_handles & bound_handles
            if not allowed_handles:
                raise RuntimeError("roster and solution experts have no intersection; cannot run fixed orchestration")
        else:
            allowed_handles = roster_handles
        if planner_handle and planner_handle in allowed_handles:
            planner = self._roster[planner_handle]
            # 排序保证自由协作 roster 迭代顺序确定性（set 迭代受 hash seed 影响会不稳定）。
            executor_handles = sorted(h for h in allowed_handles if h != planner_handle)
        else:
            planner_handle = _SYNTHETIC_PLANNER_HANDLE
            default_prompt = (
                "你是协作主持人(planner)。请按【编排规则】把用户任务拆解为可并行子任务，"
                "只输出 JSON: {\"subtasks\":[{\"title\",\"description\",\"assignee\",\"depends_on\":[]}]}"
            )
            # 固定编排：syst 级提示词 = 方案自带的 planner prompt；自由协作回退默认。
            # 方案群聊的 planner 也必须继承某个已授权专家的运行时映射；不能构造
            # 空 RunSpec，否则 provider_ref 会丢失，运行期无法注入最小凭据。
            planner = (
                self._roster[sorted(allowed_handles)[0]]
                if self._orchestrator is not None and allowed_handles
                else GroupExpert(
                    handle=_SYNTHETIC_PLANNER_HANDLE,
                    system_prompt=sol_planner or default_prompt,
                )
            )
            executor_handles = sorted(allowed_handles)

        # 1) planner 拆解：固定编排直接用方案 prompt（叠加用户任务上下文）；自由协作走 brief。
        planner_rule = sol_planner if fixed else brief
        planner_base_spec, planner_binding = self._prepare_expert_spec(planner)
        planner_spec = _inject_brief(
            planner_base_spec,
            planner_rule + ("\n\n用户任务：" + user_text if user_text else planner_rule),
        )
        planner_kwargs = {"run_spec": planner_spec}
        if planner_binding is not None:
            from .service import _binding_view_to_run_binding
            planner_kwargs["run_binding"] = _binding_view_to_run_binding(planner_binding)
        planner_run = await self._mainline.start_run(conv.id, **planner_kwargs)
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
        binding_by_assignee: dict[str, object | None] = {}
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
            expert = self._roster.get(assignee)
            if fixed and self._orchestrator is None:
                base_spec, binding = RunSpec(), None
            else:
                base_spec, binding = self._prepare_expert_spec(expert) if expert else (RunSpec(), None)
            spec_by_assignee[assignee] = _inject_brief(base_spec, sub_rule)
            binding_by_assignee[assignee] = binding
            task_nodes.append(TaskNode(
                task_id=task.id, title=sub.title, assignee=assignee, depends_on=[root_task.id],
            ))

        # 4) 并行执行各专家子任务（编排规则 + 子任务上下文注入）。
        runs: list[Run] = [planner_run]
        run_items = [
            (
                _RunKey(sub.assignee),
                spec_by_assignee[sub.assignee],
                binding_by_assignee[sub.assignee],
                tasks_by_assignee[sub.assignee],
            )
            for sub in subtasks if sub.assignee in spec_by_assignee
        ]
        if run_items:
            runs.extend(await self._run_experts(conv.id, run_items))

        # 5) 聚合：固定编排用方案级 aggregate_prompt；自由协作用 brief + 默认汇总指令。
        if fixed:
            aggregate_rule = sol_aggregate
        else:
            aggregate_rule = brief + "\n\n请汇总下列各成员产出，合并为一个面向用户的最终交付。"
        aggregate_spec = _inject_brief(planner_base_spec, aggregate_rule)
        aggregate_kwargs = {"run_spec": aggregate_spec}
        if planner_binding is not None:
            from .service import _binding_view_to_run_binding
            aggregate_kwargs["run_binding"] = _binding_view_to_run_binding(planner_binding)
        runs.append(await self._mainline.start_run(conv.id, **aggregate_kwargs))

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

        items 元素为四元组 (key, spec, binding, task)：
        - key：唯一标识每个元素、避免同专家被去重；
        - spec：中立 RunSpec；
        - binding：Expert 快照绑定元数据（M1），可为 None；
        - task：仅在编排执行阶段由调用方注入；自由讨论无 task（None）。
        key 仅用于唯一标识每个元素、避免同专家被去重。兼容更短的旧 tuple。
        """
        if not items:
            return []

        async def _start(item):
            key, spec, binding, task = _normalize_item(item)
            kwargs = {"conversation_id": conversation_id, "run_spec": spec}
            if binding is not None:
                from .service import _binding_view_to_run_binding
                kwargs["run_binding"] = _binding_view_to_run_binding(binding)
            if task is not None:
                kwargs["task_id"] = task.id
            return await self._mainline.start_run(**kwargs)

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


class _BoundConversation:
    """适配 ExecutionOrchestrator.prepare_private_run 的 conversation 协议。"""

    def __init__(self, entry_employee_id: str) -> None:
        self.entry_employee_id = entry_employee_id


def _normalize_item(item):
    """把 (key, spec)、(key, spec, task) 或 (key, spec, binding, task) 统一为四元组。"""
    if len(item) == 4:
        return item
    if len(item) == 3:
        # 兼容旧 shape (key, spec, task)。
        key, spec, task = item
        return key, spec, None, task
    key, spec = item
    return key, spec, None, None

class _RunKey:
    """仅用于在 items 内保留重复专家的轻量 key。"""

    model_config = ConfigDict(extra="forbid")

    def __init__(self, handle: str) -> None:
        self.handle = handle

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _RunKey) and other.handle == self.handle

    def __hash__(self) -> int:
        return id(self)
