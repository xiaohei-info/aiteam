# Agent 本地库 SQLite 持久化（mainline）实施计划（#158）

**Goal:** 用 SQLite 实现 agent 用户端本地库的 mainline 仓储（conversation/message/run/task + timeline），替换 `InMemory*`，接口形状不变，重启不丢；并落地 #159/#179 可复用的本地库底座。

**Architecture:** 新增 `agent_service/local_db.py`（连接 + 锁 + 迁移 runner 底座）+ `agent_service/migrations/0001_mainline.sql`；在 `store.py`/`timeline.py` 新增 `Sqlite*` 实现既有 ABC；`factory.py` 按 `db_path` 选择 SQLite/InMemory；`app.py` 从 `AGENT_DB_PATH` 注入。默认无路径 → InMemory（保持现有测试与 dev 行为不变）。

**Tech Stack:** Python 标准库 `sqlite3`（零新依赖，§3.1 复用优先/最小必要）、pydantic 模型复用、WAL + 单连接 + 写锁。

---

## 关键约束
- 只换实现不动 ABC 签名；既有 `InMemory*` 与全部现有测试保持绿。
- 用户端单租户本地库，无 tenant 路由/RLS（不引 shared/db）。
- 会话/执行内容只落本机；RawEventArchive 不在本卡（#179）。
- datetime 存 ISO 字符串、dict 存 JSON 文本；列表序：`ORDER BY created_at, rowid`（rowid 兜底插入序，对齐 InMemory）。

## 任务

### Task 1: 本地库底座 `local_db.py`
- `LocalDb`：持 `sqlite3.Connection`（`check_same_thread=False`, `row_factory=Row`, PRAGMA `foreign_keys=ON`/`journal_mode=WAL`）+ `threading.Lock`；提供 `execute/executemany/query/query_one/transaction`（全部锁内）。
- `connect(db_path)`：建父目录、开连接。
- `apply_migrations(db, migrations_dir)`：`schema_migrations(name PK, applied_at)` 跟踪，按文件名排序应用未应用的 `*.sql`（事务内）。#159/#179 仅追加 SQL 文件即可复用。

### Task 2: 迁移 `migrations/0001_mainline.sql`
conversations / messages / runs / tasks / timeline_events（见下方 DDL），含按会话的索引；timeline 主键 `(conversation_id, cursor)`。

### Task 3: `store.py` 新增 4 个 `Sqlite*Repository`
实现既有 ABC，行↔pydantic 模型互转；`get` 不存在抛 `NotFound`；`finalize`/`set_state`/`set_status` 更新 `updated_at`。

### Task 4: `timeline.py` 新增 `SqliteTimelineStore`
`append` 在锁内 `MAX(cursor)+1 WHERE conversation_id` 分配并插入；`read_after`/`latest_cursor`/`terminal_for_run`（逆序取该 run 终态事件）。

### Task 5: `factory.py` + `app.py` + `shared/config.py`
- `Settings` 加 `agent_db_path`（env `AGENT_DB_PATH`）。
- `build_mainline_service(..., db_path=None)`：有 path → LocalDb+迁移+SQLite 仓储；无 → InMemory。raw_archive 仍 InMemory（#179）。
- `app.py` 从 config 注入 `db_path`。

### Task 6: 测试
- `tests/agent/mainline/test_sqlite_store.py`：对 SQLite 跑与 InMemory 同套仓储行为 + **重启回读**（同 db 文件新开 LocalDb 读回）。
- timeline SQLite：append/read_after/latest_cursor/terminal_for_run + 重启回读 + 多 run 同会话游标连续。
- 迁移幂等：重复 `apply_migrations` 不报错、不重复建。

## 验收
- SQLite 跑通同套仓储/timeline 用例；重启后数据在；迁移幂等。
- `server` 全量 pytest 绿；边界/契约测试不红；独立盲审通过。
