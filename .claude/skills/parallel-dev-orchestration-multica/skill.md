---
name: parallel-dev-orchestration-multica
description: 把设计/plan 拆成声明式 manifest DAG,用固定引擎驱动 multica 多 Agent 并行开发到收敛闭环，采用 Harness 动态编排机制
---

# Multica 并行开发编排机制 (Orchestrator)

你作为 **leader**,在 multica 上编排并行开发任务时使用本 skill。

**核心**:契约先行方法论 + 声明式 manifest + 固定引擎 + multica 原生派发。

---

## 这套机制解决什么问题

多人/多 Agent 并行开发大型系统时,两个矛盾反复出现:

1. **并行 vs 一致** — 拆得越细越能并行,但模块越多越容易接口对不齐、各自发明 DTO/枚举/错误格式,集成时炸裂
2. **效率 vs 不跑偏** — 任务一多、链路一长,开发者（人或 AI Agent）"写着写着就偏了",实现细节与设计文档、核心约束悄悄冲突,越往后越难纠

本机制用一个核心动作同时化解二者:**把"接口"和"约束"从文字变成代码与闸门**。接口是代码,偏不了；约束是测试,偏了就红；剩下的语义偏差,由独立评审兜底。

---

## 何时用 / 不用

**适用场景**:
- 跨模块/跨服务,有清晰模块边界
- 需要多人或多 Agent 并行
- 有设计文档可依的中大型工程
- 模块间接口已明确或可快速明确

**不适用场景**:
- 单人单模块的小改动
- 探索性原型（契约还没稳定,过早冻结是浪费）
- 需求频繁剧烈变动的早期探索阶段

**判断标准**: 如果你能从设计文档推导出"模块间需要对接哪些 DTO/事件/状态"且这些口径在短期不会推翻重来,就可以用。

---

## 你的职责

1. **拆解任务** → 从设计文档产出 manifest.yaml (声明式 DAG)
2. **执行编排** → 跑 `python orchestration/scripts/run_dag.py manifest.yaml`
3. **监督到底** → 引擎自动派发、轮询、失败隔离
4. **记录进度** → 每次关键进度更新（包括失败）都 comment 到相关 issue
5. **处理失败** → 调整 manifest、重跑引擎
6. **汇总收尾** → 输出 digest、决策日志

**核心原则**: 你只拆、只派、只盯、只收,不抢 worker 的活。引擎是固定脚本,你不需要推理循环逻辑。

**进度记录规范**：
- 如果你自己有 orchestrator issue 作为载体，comment 到该 issue
- 如果没有专门的 orchestrator issue，comment 到对应的节点 issue
- 记录内容：节点状态变更、失败原因、调整决策、阶段性总结

---

## 三阶段流程

### 阶段 A — 打地基 (Wave 0,串行)

按方法论 §3 产出"地基四件套":
- **共享契约**(代码,下游只 import)
- **共享底座**(DB schema / 配置 / 工具库)
- **可运行骨架**(项目结构 / 入口 / CI pipeline)
- **CI 闸门 + 对端假件**(mock/fake,让并行模块对着假件开发)

**判据**: 能写出每张工单卡、且卡里"必消费契约"已是可 import 的代码、"验收"已有(哪怕 skip 的)测试位——做不到就别扇出。

#### 从零开始准备地基的清单

第一次在新项目套用这套机制时,按此顺序准备:

```
[ ] 1. 锁定设计文档为单一事实源(散在多处的口径先收敛去重)
[ ] 2. 列出"模块间需要对接的全部口径"(DTO/事件/枚举/错误/状态/跨服务调用)
[ ] 3. 把这些口径写成代码契约(shared/contracts/或类似位置),作为地基第一件
[ ] 4. 为契约写"不变量测试"(取值集合、必填字段等),这是漂移守卫
[ ] 5. 写边界扫描测试(禁用旧口径/越界 import等)+ 质量门禁,接进 CI
[ ] 6. 搭可运行骨架(每个模块能起来、暴露健康检查与接口文档入口)
[ ] 7. 为尚未实现的对端写 fake/mock(让下游能脱离真对端开发)
[ ] 8. 用测试验证地基本身可跑、可测、全绿 → 地基冻结,可以扇出了
```

冻结后再拆 manifest,进入阶段 B。**地基没冻结就扇出 = 最常见的失败**。

**manifest 示例**(Wave 0):
```yaml
squad: cf383144-1e6a-4beb-b988-39ae87f1c68c
nodes:
  shared-contracts:
    description: "定义跨模块 DTO/事件/错误契约(TypeScript/Python types)"
    worker: codex-ubuntu
  
  project-scaffold:
    description: "项目骨架:目录结构/构建/CI pipeline"
    worker: claude-macmini
    depends_on: [shared-contracts]
  
  mock-services:
    description: "对端 mock/fake(让业务模块对着假件并行开发)"
    worker: codex-ubuntu
    depends_on: [shared-contracts]
```

### 阶段 B — 拆 plan 成 manifest DAG

收到用户的复杂开发需求(含设计文档/plan),你要拆成并行 DAG。
#### 拆解方法

**步骤 1 — 找"地基"(Wave 0)**

从设计文档识别:
- 共享契约边界(跨模块接口)
- 底座组件(DB / 配置 / 认证)
- 骨架(项目结构 / CI)
- 闸门与假件

这些是**串行前提**,产出 Wave 0 节点。

**步骤 2 — 找"集成缝"(划分并行 track)**

沿契约边界切分独立 track:
- 各 track 对着 mock 并行开发
- track 间无运行时依赖(只通过契约对接)

示例:
```
Track A: 用户服务(user CRUD / 认证)
Track B: 订单服务(order 流程 / 支付集成)
Track C: 通知服务(邮件 / 短信 / 推送)
```

**步骤 3 — 每个 track 内找"小地基"**

每 track 内排序:小地基 → 业务模块
- 小地基: track 内共享组件(如 user service 的数据层)
- 业务模块: 依赖小地基的功能模块

**步骤 4 — 配对端 mock**

确保每个业务模块的"对端"已在 Wave 0 产出 mock/fake,并行时对着假件开发。

**步骤 5 — 留集成验收波 (Wave 2)**

最后一波:替换 mock → 真对端,跑端到端测试。

#### Manifest 编写规范

**依赖关系(depends_on)**:
```yaml
nodes:
  # Wave 0: 地基(串行)
  contracts:
    worker: codex-ubuntu
  
  scaffold:
    depends_on: [contracts]
    worker: claude-macmini
  
  # Wave 1: 并行 track(小地基先行)
  user-data-layer:
    depends_on: [contracts, scaffold]
    worker: codex-ubuntu
  
  user-api:
    depends_on: [user-data-layer]  # track 内先后
    worker: claude-macmini
  
  order-service:
    depends_on: [contracts, scaffold]  # 与 user 并行
    worker: codex-ubuntu
  
  # Wave 2: 集成验收
  e2e-test:
    depends_on: [user-api, order-service]  # 等全部 Wave 1 完成
    worker: codex-ubuntu
```

**拓扑**:
```
      contracts
          ↓
      scaffold
       /     \
user-dl    order-svc  (并行)
   ↓
user-api
     \      /
    e2e-test
```

**关键字段**:
- `squad`: workspace ID，需要先获取并让用户确认：
  ```bash
  # 列出所有 workspace
  multica workspace list --output json | jq '.[] | {id, name, description}'
  # 让用户确认使用哪个，或由用户直接提供
  ```
- `nodes.<key>.worker`: worker agent 名(必须∈squad agents)
- `nodes.<key>.reviewer`: reviewer agent 名(可选,非空时必须≠worker)
- `nodes.<key>.depends_on`: 依赖节点 key 列表(空 = Wave 0 可立即开始)
- `nodes.<key>.gate`: 自定义验收条件(可选,默认="测试全绿")

#### 粒度与拆解原则

**第一级拆解(你做,写进 manifest)**:
- 粒度 = 并行单元(track 内小地基 + 各业务模块)
- 半天~两天可收口
- 数十个节点,别拆成数百微任务

**依赖三原则**:
1. 只把"真前置"设为硬依赖 `depends_on`(小地基→业务模块;Wave 0→Wave 1→Wave 2)
2. 软依赖只在 description 提示,**不设硬边**(每条假硬边都减少并行度)
3. 节点内细分由 worker 自己拆(你不微管)

#### Agent 选择（按 role 字段）

从 workspace agents 中按 role 字段选择（**不要写死 agent 名字**）：

```bash
# 查询 workspace 中所有 agent 及其 role
multica agent list --workspace-id <workspace-id> --output json | jq '.[] | {name, role}'
```

**Role 定义**：
- `role: "worker"`: 工作 agent，负责实现任务（后端/前端/数据处理/复杂逻辑）
- `role: "reviewer"`: 评审 agent，专职独立验证执行
- `role: "architect"`: 架构师 agent，负责架构设计审查与整体架构评审
- `role: "leader"`: 编排 agent（你自己），负责拆解与编排

**选择策略**：
- 查询后让用户确认使用哪个 agent
- 或根据 role 自动匹配（如所有 `role: "worker"` 的 agent）
- manifest 中填写 agent 的 `name` 字段（不是 role）

#### Reviewer 可选

- **有 reviewer**: worker done → in_review → reviewer 复跑测试判 verdict → pass 才 done
- **无 reviewer**: worker done → 直接 done(风险高,适合低风险卡)

**推荐**: Wave 0 地基 + Wave 2 集成验收 **必须有 reviewer**;Wave 1 业务模块按风险决定。

#### Architect 特殊角色

当 workspace 中有 `role: "architect"` 的 agent 时：

**架构相关任务交给 architect**：
- 共享契约设计（Wave 0）
- 架构模式评审（跨模块设计）
- 最终整体架构评审（Wave 2 后）

**Manifest 配置**：
```yaml
nodes:
  shared-contracts:
    worker: <architect-agent-name>  # 架构师负责契约设计
    reviewer: <reviewer-agent-name>
  
  # ... Wave 1 业务模块 ...
  
  architecture-review:
    description: "整体架构评审：模块边界、依赖方向、设计模式一致性"
    worker: <architect-agent-name>
    depends_on: [全部 Wave 1 节点]  # 最后执行
```

**架构评审重点**：
- 模块边界是否清晰
- 依赖方向是否合理
- 设计模式是否一致
- 契约是否被正确遵守
- 是否有架构漂移

#### Gate 自定义(可选)

```yaml
nodes:
  security-audit:
    worker: codex-ubuntu
    reviewer: hermes-reviewer
    gate: "安全扫描无 critical / high + PM sign-off"
```

引擎会把 gate 写进 metadata,reviewer 据此判断。

---

### 阶段 C — 执行编排(跑引擎)

保存 manifest 后,执行:

```bash
# 在当前项目根目录下的 orchestration 目录
cd <项目根目录>/orchestration
python scripts/run_dag.py <manifest-path>

# 或者从项目根目录直接指定完整路径
python orchestration/scripts/run_dag.py /tmp/my-feature.yaml
```

**引擎会自动**:
1. **Lint 校验**(无环、worker∈池、reviewer≠worker)
2. **创建 multica issues**(如果不存在,通过 title 匹配 key)
3. **编译 metadata**(blocked_by/worker/reviewer → issue metadata)
4. **循环监督**:
   - 计算 frontier(ready 节点 = todo 且依赖全 done)
   - 派发 worker(`multica issue assign`)
   - 轮询 runs 到终态
   - 检查 PR(从 metadata.artifacts 读)
   - 派发 reviewer(如有)
   - done 或 failed
5. **输出 digest**: `done: [oauth-setup, jwt-service, ...], failed: []`

**你不需要写循环逻辑**——引擎是固定的,你的价值在拆解质量和失败决策。

---

### 处理失败

如果某节点 failed:
- **失败隔离**: 引擎自动标记该节点的下游为 blocked(不再派发)
- **其它分支继续**: 独立 track 不受影响
- **你的决策**:
  1. 分析失败原因(从 issue comment / PR / run messages 读)
  2. 调整 manifest:
     - 换 worker(换个擅长的 agent)
     - 拆小(一个节点拆成 2-3 个小节点)
     - 降范围(砍非核心需求)
  3. 重跑 `run_dag.py`(status 持久,已 done 不重做)
  4. 或接受部分失败,汇总给用户

**失败示例与调整**:
```yaml
# 原 manifest(jwt-service failed)
nodes:
  jwt-service:
    worker: claude-macmini  # 失败了
    depends_on: [oauth-setup]

# 调整 manifest(换 worker + 拆小)
nodes:
  jwt-core:
    worker: codex-ubuntu  # 换擅长后端的
    depends_on: [oauth-setup]
  
  jwt-middleware:
    worker: claude-macmini
    depends_on: [jwt-core]  # 拆小,先做核心
```

---

### Closeout(收尾)

全 done 或你判断可收尾时:
1. **汇总 digest**:
   - 哪些 done、哪些 failed
   - PR 链接列表
   - 已知问题与限制
2. **写决策日志**:
   ```bash
   multica squad activity <squad-id> --message "完成 XX 功能编排:done 8/10,failed 2(降范围),详见 issues"
   ```
3. **向用户汇报**:
   - 交付物(PR 列表 / 集成分支)
   - 验收状态(哪些通过、哪些有限制)
   - 后续建议

---

## 引擎行为(固定逻辑,不可配)

### Frontier 计算
`status=todo` 且 `blocked_by` 全 done → ready(可派)

### 失败隔离
某节点 failed → `downstream_of(failed)` 标记为 blocked → 不再派发

### 续跑
引擎可中断重启:
- 已 done 不重做
- 重新编译 metadata 后从当前状态继续

### 并发
当前实现顺序执行(`max_parallel=1`)。后续改线程池时仍保持语义。

---

## 脚本清单(已上传)

- `orchestration/scripts/manifest.py`: 数据模型 + YAML 加载
- `orchestration/scripts/lint.py`: 校验(无环/无孤儿/worker∈池)
- `orchestration/scripts/graph.py`: frontier 算法 + 失败隔离
- `orchestration/scripts/compile.py`: manifest → metadata 编译
- `orchestration/scripts/engine.py`: 循环逻辑核心
- `orchestration/scripts/client.py`: 测试用抽象(真实执行不用)
- `orchestration/scripts/run_dag.py`: CLI 入口 ★ **这是你要跑的**

---

## 与 Executor Skill 的关系

Worker/Reviewer 通过 `parallel-dev-executor-multica` skill 知道:
- 从 issue metadata 读配置(worker/gate/blocked_by)
- TDD 实现 → 产 PR → 写证据(metadata.artifacts)
- Reviewer 复跑测试 → 判 verdict(metadata.review_verdict)

你(leader)只负责:
- **拆解**(从设计文档 → manifest DAG)
- **编排**(跑 run_dag.py)
- **监督**(引擎自动)
- **失败决策**(调整 manifest)
- **收尾**(汇总 digest)

**不要抢 worker 的活**——你不写实现代码,只拆图、派工、盯进度。

---

## 拆解检查清单

写完 manifest 后自查:

**结构检查**:
- [ ] Wave 0(地基)已识别且串行(contracts/scaffold/mock)
- [ ] Wave 1 按 track 划分,track 间并行
- [ ] 每个 track 内小地基先于业务模块
- [ ] Wave 2 集成验收依赖全部 Wave 1
- [ ] 所有 depends_on 引用存在(无悬空依赖)

**依赖检查**:
- [ ] 只设"真前置"为硬依赖(假硬边会减少并行度)
- [ ] 软依赖只在 description 提示
- [ ] 无循环依赖(lint 会检查)

**成员检查**:
- [ ] 所有 worker∈squad members
- [ ] reviewer(如有)∈squad 且≠worker
- [ ] 按 agent 特长分配(codex→后端,claude→前端)

**验收检查**:
- [ ] Wave 0 + Wave 2 有 reviewer
- [ ] 高风险节点有 reviewer + gate
- [ ] description 明确交付物

---

## 禁止事项

1. ❌ 不要手工改 issue metadata(compile 单向写入,引擎只读)
2. ❌ 不要跳过 lint(manifest 错误会导致引擎行为异常)
3. ❌ 不要在引擎运行中手工改 issue status(会破坏状态机)
4. ❌ 不要混用本机制与 kanban 看板机制(两套并行,按基底择一)
5. ❌ 不要自己实现循环逻辑(引擎是固定的,你只负责拆解)
6. ❌ 不要拆成数百微任务(粒度=并行单元,半天~两天可收口)

---

## 当前状态

- ✅ Phase 0 pilot 完成(worker 能产 PR,环境能跑引擎)
- ✅ Phase 1 逻辑核完成(7 脚本 + 21 测试全绿)
- ✅ Phase 2 入口已补齐(run_dag.py)
- ⏸ 待端到端冒烟(真实 2-3 节点 manifest)

---

## 快速上手

当你收到编排任务:

**1. 读设计文档,识别地基**
- 共享契约在哪?
- 底座组件有哪些?
- 骨架与 CI 怎么建?

**2. 写 manifest.yaml**
```yaml
squad: cf383144-1e6a-4beb-b988-39ae87f1c68c
nodes:
  contracts: {worker: codex-ubuntu, description: "..."}
  scaffold: {worker: claude-macmini, depends_on: [contracts], description: "..."}
  # ... Wave 1 并行 track
  e2e: {worker: codex-ubuntu, reviewer: hermes-reviewer, depends_on: [...全部], description: "..."}
```

**3. 跑引擎**
```bash
python orchestration/scripts/run_dag.py /tmp/my-feature.yaml
```

**4. 监督 + 失败决策**
- 引擎自动派发、轮询
- failed? 调整 manifest、重跑

**5. 汇总收尾**
- 输出 digest
- 写决策日志
- 向用户汇报

就这么简单。你的价值在**拆解质量**和**失败决策**,引擎是固定的。

---

## 核心信念与设计哲学

在拆解任务前，牢记这5条核心信念：

1. **跑偏不能靠"提醒"治，要靠"结构"治**  
   "记得看文档"不可靠；让错误的写法编译不过/测试不过/合并不了，才可靠。

2. **接口是地基，不是产物**  
   模块间的契约（数据结构、事件、错误、状态、跨服务调用）必须**先于**业务实现冻结，且以**代码**形式存在。

3. **对端可以是假的**  
   只要契约冻结，每个模块都能对着对端的 mock/fake 独立开发，无需等对端做完——这是并行度的来源。

4. **单一事实源**  
   每条口径只有一个权威出处（一段代码或一篇文档），其它地方引用它，禁止平行拷贝（拷贝必然漂移）。

5. **"完成"必须有客观证据**  
   不是"我觉得没问题"，而是测试/构建/接口调用通过。

---

## 防跑偏三层模型

把"防跑偏"拆成三层，越靠上越硬、越早生效：

| 层 | 防什么偏 | 手段 | 偏了会怎样 |
|---|---|---|---|
| **接口层** | 模块间对接不一致（DTO/事件/枚举/错误/调用形状） | **契约即代码**：共享类型包，下游只 import、禁重定义 | 类型/导入/契约测试不过——**偏不了** |
| **边界层** | 越过职责红线、用了被禁的旧口径、违反硬约束 | **CI 闸门**：边界扫描 + 契约不变量测试 + 质量门禁 | 当场红灯——**偏了立刻知道** |
| **语义层** | 接口对、约束没违反，但实现意图跑偏了设计 | **独立评审**：非实现者对照"设计文档 × 约束"逐条核对 | 合并被打回——**兜底** |

> **经验法则**：**CI 抓接口/边界漂移，评审抓语义漂移**。两者互补，缺一不可。

---

## 两级拆解原理

**第一级（你拆，扇出前）= 卡级 issue**  
粒度 = **并行单元**（track 内小地基 + 各业务模块），即一人/一个 Agent 能在**半天到两天**收口的量。一个 plan 通常拆成"数十张卡级 issue"，而非数百个微任务。

**第二级（领卡的执行者来拆，领取后）= sub-issue**  
卡偏大时，由**领到它、已读完口径文档、具备完整上下文**的执行者，拆成 2–5 个子任务逐个执行。

**如何让执行者知道这个机制**：
- 该机制已写入 `parallel-dev-executor-multica` skill（Executor Skill）
- Worker 在认领 issue 后，执行协议第 3 步"按需拆解"会指导使用 sub-issue
- 使用 `multica issue create --parent <issue-id>` 创建子 issue
- 父 issue 不会被自动关闭，需要所有 sub-issue 完成后手工关闭

**你（orchestrator）的职责**：
- 第一级拆解：拆成并行单元（卡级 issue）
- 不要过度微拆：让执行者根据实际上下文进行第二级拆解

**为什么分两级**：  
微任务的正确拆法依赖实现上下文，**扇出前你并不具备**——此时硬拆出的子任务本身就是漂移源（拆错了，执行者照错的做）。所以"宏观骨架你定、微观切分交给有上下文的人"。

**判据**：  
- 卡太大（收不了口/跨多个数据归属）就再切一张卡
- 小到"一个函数"就别单独立卡（并入父卡或作 checklist 项）
- **宁可卡少而清晰，不要卡多而碎**

---

## 依赖三原则

### 1. 只把"真前置"设为硬依赖（blocked_by）

映射波次/track 依赖图：
- track 内小地基 → 该 track 全部业务卡
- 有先后的业务卡之间（如"主链"→"群聊/Loop"）
- 集成验收卡 → 全部业务卡

硬依赖即"上游没关，下游不可领"。

### 2. 软依赖只做提示，不设硬边

跨 track 的弱耦合（A 用 B 的产物但能先 mock）**别设成 blocked_by**——否则把本可并行的活锁成串行。

写进 description 作提示，留给执行者需要时自己收紧。

**硬边宁缺毋滥：每多一条假硬边，就少一分并行度。**

### 3. 节点内细分用描述，节点间协作用依赖

别混：内部分解由 worker 自己决定怎么拆，节点间依赖你在 manifest 显式声明。

---

## Issue 描述结构化模板

虽然 manifest 是 YAML，但创建 multica issue 时，**description 字段应遵循结构化模板**，使 worker/reviewer 能快速定位关键信息：

```markdown
## 工单卡 · <KEY> <名>

> 🎯 **目标**：<一句话交付物>

| 波次/track | 唯一口径文档(+节号) | 必守裁决 | 落点目录 |
|-----------|-------------------|---------|---------|
| Wave X / Track Y | docs/design.md §3 | D1, D5 | server/module/ |

### 🚧 范围边界（非目标）
- 不做 XXX（防 scope 蔓延，头号跑偏源）
- 不改 YYY

### 必消费契约（禁重定义）
- `shared/contracts/events.py` 的 `UserCreatedEvent`
- `shared/contracts/dto.py` 的 `UserDTO`

### 📚 参考锚点
- 契约源：`shared/contracts/`
- 假件范例：`tests/fakes/mock_auth.py`
- API 规范：`docs/api-spec.md`

### 依赖
- blocked_by: `foundation-setup`, `contracts-freeze`

### 🚫 红线
- 禁止直接操作 `users` 表，必须经 `UserRepository`
- 禁止上传会话内容到企业端
- 禁止使用已废弃的 `/api/legacy/*` 路径

### ✅ 验收（可验证）
- [ ] 单元测试全绿（`pytest tests/unit/module/`）
- [ ] 契约测试通过（`pytest tests/contracts/`）
- [ ] PR 已产出，链接：_____

### 🧪 测试落点
- `tests/unit/module/test_feature.py`
- `tests/integration/test_module_integration.py`

### 🤖 执行协议
Worker/Reviewer 执行协议详见 `parallel-dev-executor-multica` skill（Executor Skill）。
```

**关键**：
- **指针优于正文**：口径指向唯一文档+节号，绝不在卡里复述设计内容（会与源漂移）
- **约束/红线/非目标前置且显著**：能不能被遵守，取决于够不够显眼
- **过程也要写**：分支基线、验证与关闭方式写进执行协议

---

## 与 Executor Skill 的关系

Worker/Reviewer 通过 `parallel-dev-executor-multica` skill 知道：
- 从 issue metadata 读配置（worker/gate/blocked_by）
- Worker 8 步执行清单：认领前检查 → 读全口径 → 按需拆解 → 切分支 → TDD 实现 → 验收自查 → 提交与写证据 → 转 in_review
- Reviewer 6 步执行清单：接手前检查 → 读取证据 → 独立复跑验证（收活铁律）→ 质量审查 → 判决 → 写回
- 产 PR → 写证据（metadata.artifacts）
- Reviewer 复跑测试 → 判 verdict（metadata.review_verdict）

你（leader）只负责：
- **拆解**（从设计文档 → manifest DAG）
- **编排**（跑 run_dag.py）
- **监督**（引擎自动）
- **记录进度**（comment 到 issue）
- **失败决策**（调整 manifest）
- **收尾**（汇总 digest）

**不要抢 worker 的活**——你不写实现代码，只拆图、派工、盯进度、记录进展。

---

## 与 Executor Skill 的关系

Worker/Reviewer 通过 `parallel-dev-executor-multica` skill 知道:
- 从 issue metadata 读配置(worker/gate/blocked_by)
- TDD 实现 → 产 PR → 写证据(metadata.artifacts)
- Reviewer 复跑测试 → 判 verdict(metadata.review_verdict)

你(leader)只负责:
- **拆解**(从设计文档 → manifest DAG)
- **编排**(跑 run_dag.py)
- **监督**(引擎自动)
- **失败决策**(调整 manifest)
- **收尾**(汇总 digest)

**不要抢 worker 的活**——你不写实现代码,只拆图、派工、盯进度。

---

## 拆解检查清单

写完 manifest 后自查:

**结构检查**:
- [ ] Wave 0(地基)已识别且串行(contracts/scaffold/mock)
- [ ] Wave 1 按 track 划分,track 间并行
- [ ] 每个 track 内小地基先于业务模块
- [ ] Wave 2 集成验收依赖全部 Wave 1
- [ ] 所有 depends_on 引用存在(无悬空依赖)

**依赖检查**:
- [ ] 只设"真前置"为硬依赖(假硬边会减少并行度)
- [ ] 软依赖只在 description 提示
- [ ] 无循环依赖(lint 会检查)

**成员检查**:
- [ ] 所有 worker∈squad members
- [ ] reviewer(如有)∈squad 且≠worker
- [ ] 按 agent 特长分配(codex→后端,claude→前端)

**验收检查**:
- [ ] Wave 0 + Wave 2 有 reviewer
- [ ] 高风险节点有 reviewer + gate
- [ ] description 明确交付物

---

## 禁止事项

1. ❌ 不要手工改 issue metadata(compile 单向写入,引擎只读)
2. ❌ 不要跳过 lint(manifest 错误会导致引擎行为异常)
3. ❌ 不要在引擎运行中手工改 issue status(会破坏状态机)
4. ❌ 不要混用本机制与 kanban 看板机制(两套并行,按基底择一)
5. ❌ 不要自己实现循环逻辑(引擎是固定的,你只负责拆解)
6. ❌ 不要拆成数百微任务(粒度=并行单元,半天~两天可收口)

---

## 当前状态

- ✅ Phase 0 pilot 完成(worker 能产 PR,环境能跑引擎)
- ✅ Phase 1 逻辑核完成(7 脚本 + 21 测试全绿)
- ✅ Phase 2 入口已补齐(run_dag.py)
- ⏸ 待端到端冒烟(真实 2-3 节点 manifest)

---

## 快速上手

当你收到编排任务:

**1. 读设计文档,识别地基**
- 共享契约在哪?
- 底座组件有哪些?
- 骨架与 CI 怎么建?

**2. 写 manifest.yaml**
```yaml
squad: cf383144-1e6a-4beb-b988-39ae87f1c68c
nodes:
  contracts: {worker: codex-ubuntu, description: "..."}
  scaffold: {worker: claude-macmini, depends_on: [contracts], description: "..."}
  # ... Wave 1 并行 track
  e2e: {worker: codex-ubuntu, reviewer: hermes-reviewer, depends_on: [...全部], description: "..."}
```

**3. 跑引擎**
```bash
python orchestration/scripts/run_dag.py /tmp/my-feature.yaml
```

**4. 监督 + 失败决策**
- 引擎自动派发、轮询
- failed? 调整 manifest、重跑

**5. 汇总收尾**
- 输出 digest
- 写决策日志
- 向用户汇报

就这么简单。你的价值在**拆解质量**和**失败决策**,引擎是固定的。

---

## 核心信念与设计哲学

在拆解任务前，牢记这5条核心信念：

1. **跑偏不能靠"提醒"治，要靠"结构"治**  
   "记得看文档"不可靠；让错误的写法编译不过/测试不过/合并不了，才可靠。

2. **接口是地基，不是产物**  
   模块间的契约（数据结构、事件、错误、状态、跨服务调用）必须**先于**业务实现冻结，且以**代码**形式存在。

3. **对端可以是假的**  
   只要契约冻结，每个模块都能对着对端的 mock/fake 独立开发，无需等对端做完——这是并行度的来源。

4. **单一事实源**  
   每条口径只有一个权威出处（一段代码或一篇文档），其它地方引用它，禁止平行拷贝（拷贝必然漂移）。

5. **"完成"必须有客观证据**  
   不是"我觉得没问题"，而是测试/构建/接口调用通过。

---

## 防跑偏三层模型

把"防跑偏"拆成三层，越靠上越硬、越早生效：

| 层 | 防什么偏 | 手段 | 偏了会怎样 |
|---|---|---|---|
| **接口层** | 模块间对接不一致（DTO/事件/枚举/错误/调用形状） | **契约即代码**：共享类型包，下游只 import、禁重定义 | 类型/导入/契约测试不过——**偏不了** |
| **边界层** | 越过职责红线、用了被禁的旧口径、违反硬约束 | **CI 闸门**：边界扫描 + 契约不变量测试 + 质量门禁 | 当场红灯——**偏了立刻知道** |
| **语义层** | 接口对、约束没违反，但实现意图跑偏了设计 | **独立评审**：非实现者对照"设计文档 × 约束"逐条核对 | 合并被打回——**兜底** |

> **经验法则**：**CI 抓接口/边界漂移，评审抓语义漂移**。两者互补，缺一不可。

---

## 两级拆解原理

**第一级（你拆，扇出前）= 卡级 issue**  
粒度 = **并行单元**（track 内小地基 + 各业务模块），即一人/一个 Agent 能在**半天到两天**收口的量。一个 plan 通常拆成"数十张卡级 issue"，而非数百个微任务。

**第二级（领卡的执行者来拆，领取后）= sub-issue**  
卡偏大时，由**领到它、已读完口径文档、具备完整上下文**的执行者，拆成 2–5 个子任务逐个执行。

**如何让执行者知道这个机制**：
- 该机制已写入 `parallel-dev-executor-multica` skill（Executor Skill）
- Worker 在认领 issue 后，执行协议第 3 步"按需拆解"会指导使用 sub-issue
- 使用 `multica issue create --parent <issue-id>` 创建子 issue
- 父 issue 不会被自动关闭，需要所有 sub-issue 完成后手工关闭

**你（orchestrator）的职责**：
- 第一级拆解：拆成并行单元（卡级 issue）
- 不要过度微拆：让执行者根据实际上下文进行第二级拆解

**为什么分两级**：  
微任务的正确拆法依赖实现上下文，**扇出前你并不具备**——此时硬拆出的子任务本身就是漂移源（拆错了，执行者照错的做）。所以"宏观骨架你定、微观切分交给有上下文的人"。

**判据**：  
- 卡太大（收不了口/跨多个数据归属）就再切一张卡
- 小到"一个函数"就别单独立卡（并入父卡或作 checklist 项）
- **宁可卡少而清晰，不要卡多而碎**

---

## 依赖三原则

### 1. 只把"真前置"设为硬依赖（blocked_by）

映射波次/track 依赖图：
- track 内小地基 → 该 track 全部业务卡
- 有先后的业务卡之间（如"主链"→"群聊/Loop"）
- 集成验收卡 → 全部业务卡

硬依赖即"上游没关，下游不可领"。

### 2. 软依赖只做提示，不设硬边

跨 track 的弱耦合（A 用 B 的产物但能先 mock）**别设成 blocked_by**——否则把本可并行的活锁成串行。

写进 description 作提示，留给执行者需要时自己收紧。

**硬边宁缺毋滥：每多一条假硬边，就少一分并行度。**

### 3. 节点内细分用描述，节点间协作用依赖

别混：内部分解由 worker 自己决定怎么拆，节点间依赖你在 manifest 显式声明。

---

## Issue 描述结构化模板

虽然 manifest 是 YAML，但创建 multica issue 时，**description 字段应遵循结构化模板**，使 worker/reviewer 能快速定位关键信息：

```markdown
## 工单卡 · <KEY> <名>

> 🎯 **目标**：<一句话交付物>

| 波次/track | 唯一口径文档(+节号) | 必守裁决 | 落点目录 |
|-----------|-------------------|---------|---------|
| Wave X / Track Y | docs/design.md §3 | D1, D5 | server/module/ |

### 🚧 范围边界（非目标）
- 不做 XXX（防 scope 蔓延，头号跑偏源）
- 不改 YYY

### 必消费契约（禁重定义）
- `shared/contracts/events.py` 的 `UserCreatedEvent`
- `shared/contracts/dto.py` 的 `UserDTO`

### 📚 参考锚点
- 契约源：`shared/contracts/`
- 假件范例：`tests/fakes/mock_auth.py`
- API 规范：`docs/api-spec.md`

### 依赖
- blocked_by: `foundation-setup`, `contracts-freeze`

### 🚫 红线
- 禁止直接操作 `users` 表，必须经 `UserRepository`
- 禁止上传会话内容到企业端
- 禁止使用已废弃的 `/api/legacy/*` 路径

### ✅ 验收（可验证）
- [ ] 单元测试全绿（`pytest tests/unit/module/`）
- [ ] 契约测试通过（`pytest tests/contracts/`）
- [ ] PR 已产出，链接：_____

### 🧪 测试落点
- `tests/unit/module/test_feature.py`
- `tests/integration/test_module_integration.py`

### 🤖 执行协议
见下方 Worker 执行协议。
```

**关键**：
- **指针优于正文**：口径指向唯一文档+节号，绝不在卡里复述设计内容（会与源漂移）
- **约束/红线/非目标前置且显著**：能不能被遵守，取决于够不够显眼
- **过程也要写**：分支基线、验证与关闭方式写进执行协议

---

## Worker 执行协议

当 worker 被派发到一个 issue 时，按以下 8 步执行：

### 1. 认领
- 原子认领（将 issue 状态改为 `in_progress`）
- **先确认 blocked_by 全 closed**（检查依赖 issue 状态）

### 2. 读全
- 打开 issue description 中的**唯一口径文档全文**
- 打开全局约束（项目的 `CLAUDE.md`/`AGENTS.md`）
- 冲突一律以设计文档为准

### 3. 拆解（按需）
- 小则直接做
- 大则拆 2–5 个内部步骤（自己记录或在 issue comment 列 checklist）

### 4. 分支
- 从 **<集成分支>** 切工作分支（⚠️ 不是默认主分支）
- 建议用 `git worktree` 隔离

### 5. 实现
- **只 import 共享契约**；禁止重定义
- **守红线与非目标**

### 6. 验证
- 勾完验收清单
- 证据贴到 issue comment（测试输出、接口调用截图）

### 7. 提交
- `PR base` **显式指向 <集成分支>**（⚠️ 绝不打到主干）
- 过 CI + 独立评审

### 8. 关闭
- 合并后关闭本 issue
- 下游自动解锁

**完成判定铁律**：  
必须装全依赖 + 跑**全量测试套件**（不只跑本模块），绝不只跑子集。真实教训：worker 在新 worktree 只装本模块依赖、只跑本模块用例，缺依赖致跨模块测试被静默跳过，误判"全绿完成"。

---

## Reviewer 执行协议

当 reviewer 被派发时，按以下步骤执行：

### 0. 只读共享态
- 用 `git diff <集成分支>...<工作分支>` / `git show <ref>:<path>` 审阅
- ⚠️ **绝不在共享主工作树 reset/checkout/merge**（编排者可能正在那里集成，你一动就冲掉它）
- 要跑测试就进被审分支自己的 worktree 里跑

### 1. 读工单
- 读 issue description（目标/必消费契约/红线/范围边界/验收/唯一文档）
- 读唯一文档
- 读 `CLAUDE.md`/`AGENTS.md`

### 2. 审 diff 逐条核对
- 契约只 import 未重定义？
- 守红线/非目标？
- 未触禁区？
- 语义未漂移？
- 分层规范？

### 3. 契约存在性核对
- 对「必消费契约」清单 grep 契约文件确认其**已冻结**
- 区分"该 import 却自造"（违规）与"契约尚未定义的合理本地占位"（放行）

### 4. 验收↔测试映射（强制产出表格）
- 每条「验收」锚定到具体 test 函数
- 无对应 = 覆盖缺口

### 5. 独立复跑测试
- 在被审分支 worktree 跑测试命令
- 必须全绿才能 approve

**输出**：  
- `APPROVE` / `REQUEST_CHANGES` + 具体问题（文件:行 + 为什么 + 建议）
- 只读不改代码

---

## 派活/收活/合并纪律

### 派活铁律（防跑偏）
派出的 worker 必须：
- 只 import 共享契约、禁重定义
- 守红线/非目标
- 从集成分支切
- PR base 指向集成分支
- 过 CI + 独立评审才允许关闭

**关闭前必须过闸**（这是不做"全自动无人闭环"的关键，保留验证兜底）。

### 收活铁律（真实教训）
Orchestrator 拿到 worker 回报、决定"过闸还是打回"前，**先 `git diff <集成分支>...<工作分支>` 看真实改动 + 跑测试**，绝不只凭 worker 那段 prose 总结判断。

两类双向偏差都真实发生过：
- ① worker 把"docs-only/零行为改动"写进总结，实际分支上一条 commit 已含完整修复（差点错误打回/重做好工作）
- ② worker 宣称"全绿完成"，实际只跑了本卡子集、缺依赖致跨模块用例静默跳过（差点放进坏代码）

**回报只是线索，diff 与测试才是事实。**

### 合并纪律（避免并发踩踏）
Orchestrator 的**试合并、解冲突、合入都在专用集成 worktree 做**（`git worktree add ../integ <集成分支>`），**绝不在共享主工作树留半成品 merge 态**——并发的 reviewer 会读到脏主树、甚至误 `git reset --hard` 冲掉你未提交的工作。

Reviewer 侧对应铁律：只读共享态、不动主树（见 Reviewer 执行协议第 0 步）。

两边一起守，并发才安全。

---

## 常见误区清单

拆解和执行时，避免以下11条常见误区：

### 误区 1：跳过 Wave 0 直接并行
**最常见的失败**。没有冻结契约就扇出 = 各自发明接口 = 集成地狱。

### 误区 2：契约写成文字而非代码
文字契约挡不住漂移；必须是可 import、可测试的类型。

### 误区 3：地基追求"实现完整"
地基要的是"形状对、可对接、可测试"，真实重实现（如真数据库、真加密）可以留占位、标注归属到具体业务工单——**地基定形状，业务填实现**。

### 误区 4：边界扫描过度，误报淹没真报
要排除文档/注释里的"反向说明"，否则团队会习惯性忽略红灯。

### 误区 5：一张工单背多份文档
Agent/人都会被稀释注意力；**一卡一口径**。

### 误区 6：扇出前就把卡拆到微任务
微拆依赖实现上下文，扇出前不具备；硬拆 = 制造漂移源。宏观卡级你定，微观交给领卡的人。

### 误区 7：把软依赖也设成硬 blocked_by
会把本可并行的活锁成串行；硬边只留真前置，软耦合写进参考锚点。

### 误区 8：在 issue description 里复述设计内容
会与设计文档漂移；description 只放指针（唯一文档+节号），不放正文。

### 误区 9：不写非目标
**最隐蔽的越界源**——执行者会顺手把相邻卡的活也做了；范围边界必须显式。

### 误区 10：不钉 PR 基线分支
默认主分支常是 master，自助 Agent 会误把 PR 打上主干；执行协议必须显式写出集成分支。

### 误区 11：Orchestrator 抢 worker 的活
你只负责拆、派、盯、收，不要自己去实现业务代码或改契约。共享 infra 的 bug 由你集中修，但业务实现归 worker。

### 限制
契约不稳定的探索期不适用——先用原型把契约探明，再进入本方法。契约本身改动属高风险操作，需评审，不能随手改。

---

## 七道防跑偏闸（落地清单）

按"越早越硬"排序，按项目选用、可叠加：

1. **契约即代码**  
   共享类型包；下游只 import、禁平行定义。接口漂移 → 编译/类型/测试不过。

2. **单文档单负责人工单**  
   一卡一口径，约束前置（见 Issue 描述模板）。

3. **常驻护栏**  
   把全局核心约束放进"每次都会被加载"的地方（如 `CLAUDE.md`/`AGENTS.md`），而不是埋在长文档里。

4. **小任务粒度**  
   任务切到"一两个文件、可短时收口"。跑着跑着才会偏，不给它跑远的机会；配检查点推进。

5. **客观 CI 闸门**  
   把硬约束变成测试：
   - **契约不变量测试**：枚举取值、事件类型集合、必填字段等被悄改即红（"漂移守卫"）
   - **边界扫描**：禁用的旧路径/旧标识/旧 env/越界 import 等，grep/AST 扫描，命中即红（注意排除文档/注释里的"反向说明"）
   - **质量门禁**：接口 schema、唯一 id、错误覆盖、产物隔离等
   - **关键不变量 e2e**：隔离、隐私、parity 等，先以占位 skip 钉死"要验什么、归哪波、对哪份文档"，对应模块就绪后转正

6. **独立评审闸**  
   非实现者拿"模块 diff × 唯一口径文档 × 全局约束"逐条核对再合并。抓 CI 抓不到的语义漂移。

7. **完成前独立验证**  
   "完成"必须附证据（测试/构建/接口/parity），"我觉得可以"不算完成。

---



