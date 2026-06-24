---
name: parallel-dev-orchestration
description: 把设计/plan 拆成声明式 manifest DAG,用固定引擎驱动多 Agent 并行开发到收敛闭环，采用 Harness 动态编排机制，支持 Multica/GitHub/Mock 等多种协作引擎
---

# 并行开发编排机制 (Orchestrator)

你作为 **leader**,在协作平台上编排并行开发任务时使用本 skill。

**核心**:契约先行方法论 + 声明式 manifest + 固定引擎 + 多引擎适配（Multica/GitHub/Mock）。

---

# 一、拆好 DAG（道与术）

这一部分讲「**怎么拆出一个能并行收敛的 DAG**」—— 这是 leader 的创造性工作。建议先读「方法论」理解道（为什么这样拆、怎样防跑偏），再按「三阶段流程」跑术（打地基 → 拆 DAG → 工单卡）；拆完用「拆解检查清单」自查。

## 方法论：拆好 DAG 与防跑偏（道）

> 三阶段流程的「术」（5 步操作 + 粒度/依赖速查）回答「**怎么拆**」。本节回答「**为什么这样拆、怎样防跑偏**」—— 遇到拿不准的拆图判断，回这里查判据。

### 核心信念

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

### 防跑偏三层模型

把"防跑偏"拆成三层，越靠上越硬、越早生效：

| 层 | 防什么偏 | 手段 | 偏了会怎样 |
|---|---|---|---|
| **接口层** | 模块间对接不一致（DTO/事件/枚举/错误/调用形状） | **契约即代码**：共享类型包，下游只 import、禁重定义 | 类型/导入/契约测试不过——**偏不了** |
| **边界层** | 越过职责红线、用了被禁的旧口径、违反硬约束 | **CI 闸门**：边界扫描 + 契约不变量测试 + 质量门禁 | 当场红灯——**偏了立刻知道** |
| **语义层** | 接口对、约束没违反，但实现意图跑偏了设计 | **独立评审**：非实现者对照"设计文档 × 约束"逐条核对 | 合并被打回——**兜底** |

> **经验法则**：**CI 抓接口/边界漂移，评审抓语义漂移**。两者互补，缺一不可。

---

### 七道防跑偏闸（落地清单）

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

### 两级拆解原理

**第一级（你拆，扇出前）= 卡级 issue**  
粒度 = **并行单元**（track 内小地基 + 各业务模块），即一人/一个 Agent 能在**半天到两天**收口的量。一个 plan 通常拆成"数十张卡级 issue"，而非数百个微任务。

**第二级（领卡的执行者来拆，领取后）= sub-issue**  
卡偏大时，由**领到它、已读完口径文档、具备完整上下文**的执行者，拆成 2–5 个子任务逐个执行。

**如何让执行者知道这个机制**：
- 该机制已写入 `parallel-dev-executor` skill（Executor Skill）
- Worker 在认领 issue 后，执行协议第 3 步"按需拆解"会指导使用 sub-issue
- 子任务创建由 worker 在执行侧按引擎能力完成（orchestrator 不直接操作底层引擎）
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

### 依赖三原则

**1. 只把"真前置"设为硬依赖（blocked_by）**

映射波次/track 依赖图：
- track 内小地基 → 该 track 全部业务卡
- 有先后的业务卡之间（如"主链"→"群聊/Loop"）
- 集成验收卡 → 全部业务卡

硬依赖即"上游没关，下游不可领"。

**2. 软依赖只做提示，不设硬边**

跨 track 的弱耦合（A 用 B 的产物但能先 mock）**别设成 blocked_by**——否则把本可并行的活锁成串行。

写进 description 作提示，留给执行者需要时自己收紧。

**硬边宁缺毋滥：每多一条假硬边，就少一分并行度。**

**3. 节点内细分用描述，节点间协作用依赖**

别混：内部分解由 worker 自己决定怎么拆，节点间依赖你在 manifest 显式声明。

---

### 常见误区清单

拆解和执行时，避免以下11条常见误区：

**误区 1：跳过 Wave 0 直接并行**
最常见的失败。没有冻结契约就扇出 = 各自发明接口 = 集成地狱。

**误区 2：契约写成文字而非代码**
文字契约挡不住漂移；必须是可 import、可测试的类型。

**误区 3：地基追求"实现完整"**
地基要的是"形状对、可对接、可测试"，真实重实现（如真数据库、真加密）可以留占位、标注归属到具体业务工单——**地基定形状，业务填实现**。

**误区 4：边界扫描过度，误报淹没真报**
要排除文档/注释里的"反向说明"，否则团队会习惯性忽略红灯。

**误区 5：一张工单背多份文档**
Agent/人都会被稀释注意力；**一卡一口径**。

**误区 6：扇出前就把卡拆到微任务**
微拆依赖实现上下文，扇出前不具备；硬拆 = 制造漂移源。宏观卡级你定，微观交给领卡的人。

**误区 7：把软依赖也设成硬 blocked_by**
会把本可并行的活锁成串行；硬边只留真前置，软耦合写进参考锚点。

**误区 8：在 issue description 里复述设计内容**
会与设计文档漂移；description 只放指针（唯一文档+节号），不放正文。

**误区 9：不写非目标**
**最隐蔽的越界源**——执行者会顺手把相邻卡的活也做了；范围边界必须显式。

**误区 10：不钉 PR 基线分支**
默认主分支常是 master，自助 Agent 会误把 PR 打上主干；执行协议必须显式写出集成分支。

**误区 11：Orchestrator 抢 worker 的活**
你只负责拆、派、盯、收，不要自己去实现业务代码或改契约。共享 infra 的 bug 由你集中修，但业务实现归 worker。

**限制**：契约不稳定的探索期不适用——先用原型把契约探明，再进入本方法。契约本身改动属高风险操作，需评审，不能随手改。

---

## 三阶段流程 · 阶段 A + B（术：每一步做什么）

> 阶段 C「执行编排」属于跑起来环节，见本文第二部分。

### 阶段 A — 打地基 (Wave 0,串行)

按方法论「核心信念」产出"地基四件套":
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
squad: <workspace-id>
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

> **「道」与「术」**：本节是 **术** —— 给你可直接照做的 5 步拆图操作。背后 **为什么这样拆**（核心信念、防跑偏三层模型、两级拆解/依赖三原则的原理、常见误区）是 **道**，写在文末「方法论：拆好 DAG 与防跑偏」一节。先把术跑顺，遇到拿不准的再回道里查判据。

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
- `squad`: workspace ID（manifest 的 workspace 标识，具体取值由所选引擎决定）
- `nodes.<key>.worker`: worker agent 名(必须∈workspace agents)
- `nodes.<key>.reviewer`: reviewer agent 名(可选,非空时必须≠worker)
- `nodes.<key>.depends_on`: 依赖节点 key 列表(空 = Wave 0 可立即开始)
- `nodes.<key>.gate`: 自定义验收条件(可选,默认="测试全绿")

#### 粒度与依赖（拆图规则速查）

拆图时把握「粒度」和「依赖」两条线，原则详见「方法论」节（道），这里只给落进 manifest 的速查口径（术）：

- **粒度**：一个节点 = 一个并行单元（track 内小地基 / 一个业务模块），半天~两天可收口。你只拆第一级（卡级），第二级（卡内细分）交给领卡的执行者拆。
- **依赖**：只把「真前置」设硬边 `depends_on`（小地基→业务模块；Wave 0→Wave 1→Wave 2）；软耦合只写进 description 提示，**不设硬边**（每条假硬边都减少并行度）。

#### Agent 选择（按 role 字段）

从 workspace agents 中按 role 字段选择（**不要写死 agent 名字**）。

**查询 agents**：
- workspace 中的 agent 列表由用户提供，或从团队配置中获取
- 不要直接调用底层引擎 CLI 去查询 —— 你的入口是 `run_dag.py`

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

## Issue 描述结构化模板

虽然 manifest 是 YAML，但创建 work item 时，**description 字段应遵循结构化模板**，使 worker/reviewer 能快速定位关键信息：

```markdown

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

# 二、跑起来 & 工具用法

manifest 写好后，这部分讲「**怎么把它跑起来、出问题怎么处理、怎么收尾**」—— 工具用法与执行纪律。

---

## 执行编排（阶段 C — 跑引擎）

保存 manifest 后,执行本 skill 附带的引擎脚本:

### 启动与管理 run

```bash
# 查看完整用法
python scripts/run_dag.py --help

# 常用操作（具体参数见 --help）：
# - 新启动：指定 manifest 文件和引擎配置
# - 续跑：使用 --resume <run-id>
# - 查看状态：列出所有 run 及其进度
```

引擎会自动：
- ✅ Lint manifest（校验依赖/agent 池/无环）
- ✅ 创建/查找 issues（每个节点对应一个 issue）
- ✅ 编译 metadata（blocked_by/worker/reviewer）
- ✅ 计算 frontier 并派发
- ✅ 轮询 runs 直到完成
- ✅ 自动 comment 进度（带 ASCII 进度条）
- ✅ 失败隔离（阻塞下游）
- ✅ 保存状态快照（支持断点续跑）

### 进度报告示例

引擎会自动生成类似这样的进度报告：

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 整体进度 [████████████░░░░░░░░] 12/15 (80.0%)
⏱️  已用时间: 2h 34m | 预计剩余: 38m
✅ 完成: 12 | 🔄 进行中: 1 | ⏸️  待开始: 2 | ❌ 失败: 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 断点续跑

引擎支持随时中断和续跑。使用 `python scripts/run_dag.py --help` 查看续跑相关参数。

**注意**：scripts 目录及其所有 Python 文件已作为本 skill 的附件上传，当你加载此 skill 时可直接访问。

**引擎会自动**:
1. **Lint 校验**(无环、worker∈池、reviewer≠worker)
2. **创建 work items**(如果不存在,通过 title 匹配 key)
3. **编译 metadata**(blocked_by/worker/reviewer → work item metadata)
4. **循环监督**:
   - 计算 frontier(ready 节点 = todo 且依赖全 done)
   - 派发 worker(自动 assign)
   - 轮询 runs 到终态
   - 检查 PR(从 metadata.artifacts 读)
   - 派发 reviewer(如有)
   - done 或 failed
5. **输出 digest**: `done: [oauth-setup, jwt-service, ...], failed: []`

**你不需要写循环逻辑**——引擎是固定的,你的价值在拆解质量和失败决策。

---

## 处理失败与重试

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

## 收尾(Closeout)

全 done 或你判断可收尾时:
1. **汇总 digest**:
   - 哪些 done、哪些 failed
   - PR 链接列表
   - 已知问题与限制
2. **写决策日志**:
   - 引擎已把运行过程记录到 work item 的事件日志，你只需汇总digest 向用户汇报
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

## 脚本清单(作为 skill 附件)

本 skill 自带编排引擎，包结构按职责分层（你只跑 `run_dag.py`，其余是引擎内部实现）：

- `scripts/run_dag.py`: CLI 入口 ★ **这是你要跑的**
- `scripts/core/`: 核心编排逻辑 — `manifest.py`(数据模型+YAML加载) / `compile.py`(manifest→metadata 编译) / `graph.py`(frontier 算法+失败隔离) / `lint.py`(校验:无环/无孤儿/worker∈池) / `models.py`(引擎状态) / `progress.py`(进度报告)
- `scripts/engines/`: 引擎适配层 — `base.py`(抽象接口) / `models.py`(Run/WorkItem 等数据模型) / `multica.py` / `github.py` / `mock.py`（三种协作平台实现）
- `scripts/clients/multica.py`: Multica CLI 客户端封装
- `scripts/utils.py`: 通用工具函数

加载本 skill 后这些脚本可直接访问和执行。

---

## 派活与合并纪律（leader 视角）

### 派活铁律（防跑偏）
派出的 worker 必须：
- 只 import 共享契约、禁重定义
- 守红线/非目标
- 从集成分支切
- PR base 指向集成分支
- 过 CI + 独立评审才允许关闭

**关闭前必须过闸**（这是不做"全自动无人闭环"的关键，保留验证兜底）。复跑测试、看 diff 的具体动作由 reviewer 执行（详见 `parallel-dev-executor` skill 收活铁律）；你这边只需记住：**worker 的回报只是线索，最终以 reviewer 判决与引擎状态为准**，不要凭 worker 的 prose 总结就放行。

### 合并纪律（避免并发踩踏）
你的**试合并、解冲突、合入都在专用集成 worktree 做**（`git worktree add ../integ <集成分支>`），**绝不在共享主工作树留半成品 merge 态**——并发的 reviewer 会读到脏主树、甚至误 `git reset --hard` 冲掉你未提交的工作。

Reviewer 侧对应铁律：只读共享态、不动主树（见 `parallel-dev-executor` skill 的"只读共享态铁律"）。两边一起守，并发才安全。

---

## 与 Executor Skill 的关系

Worker/Reviewer 通过 `parallel-dev-executor` skill 知道:
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

## 禁止事项

1. ❌ 不要手工改 issue metadata(compile 单向写入,引擎只读)
2. ❌ 不要跳过 lint(manifest 错误会导致引擎行为异常)
3. ❌ 不要在引擎运行中手工改 issue status(会破坏状态机)
4. ❌ 不要混用本机制与 kanban 看板机制(两套并行,按基底择一)
5. ❌ 不要自己实现循环逻辑(引擎是固定的,你只负责拆解)
6. ❌ 不要拆成数百微任务(粒度=并行单元,半天~两天可收口)

---

