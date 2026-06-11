"""Orchestration executor — 群聊多智能体编排的真实执行链.

设计依据: 业务解决方案 §5.2-C「业务协作语义自定义 + 执行 runtime 直接复用」。
编排语义(拆解/依赖/并行/汇总)落在 Gateway; 每个子任务仍通过 WebUI loopback
链以受派员工自身 profile/persona/知识执行(同 runtime_executor 单 agent 路径)。
差异备案: docs/技术设计/详细设计文档/2026-06-11-AI Team-Gateway执行链路实现口径与设计差异备案.md §3。

流程:
1. planner 员工拆解任务为结构化子任务(解析失败降级为按目标员工均分);
2. root/子任务以 task_created/started/completed/failed 事件回流,
   复用 event_ingest_service 既有 TeamTask 镜像构建任务树;
3. 子任务按依赖分波执行, 同波并行; 失败不阻塞其他分支;
4. 每个子任务产出受派员工署名的群聊消息(多智能体并发响应);
5. planner 汇总轮流式输出, 发 result_merged 与终态事件。

并发口径: 事件游标由 runtime_binding.event_cursor+1 分配, 并行线程统一经
_EVENT_LOCK 串行写入, 避免游标撞号; 每个工作线程持有独立 DB 连接。
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

logger = logging.getLogger(__name__)

MAX_SUBTASKS = int(os.getenv("AITEAM_ORCH_MAX_SUBTASKS", "6"))
MAX_PARALLEL = int(os.getenv("AITEAM_ORCH_MAX_PARALLEL", "3"))

_EVENT_LOCK = threading.Lock()


# ── Public entrypoint ─────────────────────────────────────────────────────

def execute_orchestration(conn, run_id: str) -> None:
    """Execute a kanban_orchestration run. Caller owns ``conn``."""
    from agent_gateway.runtime_executor import _finalize

    ctx = _start_run(conn, run_id)
    if ctx is None:
        return

    # Phase 1 — planner 拆解 (失败降级为按目标员工均分).
    subtasks = _plan_subtasks(ctx)

    # Phase 2 — 任务树事件 (root + children), 镜像由 event_ingest 完成.
    _emit_task_tree(run_id, ctx, subtasks)

    # Phase 3 — 按依赖分波执行, 同波并行.
    results = _execute_waves(run_id, ctx, subtasks)

    # Phase 4 — planner 汇总 + result_merged + 终态.
    succeeded = [i for i, r in results.items() if r["success"]]
    if not succeeded:
        first_error = next((r["error"] for r in results.values() if r["error"]), "全部子任务执行失败")
        _finalize(run_id, success=False, output="多智能体协作执行失败",
                  error=first_error, employee_id=ctx["planner_id"], conn=conn)
        return

    final_text = _aggregate(conn, run_id, ctx, subtasks, results)
    _emit_standalone(run_id, "result_merged",
                     source_id=ctx["root_task_id"],
                     preview=f"已汇总 {len(succeeded)}/{len(subtasks)} 个子任务成果",
                     payload={"subtasks": [
                         {"task_id": _subtask_id(run_id, i),
                          "title": t["title"],
                          "assignee_employee_id": t["assignee"],
                          "status": "succeeded" if results[i]["success"] else "failed",
                          "preview": (results[i]["output"] or results[i]["error"])[:200]}
                         for i, t in enumerate(subtasks)]},
                     employee_id=ctx["planner_id"])
    _finalize(run_id, success=True, output=final_text,
              employee_id=ctx["planner_id"], conn=conn)


# ── Phase 0: load context + mark running ─────────────────────────────────

def _start_run(conn, run_id: str) -> dict | None:
    from agent_gateway.runtime_executor import _ingest
    from team_panel.transactions.uow import UnitOfWork

    with UnitOfWork(conn) as uow:
        run = uow.team_runs().get_by_id(run_id)
        if run is None:
            logger.warning("[orch] run %s not found", run_id)
            return None
        if run.status not in ("queued", "routing", "submitting"):
            logger.info("[orch] run %s already %s; skip", run_id, run.status)
            return None

        summary = _load_json(run.result_summary_json)
        input_payload = _load_json(run.input_message_json)
        targets = [str(e) for e in (summary.get("candidate_employee_ids")
                                    or summary.get("target_employee_ids") or []) if e]
        planner_id = str(summary.get("planner_employee_id")
                         or run.planner_employee_id or run.entry_employee_id or "")
        if not targets:
            targets = [planner_id] if planner_id else []
        if not planner_id and targets:
            planner_id = targets[0]

        employees = {}
        for emp_id in dict.fromkeys(targets + [planner_id]):
            emp = uow.employees().get_by_id(emp_id) if emp_id else None
            if emp is not None:
                employees[emp_id] = emp
        targets = [e for e in targets if e in employees]
        if not targets:
            logger.warning("[orch] run %s has no resolvable target employees", run_id)
            run.status = "failed"
            uow.team_runs().update_status(run)
            return None
        if planner_id not in employees:
            planner_id = targets[0]

        binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
        root_task_id = (binding.runtime_task_id if binding else "") or f"root_{run_id}"

        run.status = "running"
        uow.team_runs().update_status(run)
        _ingest(uow, run, "run_started",
                preview=f"主持员工开始编排, 协作成员 {len(targets)} 人",
                payload={"planner_employee_id": planner_id,
                         "target_employee_ids": targets},
                employee_id=planner_id)

        return {
            "enterprise_id": run.enterprise_id,
            "conversation_id": run.conversation_id,
            "message_text": str(input_payload.get("message_text") or ""),
            "targets": targets,
            "planner_id": planner_id,
            "employees": employees,
            "root_task_id": root_task_id,
            "prompts": {
                emp_id: ((uow.employee_prompts().get_by_employee(emp_id) or None) and
                         uow.employee_prompts().get_by_employee(emp_id).system_prompt or "")
                for emp_id in employees
            },
            "kb_ids": {
                emp_id: [b.knowledge_base_id
                         for b in uow.employee_knowledge_bindings().list_by_employee(emp_id)
                         if getattr(b, "enabled", True)]
                for emp_id in employees
            },
        }


# ── Phase 1: planner 拆解 ─────────────────────────────────────────────────

def _plan_subtasks(ctx: dict) -> list[dict]:
    roster = "\n".join(
        f"- {emp_id}: {ctx['employees'][emp_id].display_name or emp_id}"
        f"（{ctx['employees'][emp_id].role_name or '协作成员'}）"
        for emp_id in ctx["targets"]
    )
    plan_prompt = (
        "你是本次群聊协作的主持人, 请把任务拆解为子任务并分配给可用成员。\n\n"
        f"可用成员（assignee 必须使用 employee_id）:\n{roster}\n\n"
        f"任务: {ctx['message_text']}\n\n"
        f"要求: 2 到 {MAX_SUBTASKS} 个子任务; depends_on 填依赖的子任务序号(从0开始), 无依赖填 []。\n"
        "只输出 JSON, 不要任何其他文字, 格式:\n"
        '{"subtasks": [{"title": "...", "description": "...", '
        '"assignee": "<employee_id>", "depends_on": []}]}'
    )
    text = _run_employee_turn(ctx, ctx["planner_id"], plan_prompt, inject_knowledge=False)[1]
    plan = parse_plan(text, ctx["targets"])
    if plan:
        return plan
    logger.warning("[orch] planner output unparseable; fallback to per-target split")
    return fallback_plan(ctx["targets"], ctx["message_text"])


def parse_plan(text: str, targets: list[str]) -> list[dict]:
    """Parse planner JSON into normalized subtasks. Returns [] when unusable."""
    if not text or not targets:
        return []
    raw = _extract_json(text)
    if not isinstance(raw, dict):
        return []
    items = raw.get("subtasks")
    if not isinstance(items, list) or not items:
        return []

    subtasks: list[dict] = []
    for idx, item in enumerate(items[:MAX_SUBTASKS]):
        if not isinstance(item, dict):
            continue
        assignee = str(item.get("assignee") or "")
        if assignee not in targets:
            assignee = targets[len(subtasks) % len(targets)]
        deps_raw = item.get("depends_on")
        deps = []
        if isinstance(deps_raw, list):
            for d in deps_raw:
                if isinstance(d, int) and 0 <= d < min(len(items), MAX_SUBTASKS) and d != idx:
                    deps.append(d)
        subtasks.append({
            "title": str(item.get("title") or "").strip() or f"子任务 {len(subtasks) + 1}",
            "description": str(item.get("description") or "").strip(),
            "assignee": assignee,
            "depends_on": sorted(set(deps)),
        })
    # 越界依赖(指向被裁剪/跳过的条目)统一清除, 保证可执行.
    valid = set(range(len(subtasks)))
    for task in subtasks:
        task["depends_on"] = [d for d in task["depends_on"] if d in valid]
    return subtasks


def fallback_plan(targets: list[str], message_text: str) -> list[dict]:
    """降级方案: 每个目标员工一个独立子任务, 无依赖。"""
    head = message_text.strip().splitlines()[0][:40] if message_text.strip() else "协作任务"
    return [
        {"title": f"处理: {head}", "description": message_text.strip(),
         "assignee": emp_id, "depends_on": []}
        for emp_id in targets[:MAX_SUBTASKS]
    ]


def _extract_json(text: str):
    cleaned = re.sub(r"```(?:json)?", "", text)
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        return None


# ── Phase 2: 任务树事件 ───────────────────────────────────────────────────

def _subtask_id(run_id: str, index: int) -> str:
    return f"sub_{run_id}_{index}"


def _emit_task_tree(run_id: str, ctx: dict, subtasks: list[dict]) -> None:
    _emit_standalone(run_id, "task_created",
                     source_id=ctx["root_task_id"],
                     preview=f"协作根任务: {ctx['message_text'][:80]}",
                     payload={"title": ctx["message_text"][:80] or "协作任务",
                              "description": ctx["message_text"]},
                     employee_id=ctx["planner_id"])
    for i, task in enumerate(subtasks):
        _emit_standalone(run_id, "task_created",
                         source_id=_subtask_id(run_id, i),
                         preview=f"子任务: {task['title']}",
                         payload={"title": task["title"],
                                  "description": task["description"],
                                  "parent_task_id": ctx["root_task_id"],
                                  "depends_on": [_subtask_id(run_id, d) for d in task["depends_on"]]},
                         employee_id=task["assignee"])


# ── Phase 3: 分波并行执行 ─────────────────────────────────────────────────

def build_waves(subtasks: list[dict]) -> list[list[int]]:
    """依赖分波: 同波互不依赖可并行; 检测到环时剩余任务作为最终波(忽略依赖)。"""
    waves: list[list[int]] = []
    done: set[int] = set()
    remaining = set(range(len(subtasks)))
    while remaining:
        wave = sorted(i for i in remaining
                      if all(d in done for d in subtasks[i]["depends_on"]))
        if not wave:  # 环 — 降级为顺序推进, 不让协作流程卡死
            wave = sorted(remaining)
        waves.append(wave)
        done.update(wave)
        remaining.difference_update(wave)
    return waves


def _execute_waves(run_id: str, ctx: dict, subtasks: list[dict]) -> dict[int, dict]:
    results: dict[int, dict] = {}
    for wave in build_waves(subtasks):
        with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL, len(wave))) as pool:
            futures = {
                pool.submit(_run_subtask_safe, run_id, ctx, subtasks, i, dict(results)): i
                for i in wave
            }
            for future in as_completed(futures):
                results[futures[future]] = future.result()
    return results


def _run_subtask_safe(run_id: str, ctx: dict, subtasks: list[dict],
                      index: int, prior: dict[int, dict]) -> dict:
    try:
        return _run_subtask(run_id, ctx, subtasks, index, prior)
    except Exception as exc:  # noqa: BLE001 — 单个子任务崩溃不拖垮协作流程
        logger.exception("[orch] subtask %s/%s crashed", run_id, index)
        _emit_standalone(run_id, "task_failed",
                         source_id=_subtask_id(run_id, index),
                         preview=f"子任务异常: {exc}",
                         payload={"error": str(exc)},
                         employee_id=subtasks[index]["assignee"])
        return {"success": False, "output": "", "error": str(exc)}


def _run_subtask(run_id: str, ctx: dict, subtasks: list[dict],
                 index: int, prior: dict[int, dict]) -> dict:
    task = subtasks[index]
    task_id = _subtask_id(run_id, index)
    assignee = task["assignee"]

    _emit_standalone(run_id, "task_started",
                     source_id=task_id,
                     preview=f"{_emp_name(ctx, assignee)} 开始执行: {task['title']}",
                     payload={"title": task["title"],
                              "parent_task_id": ctx["root_task_id"]},
                     employee_id=assignee)

    dep_lines = []
    for d in task["depends_on"]:
        dep = prior.get(d)
        if dep is None:
            continue
        dep_task = subtasks[d]
        if dep["success"]:
            dep_lines.append(f"- {dep_task['title']}（{_emp_name(ctx, dep_task['assignee'])}）:\n{dep['output']}")
        else:
            dep_lines.append(f"- {dep_task['title']}: 执行失败（{dep['error'] or '无产出'}）, 请基于现有信息继续推进")

    parts = [
        "[群聊协作任务]",
        f"原始任务: {ctx['message_text']}",
        f"你负责的子任务: {task['title']}" + (f" — {task['description']}" if task["description"] else ""),
    ]
    if dep_lines:
        parts.append("[前序子任务产出]\n" + "\n".join(dep_lines))
    parts.append("请直接给出你这个子任务的成果, 不要复述任务本身。")

    success, output = _run_employee_turn(ctx, assignee, "\n\n".join(parts))

    if success and output:
        _persist_subtask_message(run_id, ctx, assignee, task_id, output)
        _emit_standalone(run_id, "task_completed",
                         source_id=task_id, preview=output[:200],
                         payload={"title": task["title"]},
                         employee_id=assignee)
        return {"success": True, "output": output, "error": ""}

    error = output or "子任务无产出"
    _emit_standalone(run_id, "task_failed",
                     source_id=task_id, preview=error[:200],
                     payload={"title": task["title"], "error": error},
                     employee_id=assignee)
    return {"success": False, "output": "", "error": error}


def _persist_subtask_message(run_id: str, ctx: dict, assignee: str,
                             task_id: str, output: str) -> None:
    from agent_gateway.runtime_executor import _connect
    from team_panel.domain.entities import ConversationMessage
    from team_panel.transactions.uow import UnitOfWork

    conn = _connect()
    try:
        with UnitOfWork(conn) as uow:
            message_id = f"msg_{uuid.uuid4().hex[:12]}"
            uow.conversation_messages().create(ConversationMessage(
                id=message_id,
                conversation_id=ctx["conversation_id"],
                run_id=run_id,
                sender_id=assignee,
                sender_type="employee",
                message_text=output,
                message_json=json.dumps(
                    {"message_text": output, "team_task_id": task_id},
                    ensure_ascii=False),
            ))
            uow.conversations().update_latest_run(
                ctx["conversation_id"], run_id, message_id, output[:200])
    except Exception:  # noqa: BLE001 — 消息落库失败不阻断任务结果
        logger.exception("[orch] subtask message persist failed (%s)", task_id)
    finally:
        conn.close()


# ── Phase 4: planner 汇总 ─────────────────────────────────────────────────

def _aggregate(conn, run_id: str, ctx: dict, subtasks: list[dict],
               results: dict[int, dict]) -> str:
    from agent_gateway.runtime_executor import _DeltaFlusher

    lines = []
    for i, task in enumerate(subtasks):
        r = results[i]
        emp = _emp_name(ctx, task["assignee"])
        if r["success"]:
            lines.append(f"- [完成] {task['title']}（{emp}）:\n{r['output']}")
        else:
            lines.append(f"- [失败] {task['title']}（{emp}）: {r['error'] or '无产出'}")

    prompt = (
        "你是本次群聊协作的主持人。以下是各成员子任务的执行结果, "
        "请汇总为面向用户的最终交付, 直接输出结果本身。\n\n"
        f"原始任务: {ctx['message_text']}\n\n"
        "子任务结果:\n" + "\n".join(lines)
    )

    flusher = _DeltaFlusher(conn, run_id, ctx["planner_id"])

    def on_event(kind: str, payload: dict) -> None:
        if kind == "token":
            flusher.add(str(payload.get("text") or ""))

    success, output = _run_employee_turn(
        ctx, ctx["planner_id"], prompt, inject_knowledge=False, on_event=on_event)
    flusher.flush()
    if success and output:
        return output
    # 汇总轮失败 — 降级为子任务成果直接拼接, 协作产出不丢失.
    logger.warning("[orch] aggregation turn failed; degraded merge")
    merged = [f"【{subtasks[i]['title']} — {_emp_name(ctx, subtasks[i]['assignee'])}】\n{results[i]['output']}"
              for i in sorted(results) if results[i]["success"]]
    return "\n\n".join(merged)


# ── Turn execution (复用单 agent 路径的 persona/知识/降级口径) ────────────

def _run_employee_turn(ctx: dict, employee_id: str, message: str, *,
                       inject_knowledge: bool = True,
                       on_event=None) -> tuple[bool, str]:
    """以员工自身 profile/persona 执行一轮; WebUI loopback 优先, CLI 降级。"""
    from agent_gateway import webui_runtime_adapter as webui
    from agent_gateway.runtime_executor import (
        RUN_TIMEOUT_SECONDS,
        _invoke_hermes_cli,
        _provision_profile,
        _retrieve_knowledge,
    )

    employee = ctx["employees"][employee_id]
    profile = employee.profile_name or employee.id
    system_prompt = ctx["prompts"].get(employee_id, "") or ""
    _provision_profile(profile, system_prompt)

    parts = []
    if system_prompt.strip():
        parts.append(f"[你的角色设定]\n{system_prompt.strip()}")
    if inject_knowledge:
        knowledge_block, _ = _retrieve_knowledge(ctx["kb_ids"].get(employee_id, []), message)
        if knowledge_block:
            parts.append("[企业知识库检索结果 — 回答时优先引用以下内容]\n" + knowledge_block)
    parts.append(message)
    full_prompt = "\n\n".join(parts)

    try:
        result = webui.run_turn(
            profile=profile, message=full_prompt,
            model=employee.model_name or "", model_provider=employee.model_provider or "",
            on_event=on_event, timeout_seconds=RUN_TIMEOUT_SECONDS,
        )
        return result.success, (result.text if result.success else (result.error or result.text))
    except OSError as exc:
        logger.warning("[orch] webui loopback unavailable (%s); CLI fallback", exc)
        return _invoke_hermes_cli(profile, full_prompt)


# ── Event emission (锁内串行分配游标, 线程安全) ───────────────────────────

def _emit_standalone(run_id: str, event_type: str, *, source_id: str,
                     preview: str, payload: dict, employee_id: str) -> None:
    from agent_gateway.runtime_executor import _connect
    from team_panel.integration.event_ingest_service import ingest_timeline_event
    from team_panel.transactions.uow import UnitOfWork

    with _EVENT_LOCK:
        conn = _connect()
        try:
            with UnitOfWork(conn) as uow:
                run = uow.team_runs().get_by_id(run_id)
                if run is None:
                    return
                binding = uow.runtime_bindings().get_by_owner("team_run", run_id)
                next_cursor = (binding.event_cursor if binding else 0) + 1
                ingest_timeline_event(uow, {
                    "id": f"evt_{run_id}_{next_cursor}",
                    "enterprise_id": run.enterprise_id,
                    "run_id": run_id,
                    "cursor_no": next_cursor,
                    "event_type": event_type,
                    "source_type": "kanban_task",
                    "source_id": source_id,
                    "employee_id": employee_id or None,
                    "event_ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "preview_text": preview,
                    "payload_json": json.dumps(payload or {}, ensure_ascii=False),
                })
        except Exception:  # noqa: BLE001 — 事件写入失败不终止协作执行
            logger.exception("[orch] event emit failed (%s/%s)", event_type, source_id)
        finally:
            conn.close()


# ── Helpers ───────────────────────────────────────────────────────────────

def _emp_name(ctx: dict, employee_id: str) -> str:
    emp = ctx["employees"].get(employee_id)
    return (emp.display_name if emp and emp.display_name else employee_id)


def _load_json(raw) -> dict:
    try:
        data = json.loads(raw or "{}")
        return data if isinstance(data, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}
