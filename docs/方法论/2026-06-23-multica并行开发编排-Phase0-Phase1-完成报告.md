# Multica 并行开发编排 — Phase 0 & Phase 1 完成报告

**日期**: 2026-06-23  
**状态**: Phase 0 pilot 完成 ✅ | Phase 1 交付完成 ✅ | Phase 2 入口已补齐 ✅

---

## Phase 0 Pilot 验证结果

### ✅ 核心验证项
1. **Worker 能产 gateable PR**
   - 派发任务给 codex-ubuntu
   - 产出 PR #227: https://github.com/xiaohei-info/aiteam/pull/227
   - 包含完整 TDD 流程(函数 + 测试 + PR)
   - 测试通过: `test_validate_ids_unique PASSED`

2. **Agent 环境能跑 Python 引擎 + multica CLI**
   - pytest 套件: 21 passed in 0.07s ✓
   - multica CLI 可调: `squad get` 成功 ✓
   - Python 引擎 import: `from engine import run_dag` 成功 ✓

3. **副产物验证**
   - multica 支持自定义 role 串(`--role reviewer`)✓
   - 清空服务端 instructions 后本机 SOUL 仍生效 ✓

### 结论
✅ **设计可行,无需调整,Phase 2 可继续**

---

## 环境准备完成情况

### Squad 配置
**dev team** (`cf383144-1e6a-4beb-b988-39ae87f1c68c`):
- Leader: `hermes-orchestrator` (role=leader)
- Workers: `claude-ubuntu`, `claude-macmini`, `codex-ubuntu`, `codex-macmini` (role=member)
- Reviewer: `hermes-reviewer` (role=reviewer)
- Instructions: 已清空 ✓

### Profile 重构(A/B/C 完成)

**A — hermes-reviewer 吸收 qa 职责**:
- `reviewer/SOUL.md` v2.3→2.4
- 新增"独立验证执行"节,亲自复跑测试 + confirmed pass/fail/unverified
- `qa` profile 已归档到 `~/.hermes/profiles-archived/`
- 线上 `hermes-qa` agent 已归档
- 备份: `.bak-20260623-multica-refactor`

**B — orchestrator soul 精简 + 机制抽成 skill**:
- `orchestrator/SOUL.md` 422→85 行, v2.4→3.0
- 机制无关化,只剩通用编排纪律
- 看板 playbook 抽进独立 skill: `kanban-dev-orchestration` (15KB)
- 服务端 instructions 已清空 ✓

**C — dev team instructions 清空** ✓

### Multica Skills 创建
- ✅ `parallel-dev-executor-multica` (`1d4a41cc`): worker/reviewer 执行协议
- ✅ `parallel-dev-orchestration-multica` (`e69aefbf`): orchestrator 编排机制

---

## Phase 1 交付(逻辑核)

**位置**: `.claude/skills/parallel-dev-orchestration-multica/scripts/`

### 已完成模块

1. **manifest.py** — 数据模型
   - `Manifest` / `Node` dataclass
   - YAML 加载: `load_manifest(path)`

2. **lint.py** — 校验逻辑
   - `lint(manifest, pool) -> list[str]`
   - 检查: 无环、无孤儿、worker∈池、reviewer≠worker、依赖存在

3. **graph.py** — DAG 算法
   - `frontier(issues) -> list[key]`: 计算 ready 节点
   - `downstream_of(issues, failed) -> set[key]`: 失败分支隔离
   - `is_done(issues) -> bool`: 全终态判断

4. **compile.py** — Manifest 编译
   - `compile_manifest(manifest, client)`: manifest → issue metadata
   - 单向写入 blocked_by / worker / reviewer / gate

5. **engine.py** — 引擎循环
   - `run_dag(client, dispatch_worker, run_gate, max_parallel)`
   - 固定 driver: 连续 frontier → 派发 → 失败隔离 → 续跑

6. **client.py** — 抽象接口(测试用)
   - `MulticaClient` ABC: 定义 list_issues / set_metadata / assign 等
   - `FakeMulticaClient`: 内存实现,用于单测

7. **tests/** — 测试套件
   - 21 个测试全绿
   - 覆盖: manifest 加载、lint 各规则、graph frontier/隔离、compile、engine 循环

### Phase 1 Gap(已补齐)
- ❌ 缺可执行入口 → ✅ 已补 `run_dag.py`(今天)

---

## Phase 2 入口实现(今天补齐)

### run_dag.py — 固定引擎 CLI 入口

**文件**: `.claude/skills/parallel-dev-orchestration-multica/scripts/run_dag.py`

**功能**:
```bash
python run_dag.py <manifest.yaml>
```

**流程**:
1. 加载 manifest
2. Lint 校验(调 `lint(manifest, squad_members)`)
3. 创建/查找 multica issues(通过 title 匹配 key)
4. 编译 metadata(调 `compile_metadata`,直接 subprocess 调 `multica issue metadata set`)
5. 运行引擎循环:
   - 计算 frontier(调 `frontier(issues)`)
   - 派发 worker: `multica issue assign` + 轮询 `multica issue runs` + 检查 PR
   - 派发 reviewer(如有): `multica issue assign` + 轮询 + 读 `review_verdict`
   - 失败隔离: `downstream_of(issues, failed)`
6. 输出 digest: done / failed 统计

**实现方式**: 直接 `subprocess.run(['multica', ...])`,无抽象封装层

**当前状态**: 
- ✅ 语法正确,导入成功
- ⏸ 待端到端冒烟验证(需要真实 manifest + squad)

---

## 当前架构总结

### 设计对齐
按设计文档 §11 交付物:
```
scripts/
  run_dag.py          ✅ 固定引擎入口(今天补齐)
  lint.py             ✅ manifest 校验
  compile.py          ✅ 单向编译
  manifest.py         ✅ 数据模型
  graph.py            ✅ frontier 算法
  engine.py           ✅ 循环逻辑
  client.py           ✅ 测试用抽象(FakeMulticaClient)
  tests/              ✅ 21 测试
```

### 执行模型
- **Leader**(hermes-orchestrator):
  1. 加载 `parallel-dev-orchestration-multica` skill
  2. Skill 告诉它"跑 `python run_dag.py manifest.yaml`"
  3. 引擎直接调 multica CLI(subprocess),不经过抽象层

- **Worker**(codex/claude-ubuntu/macmini):
  1. 加载 `parallel-dev-executor-multica` skill
  2. 从 issue metadata 读配置(worker/gate/blocked_by)
  3. TDD 实现 → 产 PR → 写证据到 metadata.artifacts

- **Reviewer**(hermes-reviewer):
  1. 加载 `parallel-dev-executor-multica` skill
  2. checkout PR → 复跑测试 → 质量审查
  3. 判 verdict → 写回 metadata.review_verdict

---

## 下一步: Phase 2 端到端冒烟

### 待验证
1. **写一个 2 节点 manifest**:
   ```yaml
   squad: cf383144-1e6a-4beb-b988-39ae87f1c68c
   nodes:
     task1:
       description: "简单任务1"
       worker: codex-ubuntu
     task2:
       description: "简单任务2,依赖 task1"
       worker: claude-macmini
       depends_on: [task1]
   ```

2. **跑引擎**:
   ```bash
   cd .claude/skills/parallel-dev-orchestration-multica/scripts
   python run_dag.py /tmp/test_dag.yaml
   ```

3. **验证行为**:
   - lint 通过
   - 创建 2 个 multica issues
   - compile metadata(blocked_by / worker)
   - task1 派发给 codex-ubuntu → 等完成
   - task2 等 task1 done 后派发给 claude-macmini
   - 输出 digest

### 已知限制(待完善)
1. **Agent 名 → Agent ID 解析**: 当前 `resolve_agent_id` 是 stub,需要真实实现
2. **Issue 创建逻辑**: 当前通过 title 匹配,真实应支持"幂等创建"或明确 key→id 映射
3. **并发**: 当前 `max_parallel=1` 顺序执行,后续改线程池
4. **错误处理**: 当前异常会中断,需要更优雅的失败处理

---

## 风险与限制

1. **hermes-orchestrator 性能**: pilot probe 任务慢(30分钟),需监控真集成表现
2. **PR base 分支**: pilot PR 包含历史提交(本地领先 origin),需处理 git base
3. **Leader 自感知**: `resolve_agent_id` 如何知道"我是谁"(环变量 vs 推断 vs manifest 传参)
4. **Metadata KV 限制**: multica metadata 是否支持复杂 JSON(如 blocked_by 数组)

---

## 交付清单

### 代码
- ✅ 6 个 Python 模块(manifest/lint/graph/client/compile/engine)
- ✅ 1 个 CLI 入口(run_dag.py)
- ✅ 21 个测试(全绿)

### 文档
- ✅ 设计文档: `docs/方法论/2026-06-23-multica并行开发编排-设计.md`
- ✅ 实施计划: `docs/方法论/2026-06-23-multica并行开发编排-实施计划.md`
- ✅ Phase 0 报告(本文档)

### 环境
- ✅ dev team squad 配置完成
- ✅ hermes profiles 重构完成
- ✅ 2 个 multica skills 创建完成

### Pilot 产物
- ✅ PR #227(worker 能产 PR 的证据)
- ✅ AITEAM-42(agent 环境验证记录)

---

**Phase 0 & Phase 1 状态**: ✅ 全部完成  
**Phase 2 状态**: ⏸ 入口已补齐,待端到端冒烟
