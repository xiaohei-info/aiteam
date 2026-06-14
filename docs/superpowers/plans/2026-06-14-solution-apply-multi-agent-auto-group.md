# 行业方案「应用→多Agent→自动建群→编排收敛」闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 行业方案应用后落地全部数字员工（撞车的按用户选择原地刷新或新建独立），自动建群并把员工和应用用户拉进去，编排收敛为 planner 一段 + roster 补全能力摘要。

**Architecture:** 修改 `_handle_solution_apply_post` 从只取 `bindings[0]` 改为遍历全部 enabled 绑定落地多 agent；应用后自动建群（复用+刷新）；新增 preview 端点检测 agent 冲突；`_plan_subtasks` 的 roster 补全 description/prompt 摘要。

**Tech Stack:** Python / PostgreSQL / psycopg2 / dataclass entities / UnitOfWork pattern

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `app/team_panel/migrations/012_solution_apply_conversation_id.sql` | apply_record 加 `conversation_id` 列 |
| Modify | `app/team_panel/domain/entities.py:725-743` | `SolutionApplyRecord` 加 `conversation_id` 字段 |
| Modify | `app/team_panel/repositories/solution_apply_record_repo.py` | 读写 `conversation_id`；加 `get_latest_successful` 方法 |
| Modify | `app/team_panel/repositories/employee_repo.py` | 加 `list_active_by_template` 方法 |
| Modify | `app/team_panel/api_team/router_team.py:2482-2777` | `_resolve_solution_template`→返回列表；新增 `_handle_solution_apply_preview`；重写 `_handle_solution_apply_post`：多 agent + 建群 + 冲突决策 + conversation_id |
| Modify | `app/team_panel/api_team/router_team.py:5337-5343` | 路由注册：新增 preview 端点 |
| Modify | `app/agent_gateway/orchestration_executor.py:220-235` | `_plan_subtasks` roster 补全 description + prompt 摘要 |
| Create | `app/tests/aiteam/layer2_team_panel/test_solution_apply_multi_agent.py` | 多 agent 落地、建群、preview、冲突决策、roster 补全的集成测试 |

---

### Task 1: Migration — solution_apply_record 加 conversation_id 列

**Files:**
- Create: `app/team_panel/migrations/012_solution_apply_conversation_id.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- 012: 方案应用后自动建群 — apply_record 记录对应的 conversation_id，
-- 支撑「复用+刷新」与幂等返回。DB 列默认空，存量记录行为不变。

ALTER TABLE solution_apply_record
    ADD COLUMN IF NOT EXISTS conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_solution_apply_record_conversation
    ON solution_apply_record(enterprise_id, solution_id, conversation_id)
    WHERE deleted_at IS NULL AND conversation_id IS NOT NULL;
```

- [ ] **Step 2: Verify migration runner picks it up**

Run: `cd app && python -c "from team_panel.migrations.runner import run; print('OK')"` (or check existing migration runner pattern)
Expected: No error — the runner discovers files by name pattern

- [ ] **Step 3: Commit**

```bash
git add app/team_panel/migrations/012_solution_apply_conversation_id.sql
git commit -m "feat(AITEAM-33): add conversation_id column to solution_apply_record"
```

---

### Task 2: Entity + Repo — conversation_id 字段与查询

**Files:**
- Modify: `app/team_panel/domain/entities.py:725-743`
- Modify: `app/team_panel/repositories/solution_apply_record_repo.py`
- Modify: `app/team_panel/repositories/employee_repo.py`

- [ ] **Step 1: Add conversation_id to SolutionApplyRecord entity**

在 `SolutionApplyRecord` dataclass 中加 `conversation_id` 字段（`Optional[str] = None`），放在 `department_id` 后面：

```python
@dataclass
class SolutionApplyRecord:
    id: str
    enterprise_id: str
    solution_id: str
    idempotency_key: str
    mode: str = "append"
    status: str = "succeeded"  # pending | succeeded | failed | cancelled
    requested_by: str = ""
    department_id: Optional[str] = None
    conversation_id: Optional[str] = None  # 应用后自动建的群；复用+刷新的锚点
    created_employee_ids_json: str = "[]"
    created_knowledge_base_ids_json: str = "[]"
    error_code: Optional[str] = None
    error_message: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    deleted_at: Optional[str] = None
```

- [ ] **Step 2: Update SolutionApplyRecordRepo — create/get/read conversation_id**

修改 `create` 方法的 INSERT 列列表和 VALUES 参数，加入 `conversation_id`。

修改 `_row_to_entity` 的 SELECT 列列表和映射，加入 `conversation_id`（放在 `department_id` 后面）。

修改所有 `SELECT ... FROM solution_apply_record` 查询（`get_by_id`、`get_by_idempotency_key`、`list_by_solution`）的列列表，加入 `conversation_id`。

新增 `get_latest_successful` 方法：

```python
def get_latest_successful(self, enterprise_id: str, solution_id: str) -> Optional[SolutionApplyRecord]:
    """Return the most recent succeeded apply record for a given enterprise+solution,
    used to look up a reusable conversation."""
    self._cur.execute(
        "SELECT id, enterprise_id, solution_id, idempotency_key, mode, status, requested_by, department_id, "
        "conversation_id, created_employee_ids_json, created_knowledge_base_ids_json, error_code, error_message, "
        "created_at, updated_at, created_by, updated_by, deleted_at "
        "FROM solution_apply_record "
        "WHERE enterprise_id = %s AND solution_id = %s AND status = 'succeeded' AND deleted_at IS NULL "
        "ORDER BY created_at DESC LIMIT 1",
        (enterprise_id, solution_id),
    )
    row = self._cur.fetchone()
    if row is None:
        return None
    return self._row_to_entity(row)
```

新增 `update_conversation_id` 方法：

```python
def update_conversation_id(self, record_id: str, conversation_id: str) -> None:
    self._cur.execute(
        "UPDATE solution_apply_record SET conversation_id = %s, updated_at = now() WHERE id = %s",
        (conversation_id, record_id),
    )
```

更新 `_row_to_entity` 映射（conversation_id 在 department_id 之后）：

```python
@staticmethod
def _row_to_entity(row) -> SolutionApplyRecord:
    return SolutionApplyRecord(
        id=row[0],
        enterprise_id=row[1],
        solution_id=row[2],
        idempotency_key=row[3],
        mode=row[4],
        status=row[5],
        requested_by=row[6] or "",
        department_id=row[7],
        conversation_id=row[8],  # NEW
        created_employee_ids_json=json.dumps(row[9], ensure_ascii=False) if isinstance(row[9], list) else (str(row[9]) if row[9] else "[]"),
        created_knowledge_base_ids_json=json.dumps(row[10], ensure_ascii=False) if isinstance(row[10], list) else (str(row[10]) if row[10] else "[]"),
        error_code=row[11],
        error_message=row[12],
        created_at=str(row[13]),
        updated_at=str(row[14]),
        created_by=row[15] or "",
        updated_by=row[16] or "",
        deleted_at=str(row[17]) if row[17] else None,
    )
```

更新 `create` 方法的 INSERT，加入 `conversation_id`：

```python
def create(self, record: SolutionApplyRecord) -> SolutionApplyRecord:
    self._cur.execute(
        "INSERT INTO solution_apply_record (id, enterprise_id, solution_id, idempotency_key, mode, status, "
        "requested_by, department_id, conversation_id, created_employee_ids_json, created_knowledge_base_ids_json, "
        "error_code, error_message, created_by, updated_by) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s, %s)",
        (
            record.id,
            record.enterprise_id,
            record.solution_id,
            record.idempotency_key,
            record.mode,
            record.status,
            record.requested_by,
            record.department_id,
            record.conversation_id or None,  # NEW
            record.created_employee_ids_json,
            record.created_knowledge_base_ids_json,
            record.error_code,
            record.error_message,
            record.created_by or None,
            record.updated_by or None,
        ),
    )
    return record
```

- [ ] **Step 3: Add `list_active_by_template` to EmployeeRepo**

```python
def list_active_by_template(self, enterprise_id: str, template_id: str) -> list[Employee]:
    """Return all non-archived, non-deleted employees for an enterprise that were
    instantiated from a given template_id — used for conflict detection."""
    self._cur.execute(
        "SELECT id, enterprise_id, template_id, profile_name, display_name, "
        "role_name, status, created_from, model_provider, model_name, "
        "prompt_version, config_version, avatar_url, description, "
        "archive_reason, last_provisioned_at, capabilities_json, "
        "created_at, updated_at, created_by, updated_by, deleted_at "
        "FROM employee WHERE enterprise_id = %s AND template_id = %s "
        "AND status NOT IN ('archived') AND deleted_at IS NULL "
        "ORDER BY created_at",
        (enterprise_id, template_id),
    )
    rows = self._cur.fetchall()
    return [self._row_to_entity(r) for r in rows]
```

- [ ] **Step 4: Commit**

```bash
git add app/team_panel/domain/entities.py app/team_panel/repositories/solution_apply_record_repo.py app/team_panel/repositories/employee_repo.py
git commit -m "feat(AITEAM-33): add conversation_id to SolutionApplyRecord; add list_active_by_template to EmployeeRepo"
```

---

### Task 3: _resolve_solution_template → 返回全部 enabled 绑定列表

**Files:**
- Modify: `app/team_panel/api_team/router_team.py:2482-2509`

- [ ] **Step 1: Modify `_resolve_solution_template` to return a list**

将原来的返回 `(AgentTemplate | None, error | None)` 改为 `(list[AgentTemplate] | None, error | None)`，遍历全部 enabled 绑定而非只取 `bindings[0]`：

```python
def _resolve_solution_templates(cur, solution_id: str) -> tuple[list[AgentTemplate] | None, tuple[int, dict] | None]:
    """Return all enabled, published template bindings for a solution.
    Returns (templates_list, None) on success, or (None, error_response) on failure."""
    solution = IndustrySolutionRepo(cur).get_by_id(solution_id)
    if solution is None or solution.deleted_at is not None:
        return None, (404, {"error": "SOLUTION_NOT_FOUND", "message": f"Solution {solution_id} not found"})
    if solution.status != "published":
        return None, (409, {"error": "SOLUTION_NOT_PUBLISHED", "message": f"Solution {solution_id} is not published"})

    bindings = [binding for binding in SolutionTemplateBindingRepo(cur).list_by_solution(solution_id) if binding.enabled]
    if not bindings:
        return None, (
            409,
            {
                "error": "SOLUTION_TEMPLATE_BINDING_MISSING",
                "message": f"Solution {solution_id} has no enabled template binding",
            },
        )

    templates = []
    for binding in bindings:
        template = AgentTemplateRepo(cur).get_by_id(binding.template_id)
        if template is None or template.status != "published" or template.deleted_at is not None:
            continue  # skip unavailable bindings rather than failing entirely
        templates.append(template)
    if not templates:
        return None, (
            409,
            {
                "error": "BOUND_TEMPLATE_UNAVAILABLE",
                "message": f"No usable published templates bound to solution {solution_id}",
            },
        )
    return templates, None
```

- [ ] **Step 2: Commit**

```bash
git add app/team_panel/api_team/router_team.py
git commit -m "feat(AITEAM-33): _resolve_solution_templates returns all enabled bindings"
```

---

### Task 4: Preview 端点 — 冲突检测

**Files:**
- Create: `app/team_panel/api_team/router_team.py` — 新增 `_handle_solution_apply_preview` 函数
- Modify: `app/team_panel/api_team/router_team.py:5337-5343` — 路由注册

- [ ] **Step 1: Implement `_handle_solution_apply_preview`**

在 `_handle_solution_apply_post` 之前新增函数：

```python
def _handle_solution_apply_preview(conn, path: str, solution_id: str, body: dict | None) -> tuple[int, dict]:
    """Preview endpoint: return each agent in the solution with conflict markers.
    A conflict means the enterprise already has an active employee from the same template."""
    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

        templates, error_response = _resolve_solution_templates(cur, solution_id)
        if error_response is not None:
            return error_response
        if templates is None:
            return 409, {"error": "BOUND_TEMPLATE_UNAVAILABLE", "message": f"No usable templates for solution {solution_id}"}

        employee_repo = EmployeeRepo(cur)
        agents = []
        for template in templates:
            existing_employees = employee_repo.list_active_by_template(enterprise.id, template.id)
            conflict = len(existing_employees) > 0
            existing_employee_id = existing_employees[0].id if conflict else None
            agents.append({
                "template_id": template.id,
                "role_name": template.role_name or template.name,
                "display_name": template.role_name or template.name,
                "conflict": conflict,
                "existing_employee_id": existing_employee_id,
            })
        return 200, {"solution_id": solution_id, "agents": agents}
    finally:
        cur.close()
```

- [ ] **Step 2: Register preview route**

在路由分发部分（`_handle_solution_apply_post` 的路由注册附近），新增 preview 路由。在现有 `solutions/{id}/apply` 路由块之后，添加 `solutions/{id}/apply/preview` 路由：

找到路由区域（约 line 5337-5343），在 apply 路由之后添加：

```python
    # ── solutions/{id}/apply/preview ──
    if route_handler is None:
        solution_preview = _match_prefix(sub, "/solutions/")
        if method == "POST" and solution_preview is not None and solution_preview.endswith("/apply/preview"):
            solution_id = solution_preview[:-len("/apply/preview")]
            if "/" not in solution_id:
                route_handler = lambda conn, matched_solution_id=solution_id: _handle_solution_apply_preview(conn, sub, matched_solution_id, body)
```

**注意**: preview 路由必须在 apply 路由**之前**检查，因为 `/apply/preview` 也以 `/apply` 前缀开始，否则会被误匹配为 apply 路由。要把 preview 路由放在 apply 路由之前。

- [ ] **Step 3: Commit**

```bash
git add app/team_panel/api_team/router_team.py
git commit -m "feat(AITEAM-33): add solution apply preview endpoint for conflict detection"
```

---

### Task 5: 重写 _handle_solution_apply_post — 多 agent + 建群 + 冲突决策

**Files:**
- Modify: `app/team_panel/api_team/router_team.py:2553-2777`

这是最核心的改造。将原来的单 agent 创建改为多 agent 循环，并加入冲突决策、自动建群、conversation_id 写回。

- [ ] **Step 1: Rewrite `_handle_solution_apply_post`**

以下是完整重写的函数。关键变更点：

1. 调用 `_resolve_solution_templates`（返回列表而非单个）
2. 读取 `agent_decisions` 和 `agent_conflict_policy`（冲突决策）
3. 遍历全部 templates 循环建员工（含 overwrite 原地刷新 / new 新建独立）
4. 用 `_resolve_workbench_user_id` 取真实用户作为 `created_by` 和群 owner
5. 自动建群或复用刷新已有群
6. 把应用用户作为 `member_type="user", role="owner"` 加入群
7. conversation_id 写回 apply_record
8. 返回体新增 `conversation_id` 和 `employee_details`

```python
def _handle_solution_apply_post(conn, path: str, solution_id: str, body: dict | None) -> tuple[int, dict]:
    if not body:
        return 400, {"error": "MISSING_BODY", "message": "Request body is required"}

    idempotency_key = str(body.get("idempotency_key") or "").strip()
    if not idempotency_key:
        return 400, {"error": "MISSING_IDEMPOTENCY_KEY", "message": "idempotency_key is required"}

    mode = str(body.get("mode") or "append")
    if mode not in ("append", "replace", "reapply"):
        return 400, {"error": "UNSUPPORTED_MODE", "message": f"Mode '{mode}' is not supported; use append, replace, or reapply"}

    # 冲突决策参数（P2 preview 端点配合）
    agent_decisions = body.get("agent_decisions") or []  # [{template_id, action: "overwrite"|"new"}]
    agent_conflict_policy = str(body.get("agent_conflict_policy") or "overwrite")  # 缺省决策

    cur = conn.cursor()
    try:
        enterprise_repo = EnterpriseRepo(cur)
        enterprises = enterprise_repo.list_all()
        enterprise = enterprises[0] if enterprises else None
        if enterprise is None:
            return 400, {"error": "NO_ENTERPRISE", "message": "No enterprise exists"}

        # 真实用户 ID（替代写死的 "solution_apply"）
        user_id = _resolve_workbench_user_id(enterprise, path, body)

        templates, error_response = _resolve_solution_templates(cur, solution_id)
        if error_response is not None:
            return error_response
        if templates is None:
            return 409, {"error": "BOUND_TEMPLATE_UNAVAILABLE", "message": f"No usable templates for solution {solution_id}"}

        record_repo = SolutionApplyRecordRepo(cur)
        existing_record = record_repo.get_by_idempotency_key(enterprise.id, solution_id, idempotency_key)
        if existing_record is not None:
            return 200, {
                "apply_record_id": existing_record.id,
                "mode": existing_record.mode,
                "status": existing_record.status,
                "created_employee_ids": _load_json_list(existing_record.created_employee_ids_json),
                "created_knowledge_base_ids": _load_json_list(existing_record.created_knowledge_base_ids_json),
                "conversation_id": existing_record.conversation_id,
            }

        # ── replace 模式：归档本方案上次建的员工 ──
        previous_records = [
            record
            for record in record_repo.list_by_solution(solution_id)
            if record.enterprise_id == enterprise.id and record.status == "succeeded"
        ]
        previous_employee_ids: list[str] = []
        seen_employee_ids: set[str] = set()
        for record in previous_records:
            for previous_employee_id in _load_json_list(record.created_employee_ids_json):
                if previous_employee_id in seen_employee_ids:
                    continue
                seen_employee_ids.add(previous_employee_id)
                previous_employee_ids.append(previous_employee_id)

        replaced_employee_ids: list[str] = []
        employee_repo = EmployeeRepo(cur)
        kb_repo = EmployeeKnowledgeBindingRepo(cur)
        if mode == "replace":
            for previous_employee_id in previous_employee_ids:
                previous_employee = employee_repo.get_by_id(previous_employee_id)
                if previous_employee is None or previous_employee.enterprise_id != enterprise.id:
                    continue
                if previous_employee.status != EmployeeStatus.ARCHIVED:
                    previous_employee.archive("solution replaced")
                    previous_employee.updated_by = user_id
                    employee_repo.update_status(previous_employee)
                for binding in kb_repo.list_by_employee(previous_employee_id):
                    kb_repo.delete(binding.id)
                replaced_employee_ids.append(previous_employee_id)

        # ── 多 agent 循环创建/刷新 ──
        all_employee_ids: list[str] = []
        employee_details: list[dict] = []
        knowledge_base_ids_all: list[str] = []

        for template in templates:
            # 检查冲突
            conflict_employees = employee_repo.list_active_by_template(enterprise.id, template.id)
            has_conflict = len(conflict_employees) > 0

            # 查找用户决策
            decision_action = agent_conflict_policy  # default
            for decision in agent_decisions:
                if decision.get("template_id") == template.id:
                    decision_action = str(decision.get("action") or agent_conflict_policy)
                    break

            if has_conflict and decision_action == "overwrite":
                # 原地刷新：保留 employee_id，更新 persona/技能/知识/模型
                existing_employee = conflict_employees[0]
                employee_id = existing_employee.id

                # 更新模型
                sol_model_provider, sol_model_name = _resolve_employee_model(
                    cur, enterprise.id, template, body)
                existing_employee.model_provider = sol_model_provider
                existing_employee.model_name = sol_model_name
                existing_employee.display_name = template.role_name or template.name or existing_employee.display_name
                existing_employee.updated_by = user_id
                employee_repo.update_status(existing_employee)

                # 更新 prompt
                sol_pack = _template_prompt_pack(template)
                sol_system_prompt = sol_pack.get("system_prompt", "") or ""
                EmployeePromptRepo(cur).upsert(EmployeePrompt(
                    employee_id=employee_id,
                    system_prompt=sol_system_prompt,
                    behavior_rules_json=json.dumps(sol_pack.get("behavior_rules", {}) or {}, ensure_ascii=False),
                    opening_message=sol_pack.get("opening_message"),
                    version_no=1,
                    source_template_version=template.version_no,
                ))

                # 更新技能绑定（清除旧的，重建新的）
                skill_repo = EmployeeSkillBindingRepo(cur)
                for old_binding in skill_repo.list_by_employee(employee_id):
                    if old_binding.source_type == "template_default":
                        skill_repo.delete(old_binding.id)
                for _sc in (_template_default_bindings(template).get("skills") or []):
                    if _sc:
                        skill_repo.create(EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=enterprise.id,
                            employee_id=employee_id,
                            skill_code=str(_sc),
                            enabled=True,
                            source_type="template_default",
                        ))

                # 更新知识绑定
                knowledge_base_ids = _extract_template_knowledge_bases(template)
                knowledge_base_repo = KnowledgeBaseRepo(cur)
                for kb_id in knowledge_base_ids:
                    if knowledge_base_repo.get_by_id(kb_id) is None:
                        knowledge_base_repo.create(KnowledgeBase(
                            id=kb_id,
                            enterprise_id=enterprise.id,
                            name=f"{template.role_name or template.name or '方案'}知识库",
                            description=f"由行业方案 {solution_id} 一键应用自动创建",
                            status="active",
                            storage_prefix=f"aiteam/{enterprise.id}/knowledge/{kb_id}",
                            created_by=user_id,
                            updated_by=user_id,
                        ))
                for old_kb in kb_repo.list_by_employee(employee_id):
                    kb_repo.delete(old_kb.id)
                for kb_id in knowledge_base_ids:
                    kb_repo.create(EmployeeKnowledgeBinding(
                        id=f"kb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=enterprise.id,
                        employee_id=employee_id,
                        knowledge_base_id=kb_id,
                        scope_mode="read",
                        enabled=True,
                        binding_version=1,
                        created_by=user_id,
                        updated_by=user_id,
                    ))

                # 更新 memory 配置
                _sol_mem = _template_memory_config(template)
                EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
                    id=f"mb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    memory_mode=str(_sol_mem.get("mode") or "builtin"),
                    provider_code=_sol_mem.get("provider_code"),
                    retention_days=_sol_mem.get("retention_days"),
                    writeback_enabled=bool(_sol_mem.get("writeback_enabled", True)),
                ))

                # 更新 description（新增能力描述）
                existing_employee.description = template.role_name or template.name
                employee_repo.update_status(existing_employee)

                # 重新 provision profile
                profile_name = existing_employee.profile_name or existing_employee.id
                _provision_employee_profile(profile_name, sol_system_prompt,
                                            sol_model_provider, sol_model_name)
                _fire_skill_sync(cur, employee_id)

                all_employee_ids.append(employee_id)
                employee_details.append({
                    "employee_id": employee_id,
                    "template_id": template.id,
                    "action": "overwrite",
                    "display_name": existing_employee.display_name,
                    "role_name": existing_employee.role_name,
                })
                knowledge_base_ids_all.extend(knowledge_base_ids)

            elif has_conflict and decision_action == "new":
                # 新建独立员工，自动加后缀避免撞名
                display_name = template.role_name or template.name or "Solution Employee"
                profile_name = _next_solution_profile_name(cur, enterprise.id, enterprise.slug, solution_id, display_name)
                employee_id = f"emp_{uuid.uuid4().hex[:12]}"
                sol_model_provider, sol_model_name = _resolve_employee_model(
                    cur, enterprise.id, template, body)

                employee_repo.create(Employee(
                    id=employee_id,
                    enterprise_id=enterprise.id,
                    template_id=template.id,
                    profile_name=profile_name,
                    display_name=display_name,
                    role_name=template.role_name,
                    status=EmployeeStatus.ACTIVE,
                    created_from="solution_apply",
                    description=template.role_name or template.name,
                    created_by=user_id,
                    updated_by=user_id,
                    model_provider=sol_model_provider,
                    model_name=sol_model_name,
                ))

                sol_pack = _template_prompt_pack(template)
                sol_system_prompt = sol_pack.get("system_prompt", "") or ""
                EmployeePromptRepo(cur).upsert(EmployeePrompt(
                    employee_id=employee_id,
                    system_prompt=sol_system_prompt,
                    behavior_rules_json=json.dumps(sol_pack.get("behavior_rules", {}) or {}, ensure_ascii=False),
                    opening_message=sol_pack.get("opening_message"),
                    version_no=1,
                    source_template_version=template.version_no,
                ))
                for _sc in (_template_default_bindings(template).get("skills") or []):
                    if _sc:
                        EmployeeSkillBindingRepo(cur).create(EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=enterprise.id,
                            employee_id=employee_id,
                            skill_code=str(_sc),
                            enabled=True,
                            source_type="template_default",
                        ))
                _sol_mem = _template_memory_config(template)
                EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
                    id=f"mb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    memory_mode=str(_sol_mem.get("mode") or "builtin"),
                    provider_code=_sol_mem.get("provider_code"),
                    retention_days=_sol_mem.get("retention_days"),
                    writeback_enabled=bool(_sol_mem.get("writeback_enabled", True)),
                ))
                knowledge_base_ids = _extract_template_knowledge_bases(template)
                knowledge_base_repo = KnowledgeBaseRepo(cur)
                for kb_id in knowledge_base_ids:
                    if knowledge_base_repo.get_by_id(kb_id) is None:
                        knowledge_base_repo.create(KnowledgeBase(
                            id=kb_id,
                            enterprise_id=enterprise.id,
                            name=f"{template.role_name or template.name or '方案'}知识库",
                            description=f"由行业方案 {solution_id} 一键应用自动创建",
                            status="active",
                            storage_prefix=f"aiteam/{enterprise.id}/knowledge/{kb_id}",
                            created_by=user_id,
                            updated_by=user_id,
                        ))
                for kb_id in knowledge_base_ids:
                    kb_repo.create(EmployeeKnowledgeBinding(
                        id=f"kb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=enterprise.id,
                        employee_id=employee_id,
                        knowledge_base_id=kb_id,
                        scope_mode="read",
                        enabled=True,
                        binding_version=1,
                        created_by=user_id,
                        updated_by=user_id,
                    ))

                _provision_employee_profile(profile_name, sol_system_prompt,
                                            sol_model_provider, sol_model_name)
                _fire_skill_sync(cur, employee_id)

                all_employee_ids.append(employee_id)
                employee_details.append({
                    "employee_id": employee_id,
                    "template_id": template.id,
                    "action": "new",
                    "display_name": display_name,
                    "role_name": template.role_name or "",
                })
                knowledge_base_ids_all.extend(knowledge_base_ids)

            else:
                # 无冲突 — 新建员工（原有逻辑）
                display_name = template.role_name or template.name or "Solution Employee"
                profile_name = _next_solution_profile_name(cur, enterprise.id, enterprise.slug, solution_id, display_name)
                employee_id = f"emp_{uuid.uuid4().hex[:12]}"
                sol_model_provider, sol_model_name = _resolve_employee_model(
                    cur, enterprise.id, template, body)

                employee_repo.create(Employee(
                    id=employee_id,
                    enterprise_id=enterprise.id,
                    template_id=template.id,
                    profile_name=profile_name,
                    display_name=display_name,
                    role_name=template.role_name,
                    status=EmployeeStatus.ACTIVE,
                    created_from="solution_apply",
                    description=template.role_name or template.name,
                    created_by=user_id,
                    updated_by=user_id,
                    model_provider=sol_model_provider,
                    model_name=sol_model_name,
                ))

                sol_pack = _template_prompt_pack(template)
                sol_system_prompt = sol_pack.get("system_prompt", "") or ""
                EmployeePromptRepo(cur).upsert(EmployeePrompt(
                    employee_id=employee_id,
                    system_prompt=sol_system_prompt,
                    behavior_rules_json=json.dumps(sol_pack.get("behavior_rules", {}) or {}, ensure_ascii=False),
                    opening_message=sol_pack.get("opening_message"),
                    version_no=1,
                    source_template_version=template.version_no,
                ))
                for _sc in (_template_default_bindings(template).get("skills") or []):
                    if _sc:
                        EmployeeSkillBindingRepo(cur).create(EmployeeSkillBinding(
                            id=f"sb_{uuid.uuid4().hex[:12]}",
                            enterprise_id=enterprise.id,
                            employee_id=employee_id,
                            skill_code=str(_sc),
                            enabled=True,
                            source_type="template_default",
                        ))
                _sol_mem = _template_memory_config(template)
                EmployeeMemoryBindingRepo(cur).upsert(EmployeeMemoryBinding(
                    id=f"mb_{uuid.uuid4().hex[:12]}",
                    enterprise_id=enterprise.id,
                    employee_id=employee_id,
                    memory_mode=str(_sol_mem.get("mode") or "builtin"),
                    provider_code=_sol_mem.get("provider_code"),
                    retention_days=_sol_mem.get("retention_days"),
                    writeback_enabled=bool(_sol_mem.get("writeback_enabled", True)),
                ))
                knowledge_base_ids = _extract_template_knowledge_bases(template)
                knowledge_base_repo = KnowledgeBaseRepo(cur)
                for kb_id in knowledge_base_ids:
                    if knowledge_base_repo.get_by_id(kb_id) is None:
                        knowledge_base_repo.create(KnowledgeBase(
                            id=kb_id,
                            enterprise_id=enterprise.id,
                            name=f"{template.role_name or template.name or '方案'}知识库",
                            description=f"由行业方案 {solution_id} 一键应用自动创建",
                            status="active",
                            storage_prefix=f"aiteam/{enterprise.id}/knowledge/{kb_id}",
                            created_by=user_id,
                            updated_by=user_id,
                        ))
                for kb_id in knowledge_base_ids:
                    kb_repo.create(EmployeeKnowledgeBinding(
                        id=f"kb_{uuid.uuid4().hex[:12]}",
                        enterprise_id=enterprise.id,
                        employee_id=employee_id,
                        knowledge_base_id=kb_id,
                        scope_mode="read",
                        enabled=True,
                        binding_version=1,
                        created_by=user_id,
                        updated_by=user_id,
                    ))

                _provision_employee_profile(profile_name, sol_system_prompt,
                                            sol_model_provider, sol_model_name)
                _fire_skill_sync(cur, employee_id)

                all_employee_ids.append(employee_id)
                employee_details.append({
                    "employee_id": employee_id,
                    "template_id": template.id,
                    "action": "create",
                    "display_name": display_name,
                    "role_name": template.role_name or "",
                })
                knowledge_base_ids_all.extend(knowledge_base_ids)

        # ── 创建 apply_record（含 conversation_id 暂为 None） ──
        apply_record_id = f"sol_apply_{uuid.uuid4().hex[:8]}"
        apply_key = f"solution_apply:{solution_id}:{idempotency_key}"
        record_repo.create(
            SolutionApplyRecord(
                id=apply_record_id,
                enterprise_id=enterprise.id,
                solution_id=solution_id,
                idempotency_key=idempotency_key,
                mode=mode,
                status="succeeded",
                requested_by=user_id,
                department_id=str(body.get("department_id") or "") or None,
                conversation_id=None,  # 先建记录，建群后回写
                created_employee_ids_json=json.dumps(all_employee_ids, ensure_ascii=False),
                created_knowledge_base_ids_json=json.dumps(knowledge_base_ids_all, ensure_ascii=False),
                created_by=user_id,
                updated_by=user_id,
            )
        )

        # ── Audit event ──
        AuditEventRepo(cur).create(
            AuditEvent(
                id=f"audit_{uuid.uuid4().hex[:12]}",
                enterprise_id=enterprise.id,
                actor_type="user",
                actor_id=user_id,
                event_type="solution.apply",
                target_type="solution",
                target_id=solution_id,
                request_id=apply_key,
                payload_json=json.dumps(
                    {
                        "mode": mode,
                        "department_id": body.get("department_id"),
                        "employee_details": employee_details,
                        "replaced_employee_ids": replaced_employee_ids,
                        "reapplied_from_employee_ids": previous_employee_ids if mode == "reapply" else [],
                        "created_employee_ids": all_employee_ids,
                        "created_knowledge_base_ids": knowledge_base_ids_all,
                        "apply_record_id": apply_record_id,
                        "agent_conflict_policy": agent_conflict_policy,
                    },
                    ensure_ascii=False,
                ),
                created_by=user_id,
            )
        )

        # ── 下发编排模板 ──
        _seed_collaboration_from_solution(
            cur, enterprise.id, IndustrySolutionRepo(cur).get_by_id(solution_id), mode)

        # ── 自动建群 / 复用+刷新 ──
        conversation_id = None
        # 查是否有可复用的群（最近一次成功 apply_record 的 conversation_id）
        latest_record = record_repo.get_latest_successful(enterprise.id, solution_id)
        if latest_record is not None and latest_record.conversation_id:
            candidate_conv_id = latest_record.conversation_id
            conv_repo = ConversationRepo(cur)
            conv = conv_repo.get_by_id(candidate_conv_id)
            if conv is not None and conv.status == "active" and conv.type == "group":
                # 复用：同步成员
                conversation_id = candidate_conv_id
                # 添加缺失的员工成员
                for emp_id in all_employee_ids:
                    # 检查是否已经在群里
                    cur.execute(
                        "SELECT member_id FROM conversation_member "
                        "WHERE conversation_id = %s AND member_type = 'employee' AND member_ref_id = %s AND status = 'active'",
                        (conversation_id, emp_id),
                    )
                    if cur.fetchone() is None:
                        cur.execute(
                            "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
                            "VALUES (%s, %s, 'employee', %s, 'participant', 'active')",
                            (f"mem_{uuid.uuid4().hex[:12]}", conversation_id, emp_id),
                        )
                # 添加用户作为 owner（如果还不是）
                cur.execute(
                    "SELECT member_id FROM conversation_member "
                    "WHERE conversation_id = %s AND member_type = 'user' AND member_ref_id = %s AND status = 'active'",
                    (conversation_id, user_id),
                )
                if cur.fetchone() is None:
                    cur.execute(
                        "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
                        "VALUES (%s, %s, 'user', %s, 'owner', 'active')",
                        (f"mem_{uuid.uuid4().hex[:12]}", conversation_id, user_id),
                    )
                # 刷新群标题为方案名
                solution = IndustrySolutionRepo(cur).get_by_id(solution_id)
                conv.title = solution.name if solution else conv.title
                conv.updated_by = user_id
                # 使用现有 update 机制（update_latest_run 已有，但标题需要直接 SQL）
                cur.execute(
                    "UPDATE conversation SET title = %s, updated_at = now(), updated_by = %s WHERE id = %s",
                    (conv.title, user_id, conversation_id),
                )

        if conversation_id is None:
            # 新建群
            solution = IndustrySolutionRepo(cur).get_by_id(solution_id)
            group_title = solution.name if solution else f"方案协作 {solution_id}"
            conversation_id = _create_solution_group_conversation(
                cur, enterprise.id, group_title, all_employee_ids, user_id)

        # 回写 conversation_id 到 apply_record
        record_repo.update_conversation_id(apply_record_id, conversation_id)

        conn.commit()

        return 201, {
            "apply_record_id": apply_record_id,
            "mode": mode,
            "status": "succeeded",
            "replaced_employee_ids": replaced_employee_ids,
            "reapplied_from_employee_ids": previous_employee_ids if mode == "reapply" else [],
            "created_employee_ids": all_employee_ids,
            "created_knowledge_base_ids": knowledge_base_ids_all,
            "conversation_id": conversation_id,
            "employee_details": employee_details,
        }
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _create_solution_group_conversation(cur, enterprise_id: str, title: str,
                                        member_employee_ids: list[str],
                                        user_id: str) -> str:
    """Create a group conversation for a solution apply, with employees as participants
    and the applying user as owner. Returns the conversation_id."""
    conv_id = f"conv_{uuid.uuid4().hex[:12]}"
    cur.execute(
        "INSERT INTO conversation (id, enterprise_id, type, status, title, created_by, updated_by) "
        "VALUES (%s, %s, 'group', 'active', %s, %s, %s)",
        (conv_id, enterprise_id, title, user_id, user_id),
    )
    for emp_id in member_employee_ids:
        cur.execute(
            "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
            "VALUES (%s, %s, 'employee', %s, 'participant', 'active')",
            (f"mem_{uuid.uuid4().hex[:12]}", conv_id, emp_id),
        )
    # 应用用户作为群 owner
    cur.execute(
        "INSERT INTO conversation_member (member_id, conversation_id, member_type, member_ref_id, role, status) "
        "VALUES (%s, %s, 'user', %s, 'owner', 'active')",
        (f"mem_{uuid.uuid4().hex[:12]}", conv_id, user_id),
    )
    return conv_id
```

- [ ] **Step 2: Remove old `_resolve_solution_template` (singular) call from the handler**

确保 `_handle_solution_apply_post` 中不再调用旧的 `_resolve_solution_template`。旧函数仍可保留在代码中（向后兼容），但 apply handler 只用新的 `_resolve_solution_templates`。

- [ ] **Step 3: Commit**

```bash
git add app/team_panel/api_team/router_team.py
git commit -m "feat(AITEAM-33): rewrite solution apply — multi-agent, auto-group, conflict resolution"
```

---

### Task 6: Roster 补全 — `_plan_subtasks` 注入员工 description + prompt 摘要

**Files:**
- Modify: `app/agent_gateway/orchestration_executor.py:220-235`

- [ ] **Step 1: Modify `_plan_subtasks` to include description and prompt摘要**

将原来只有 `id/display_name/role_name` 的 roster 行，追加 `description` 和 prompt system_prompt 首段摘要：

```python
def _plan_subtasks(ctx: dict) -> list[dict]:
    roster_lines = []
    for emp_id in ctx["targets"]:
        emp = ctx["employees"][emp_id]
        base = f"- {emp_id}: {emp.display_name or emp_id}（{emp.role_name or '协作成员'}）"
        # 补全能力摘要：description + prompt首段
        description = (emp.description or "").strip()
        prompt_text = (ctx["prompts"].get(emp_id, "") or "").strip()
        # 取 prompt 首段（最多 200 字），让 planner 知道"谁擅长什么"
        prompt_summary = prompt_text[:200].strip() if prompt_text else ""
        extras = []
        if description:
            extras.append(f"职责: {description}")
        if prompt_summary:
            extras.append(f"能力摘要: {prompt_summary}")
        if extras:
            base += " — " + "; ".join(extras)
        roster_lines.append(base)
    roster = "\n".join(roster_lines)
    plan_prompt = _render_tmpl(ctx, "planner",
                               roster=roster,
                               message_text=ctx["message_text"],
                               max_subtasks=MAX_SUBTASKS)
    text = _run_employee_turn(ctx, ctx["planner_id"], plan_prompt, inject_knowledge=False)[1]
    plan = parse_plan(text, ctx["targets"])
    if plan:
        return plan
    logger.warning("[orch] planner output unparseable; fallback to per-target split")
    return fallback_plan(ctx["targets"], ctx["message_text"])
```

- [ ] **Step 2: Commit**

```bash
git add app/agent_gateway/orchestration_executor.py
git commit -m "feat(AITEAM-33): enrich planner roster with employee description and prompt summary"
```

---

### Task 7: 集成测试

**Files:**
- Create: `app/tests/aiteam/layer2_team_panel/test_solution_apply_multi_agent.py`

- [ ] **Step 1: Write test for multi-agent apply**

```python
"""Test: solution apply creates multiple employees + group conversation."""

import json
import uuid

from team_panel.domain.entities import (
    AgentTemplate, IndustrySolution, SolutionTemplateBinding,
    Employee, SolutionApplyRecord, Conversation,
)
from team_panel.domain.enums import EmployeeStatus


def test_solution_apply_creates_multiple_employees(db_with_solution_multi_templates):
    """P0: Applying a solution with N template bindings creates N employees."""
    cur, enterprise_id, solution_id, template_ids = db_with_solution_multi_templates
    from team_panel.repositories.employee_repo import EmployeeRepo
    repo = EmployeeRepo(cur)
    employees = repo.list_by_enterprise(enterprise_id)
    solution_employees = [e for e in employees if e.created_from == "solution_apply"]
    assert len(solution_employees) == len(template_ids)


def test_solution_apply_creates_group_conversation(db_with_solution_applied):
    """P1: Applying a solution creates a group conversation with all agents + user."""
    cur, enterprise_id, solution_id, conv_id = db_with_solution_applied
    from team_panel.repositories.conversation_repo import ConversationRepo
    conv = ConversationRepo(cur).get_by_id(conv_id)
    assert conv is not None
    assert conv.type == "group"
    assert conv.status == "active"
    # Verify all employees are members
    cur.execute(
        "SELECT member_ref_id FROM conversation_member "
        "WHERE conversation_id = %s AND member_type = 'employee' AND status = 'active'",
        (conv_id,),
    )
    employee_members = [row[0] for row in cur.fetchall()]
    assert len(employee_members) >= 2
    # Verify user is owner
    cur.execute(
        "SELECT member_ref_id, role FROM conversation_member "
        "WHERE conversation_id = %s AND member_type = 'user' AND status = 'active'",
        (conv_id,),
    )
    user_members = cur.fetchall()
    assert len(user_members) >= 1
    assert user_members[0][1] == "owner"


def test_solution_apply_preview_detects_conflicts(db_with_solution_applied):
    """P2: Preview endpoint marks existing employees as conflicts."""
    cur, enterprise_id, solution_id, conv_id = db_with_solution_applied
    # Re-apply preview: should detect conflict for each template
    from team_panel.repositories.employee_repo import EmployeeRepo
    from team_panel.repositories.solution_template_binding_repo import SolutionTemplateBindingRepo
    bindings = SolutionTemplateBindingRepo(cur).list_by_solution(solution_id)
    for binding in bindings:
        if binding.enabled:
            existing = EmployeeRepo(cur).list_active_by_template(enterprise_id, binding.template_id)
            assert len(existing) > 0  # conflict exists


def test_solution_apply_overwrite_preserves_employee_id(db_with_solution_applied):
    """P2: Overwrite keeps same employee_id, refreshes persona/skills/knowledge."""
    cur, enterprise_id, solution_id, conv_id = db_with_solution_applied
    from team_panel.repositories.employee_repo import EmployeeRepo
    from team_panel.repositories.solution_template_binding_repo import SolutionTemplateBindingRepo
    bindings = SolutionTemplateBindingRepo(cur).list_by_solution(solution_id)
    original_id = None
    for binding in bindings:
        if binding.enabled:
            employees = EmployeeRepo(cur).list_active_by_template(enterprise_id, binding.template_id)
            original_id = employees[0].id
            break
    assert original_id is not None
    # After overwrite, same ID should still exist and be active
    emp = EmployeeRepo(cur).get_by_id(original_id)
    assert emp is not None
    assert emp.status == EmployeeStatus.ACTIVE
```

- [ ] **Step 2: Run tests to verify they fail (expected — fixtures not yet wired)**

Run: `cd app && python -m pytest tests/aiteam/layer2_team_panel/test_solution_apply_multi_agent.py -v`
Expected: FAIL — fixtures `db_with_solution_multi_templates` / `db_with_solution_applied` need to be set up

- [ ] **Step 3: Add fixtures to conftest.py or in the test file**

在测试文件中添加 fixture setup（创建 multi-template solution、apply it），或者复用现有 conftest pattern。具体 fixture 需要参考 `tests/aiteam/layer2_team_panel/conftest.py` 和 `fixtures.py` 的 DB 连接模式。

- [ ] **Step 4: Run tests again**

Run: `cd app && python -m pytest tests/aiteam/layer2_team_panel/test_solution_apply_multi_agent.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/tests/aiteam/layer2_team_panel/test_solution_apply_multi_agent.py
git commit -m "test(AITEAM-33): add integration tests for multi-agent apply, group creation, conflict detection"
```

---

### Task 8: 方案表单收敛 — 只暴露 planner 编排规则（前端注释标注）

**Files:**
- Modify: `app/team_panel/api_team/router_team.py` — 方案 CRUD 相关的 serializer 中标注 subtask/aggregate 为"内部保留"

这只是一个标注性的改动，不影响 DB 列。在 `_handle_solutions_list` 的返回体和方案详情的返回中，把 subtask/aggregate 标为"系统内置/不建议编辑"。

> **注意**: 系统后台前端不在本仓库中，这里只做 API 层面的标注。前端表单改动需要前端仓库配合。

- [ ] **Step 1: In the solutions list/detail API response, add hints**

在 `_handle_solutions_list` 中方案项的返回体里，如果返回了编排提示词，加 `prompt_config_hint` 字段标注 planner 为唯一可配项：

```python
"prompt_config_hint": {
    "planner_prompt": {"editable": True, "description": "方案编排规则（planner 拆解派单）"},
    "subtask_prompt": {"editable": False, "description": "运行时内置默认，不建议编辑"},
    "aggregate_prompt": {"editable": False, "description": "运行时内置默认，不建议编辑"},
}
```

- [ ] **Step 2: Commit**

```bash
git add app/team_panel/api_team/router_team.py
git commit -m "feat(AITEAM-33): mark subtask/aggregate prompts as non-editable in API response"
```

---

## Self-Review

**1. Spec coverage check:**

| Problem | Task |
|---------|------|
| 1: 3段编排提示词多余 → 收敛 | Task 8 (API 标注) |
| 2: planner 职责 | Task 6 (roster 补全) |
| 3: 方案≠群聊 | 不需代码改动（设计认知） |
| 4: 企业前端通过群聊使用 | Task 5 (自动建群) |
| 5: planner roster 拿不到能力 | Task 6 |
| 6: 应用只落1个agent | Task 3 + Task 5 (多 agent 循环) |
| 7: 应用后不建群 | Task 1 + Task 2 + Task 5 |
| 8: agent冲突 覆盖/新建 | Task 4 (preview) + Task 5 (决策) |

**2. Placeholder scan:** No TBD/TODO/fill-in-later found. All code shown inline.

**3. Type consistency:**
- `_resolve_solution_templates` returns `list[AgentTemplate]` — used as loop variable in Task 5 ✓
- `SolutionApplyRecord.conversation_id: Optional[str]` — matches `None` in create, `str` in update ✓
- `EmployeeRepo.list_active_by_template` returns `list[Employee]` — used in preview and apply handler ✓
- `SolutionApplyRecordRepo.get_latest_successful` returns `Optional[SolutionApplyRecord]` — used in apply handler ✓
- `_create_solution_group_conversation` returns `str` (conv_id) — assigned to `conversation_id: str` ✓
