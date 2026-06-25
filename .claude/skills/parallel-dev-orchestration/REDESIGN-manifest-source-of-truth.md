# 重构设计：Manifest 作为全局唯一口径

> 本文是 **设计/重构提案**（review 用），不是已落地实现。代码实现作为后续独立、需再次批准的步骤。
> 配套现状文档见同级 `EXECUTION_FLOW.md`（描述当前实现）；本文描述目标态与改动。

---

## 1. 背景：当前有三套互相冗余的「自造存储」

orchestrator 现在把状态/存储搞成了三套并行结构，互相冗余且大半没真正落地：

- **`find_work_item_by_dag_key`（multica/github 实现）= 拉全量 issue 再扫 metadata/title**，O(n) 且每轮都扫，效率差。
- **`create_run / get_run / list_runs / delete_run` 在 multica/github 全是 `NotImplementedError` 桩**，只有 mock 跑得通——这套 Run 存储从没真正落地。
- **checkpoint（`_save/_load_checkpoint`）+ Run + event log** 是 mock 在 `.multica_state/` 下自造的本地存储，**和 git、和真实平台都无关**；`create_run` 还「保存 manifest」，但删掉 `resume_run` 后**已无任何 reader（死代码）**。
- `execute_dag` 先 `_save_checkpoint` 再立刻 `_load_checkpoint`，在单进程内 write-then-read 倒手，纯属绕弯。

事实核对（代码依据）：

| 现象 | 位置 |
|---|---|
| manifest 只能读不能写 | `core/manifest.py` 只有 `load_manifest` |
| Run 存储是桩 | `multica.py` / `github.py` 的 `create_run/get_run/list_runs/delete_run` → `NotImplementedError` |
| checkpoint 只服务 mock 本地 | `mock.py` `_save/_load_checkpoint` 写 `.multica_state/` |
| find 全量扫 | `multica.py:404` `list_work_items()` 后线性匹配 `dag_key`/title |

---

## 2. 新模型：manifest 文件就是全局唯一口径

### 2.1 两个阶段

**Phase 1（拆 DAG）**
1. orchestrator 按 plan/设计文档拆出 DAG；
2. 在项目根 `.orchestrator/<name>.yaml` 生成 manifest，记录每节点的 `dag_key`、依赖、worker/reviewer、**完整 issue body**（worker 的上下文来源）；
3. 建分支 + `gh pr create`；
4. 等评审通过——**评审者是人或 agent 都行，orchestrator 只看「是否通过」，不关心「谁评审」**；
5. 通过即 `gh pr merge` 到目标分支；
6. 到此 Phase 1 才算完成。

**Phase 2（跑 DAG）**
1. 脚本读「已评审」的 manifest；
2. 按引擎在平台建 work item，**把平台返回的 `engine_id` 回填进 manifest 并 commit+push**（双 ID 钉死映射）；
3. 跑的过程中节点状态变更实时写回 manifest 文件；
4. `engine_id` 回填与终态在关键节点 commit+push。

### 2.2 双 ID（核心）

每个节点两个 ID：

- **`dag_key`**：orchestrator 生成、写进 manifest（即现有 `Node.id`）。
- **`engine_id`**：平台建完 work item 返回的唯一 id（GitHub issue 号 / Multica issue id），Phase 2 回填进 manifest。

有了 `engine_id`，幂等查询从「全量扫」变成 **`get_work_item(engine_id)` 精准取**（O(n)→O(1)）；`dag_key↔engine_id` 的映射钉死在 manifest 里，不必再单独维护对应关系，也不必再扫平台。

### 2.3 全局幂等检查与状态校验（取代 checkpoint）

manifest 经 git 流转，可能是**别的机器 commit 来的、带部分状态**（例如本机 orchestrator 跑挂了，手动 commit 已更新部分状态的 manifest，另一台机器接力）。

因此 **Phase 2 启动时做一次全局 reconcile**：逐节点拿 `engine_id` 去平台核对真实状态 vs manifest 记录，补齐 gap，再继续跑。manifest 是口径，平台是实况，二者对齐后才往下跑。`completed/failed` 由「manifest 的 `status` 字段 + 平台校验」推导，不再需要 checkpoint。

---

## 3. 改动清单

### A. 数据结构：manifest 节点加双 ID + 状态，并支持回写

`core/manifest.py`：
- `Node` 加字段：`engine_id: str | None = None`、`status: str = "todo"`（其余 `dag_key=id`/worker/reviewer/blocked_by/title/description/risk/gate 不动；`description` 即承载完整 issue body）。
- `load_manifest` 解析新字段（缺省 `engine_id=None`、`status="todo"`）。
- **新增回写能力**（当前完全没有）：
  - `save_manifest(manifest, path)`：把 meta + 全部 node 字段（含 engine_id/status）序列化回 YAML，原地覆盖；用我们自己掌握的 schema 显式 dump，保证字段齐全、可读。
  - `set_node(manifest, key, *, engine_id=None, status=None)`：仅改传入字段。

### B. 引擎接口收敛 `engines/base.py`（+ 三实现）

**删除**（base + mock + multica + github 同步删）：
- `find_work_item_by_dag_key`（被 manifest.engine_id + `get_work_item` 取代）；
- `create_run / get_run / list_runs / delete_run`（Run 存储；manifest 即记录）；
- `_save_checkpoint / _load_checkpoint`（manifest 携带状态）；
- `_log_event`（进度改用 `add_comment` + stdout；平台 issue 自带时间线）；
- `models.py` 的 `Run / RunStatus`（连同 `to_dict/from_dict`）。

**保留**（核心 8 个）：`list_members`、`create_work_item`（返回带 engine_id 的 WorkItem）、`get_work_item`（**升为主查询**，按 engine_id 精准取）、`update_work_item_metadata`、`list_work_items`（供进度/调试）、`add_comment`、`update_status`、`assign_work_item`，外加 env 声明类方法。

**mock 精简**：删 `.multica_state/` 下 run/checkpoint/events 落盘与 `_runs/_run_checkpoints`；`_work_items` 内存表保留（mock 的「平台」）；`create_work_item` 返回 `WorkItem.id` 作为 engine_id。

> 净效果：引擎抽象接口 ~16 → ~8。删掉的全是桩或自造存储，且 multica/github 的 `create_work_item/get_work_item/update_status/assign` 本就已实现（非桩），新流程正好只依赖这些已落地接口——**零破坏**。

### C. 编排主流程 `run_dag.py` 重写为 manifest 驱动

- `start_new_run(manifest_path, engine)`：load → lint → **reconcile** → `execute_dag`。删掉 create_run、删掉 checkpoint 读写。
- 新增 `reconcile(engine, manifest, manifest_path)`（启动校验，取代 checkpoint 种子）：
  - 有 `engine_id` → `get_work_item(engine_id)`：以**平台实际状态**为准，回填/纠正 `node.status`（平台 done 而 manifest 没记 → 补齐；engine_id 指向的 item 在平台已不存在 → 清空 engine_id 走新建）；
  - 无 `engine_id` → 该节点未建，留待 execute_dag 首次建；
  - 校验后 `save_manifest` 落盘。
- `execute_dag(engine, manifest, manifest_path)`：
  - `completed = {k for k,n in nodes if n.status=="done"}`；`failed = {... blocked/failed}`；snapshot 由 manifest + 必要时实时 `get_work_item` 构成；
  - frontier / downstream_of（`graph.py` 不变）算 ready；
  - 节点首次派发前若 `node.engine_id is None` → `create_work_item(...)` → `set_node(engine_id=...)` → `save_manifest` → **commit_manifest("backfill engine_id: <key>")**；
  - 派 worker / reviewer（沿用现有 `dispatch_worker`/`run_gate`，去掉 `_log_event`）；
  - 节点进终态：`set_node(status=done|blocked)` → `save_manifest` → **commit_manifest("<key> -> <status>")**；
  - 中途其他 status 变更只 `save_manifest`（本地，不提交）。
- 新增 `commit_manifest(path, message)`（util）：`git add <path>` + `git commit -m` + **`git push`**；幂等（无变更跳过）；**push 失败醒目告警**（跨机器口径会滞后）但不中断编排；**不自动 merge**（PR 评审是外部门控）。
- `--list` 命令删除（无 Run 存储）。

### D. 文档 `SKILL.md`

- 第一部分末尾新增「阶段 B 收尾：manifest 落盘 + PR 评审门」：固定路径 `.orchestrator/<name>.yaml`；建分支→`gh pr create`→等评审通过（人/agent 皆可，只看通过与否）→`gh pr merge`→才进 Phase 2；强调 manifest 必须含完整 issue body。
- 第二部分「执行编排」：把「按 dag_key 去重 + 持久化状态快照 + 断点续跑」改写为新模型——manifest 唯一口径；engine_id 回填+commit+push；Phase 2 启动做全局幂等检查与状态校验（含跨机器接力场景）。
- 删除 `--list`、checkpoint、Run、event log 相关描述；双 ID 机制写清楚；节点字段表补 `engine_id`/`status`。

### E. 测试（硬要求：真正覆盖「跑 DAG 图核心全流程」，mock + multica 两引擎都必须跑通）

**核心流程端到端测试（参数化 over 引擎）**——新增 `test_run_dag_e2e.py`，用同一组断言对 **mock** 和 **multica** 各跑一遍 `start_new_run`（load→lint→reconcile→execute_dag）完整链路：

- **multica 如何「跑通」而不依赖真实服务**：提供 fake multica CLI——临时目录放可执行 `multica` 脚本注入 `PATH`（或 monkeypatch `MulticaEngine._run_multica`），用内存/本地 JSON 模拟 `issue create/get/update/assign/metadata set/comment/agent list/squad member list`，让 `create_work_item`/`get_work_item`/`update_status`/`assign_work_item` 真正走 multica 代码路径（复用现有 `tests/test_client_fake.py` 思路）。
- 每引擎断言：①两层 DAG A→B 跑到全 done；②manifest 节点回填 `engine_id`、`status=done`；③关键节点触发 `commit_manifest`（commit+push 被调用——fake git remote 或 monkeypatch 捕获，断言 engine_id 回填与终态各 push 过）；④幂等重跑：已 done 且有 engine_id 的节点直接 `get_work_item(engine_id)` 复用、0 新建、**不**全量扫；⑤把 B 改回 blocked 重跑 → 只重做 B。
- **reconcile 测试**：manifest 记 engine_id 但 status 落后于平台（平台已 done）→ reconcile 补成 done；engine_id 指向平台不存在 item → 清空待新建。mock + multica 各覆盖。
- 改 `test_engines.py`：删 `find_work_item_by_dag_key` 用例，加 `get_work_item(engine_id)` 精准取用例。
- 新增 `test_manifest_roundtrip.py`：`save_manifest`→`load_manifest` 保真（engine_id/status/依赖/body 不丢）；`set_node` 只改指定字段。
- 删除/改写所有引用 checkpoint/create_run/get_run/list_runs/_log_event 的断言。
- `compile.py`/`test_compile.py`：实现时先 grep 确认 `compile_manifest` 是否仍被引用（run_dag 未 import），死代码则清掉，否则不动——不擅自扩大范围。

---

## 4. 关键约束（已与用户对齐）

- engine_id 回填后**必须 commit+push**（否则别的机器/平台无法凭 manifest 反查平台任务、跨机器接力拿不到最新口径）→「关键节点 commit+push」：每节点首次建 work item 回填 engine_id 后 push 一次；节点进终态后 push 一次；中间 status 只写本地文件。
- `commit_manifest` 仅 commit+push，**不自动 merge**；push 失败告警不中断。
- PR 评审：orchestrator 只看「是否通过」，不关心「谁评审」；通过即合并。纯 SKILL.md 流程 + orchestrator 跑 `gh`，不加脚本。
- 仅改 `.claude/skills/parallel-dev-orchestration/`；不涉及 `app/`、`.hermes/`。

---

## 5. 验证（实现阶段）

- `cd .claude/skills/parallel-dev-orchestration && python3 -m pytest scripts/tests/ -q` 全绿——其中 `test_run_dag_e2e.py` 对 **mock 与 multica 两引擎各跑通完整 run-DAG 核心流程**。
- 端到端（临时 git repo + fake remote）：
  1. 写 `.orchestrator/m.yaml`（A→B），跑 `run_dag.py`：平台建 item、engine_id 回填、关键节点 commit+push、终态 done；
  2. 重跑：已 done 且有 engine_id 的节点跳过（0 新建），日志显示精准 `get_work_item(engine_id)` 而非全量扫；
  3. 手改 B 为 blocked 重跑：只重做 B；
  4. reconcile：手改 manifest 让 status 落后于平台，跑启动校验，断言被纠正（mock + multica 各验）。
- before/after：引擎抽象接口数（~16→~8）、删除清单、`git log` 显示 manifest 的 engine_id 回填与终态 commit。

---

## 6. 风险与边界

- **git commit+push 副作用**：编排过程会向用户仓库写 commit 并 push——用户已明确要求，授权明确；不自动 merge；push 失败告警不阻断。
- **跨机器接力**：manifest 经 git 流转，reconcile 以平台实际状态为准纠正 manifest，避免 gap。
- **不破坏 executor 侧**：worker/reviewer 仍从平台 issue 读 body/metadata、写 artifacts/verdict，`parallel-dev-executor` skill 不改。
