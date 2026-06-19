---
name: parallel-dev-orchestration
description: 把一份设计/plan 拆成"依赖相连的 GitHub issue DAG"，并用 orchestrate-tick 中轴命令驱动多 Agent 并行开发到收敛闭环。当需要把中大型多模块/多服务工程分解为可并行、可追踪、防跑偏的工单，并让多个 coding agent 协同推进时使用。
---

# 多 Agent 并行开发编排

把"**契约先行方法论 + GitHub issue DAG + orchestrate-tick 命令 + 多 coding agent**"合成一套可复现、可复用的闭环机制：用结构（契约/CI/评审）而非"提醒"来防跑偏，用依赖驱动的 issue 图最大化并行，用一条中轴命令让编排 Agent 低成本掌控全局进度。

> 完整"道"（为什么这么做）见 `docs/方法论/2026-06-19-契约先行的并行开发拆解方法论.md`。本 skill 是"术"——可直接照做的操作流程。

## 何时用 / 不用

- **用**：跨模块/跨服务、有清晰边界、有设计文档可依、需要多人或多 Agent 并行的中大型工程。
- **不用**：单人单模块小改、契约未稳的探索原型（先用原型把契约探明再进本流程）。

## 前提

- `gh ≥ 2.94`（原生 issue 依赖命令 `--blocked-by`/`--add-sub-issue` 与 `blockedBy` json）；`gh auth status` 已登录、有 `repo` scope。
- 一份冻结的设计/plan 作为**单一事实源**；散在多处的口径先收敛去重。
- **Superpowers 可选**：装了走捷径、没装按基线——本 skill 不强依赖任何插件（见「worker dispatch prompt」）。

## 三阶段流程

### 阶段 A — 打地基（Wave 0，串行，冻结后才并行）

按方法论 §3 产出"地基四件套"并用测试冻结：**共享契约（代码，下游只 import）+ 共享底座 + 可运行骨架 + CI 闸门/对端假件**。
判据：能写出每张工单卡、且卡里"必消费契约"已是可 import 的代码、"验收"已有（哪怕 skip 的）测试位——做不到就别扇出。

### 阶段 B — 把 plan 拆成 issue DAG（方法论 §6）

**1. 两级拆解**
- 第一级（你拆，扇出前）= **卡级 issue**：粒度 = 并行单元（track 内小地基 + 各业务模块），半天~两天可收口。数十张，别拆成数百微任务。
- 第二级（领卡者拆，领取后）= **sub-issue**：卡偏大时由有上下文的执行者用 `--parent` 拆 2–5 个。微拆交给有上下文的人，否则猜错=漂移源。

**2. 依赖三原则**
- 只把"真前置"设为硬依赖 `blocked-by`（小地基→该 track 全部业务卡；有先后的业务卡之间；集成验收卡→全部）。
- 软依赖只写进"参考锚点"作提示，**不设硬边**（每条假硬边都减少并行度）。
- 卡内分解用父子（`--parent`），卡间先后用依赖（`--blocked-by`）；别混。

**3. issue body 锚定结构**（body 是执行者唯一逐字读的东西，显著性决定遵守率）：

```
## 工单卡 · <KEY> <名>
> 🎯 目标：<一句话交付物>
| 波次/track | 唯一口径文档(+节号) | 必守裁决 | 落点目录 |   ← 指针，不复制正文
### 🚧 范围边界(非目标)   ← 防 scope 蔓延，头号跑偏源，必写
### 必消费契约(禁重定义)  ← 接口层防线
### 📚 参考锚点           ← 契约源/假件/只读旧实现参考/API规范/横切/裁决原文 的位置
### 依赖                 ← 指向原生 blocked-by
### 🚫 红线              ← 该模块最易踩的硬边界
### ✅ 验收(可验证)       ← 测试/接口/parity 证据，勾选项
### 🧪 测试落点
### 🤖 执行协议          ← 见下
```

**4. 执行协议**（把"怎么干"也钉进卡里，双通道：写进 body + 作为派发 prompt 模板）：

```
1 认领: gh issue edit <n> --add-assignee @me；先确认 blocked-by 全 closed
2 读全: 打开唯一口径文档全文 + 全局约束(CLAUDE.md/AGENTS.md)；冲突以设计文档为准
3 拆解(按需): 小则直接做；大则 gh issue create --parent <n> 拆 sub-issue
4 分支: 从<集成分支>切(⚠️不是默认主分支)，建议 git worktree 隔离
5 实现: 只 import 共享契约；守红线与非目标
6 验证: 勾完验收；证据贴 issue 评论
7 提交: gh pr create --base <集成分支>(⚠️绝不主干)；过 CI + 独立 reviewer agent
8 关闭: 合并后关卡 → 下游自动解锁
```

建 issue 示例：
```bash
gh issue create -R <repo> -t "[M1] 成员/授权" -F body.md -l wave1,track:M --blocked-by <M0号>
gh issue edit <n> --add-blocked-by <up>   # 后补硬依赖
gh issue create -R <repo> -t "[M0.1] 子任务" --parent <M0号> -l wave1,track:M -F sub.md
```

### 阶段 C — 用 orchestrate-tick 驱动闭环

命令在 `scripts/orchestrator/orchestrate.py`（详见其 README）。**机械观测/等待归命令，判断归编排 Agent。**

编排 Agent 的主循环：

```
loop:
  rc = orchestrate.py tick -R <repo> --timeout 600      # 阻塞，cheap，不烧 token
  DISPATCH(25):       从 digest 挑 ready(无 open blocker) → 原子认领(assign+label)
                      → 起 worktree 隔离的 coding agent，prompt = 下文「worker dispatch prompt」+ issue 号
  NEEDS_DECISION(20): 看 failures/deadlock → 重跑 / 编辑 issue body / --add-blocked-by 补依赖 / --parent 拆子卡
  CHANGED(0):         看 transitions，按需调整优先级
  TIMEOUT(10):        直接再 tick（可由极薄 wrapper 自动做，不惊动 Agent 推理）
  ALL_DONE(30):       收尾退出
```

随时"看全局进度"：`orchestrate.py status -R <repo>`（分 track/wave 进度、frontier、失败、transitions、关键路径、死锁/完成判定）。

**派活铁律**（防跑偏）：派出的 coding agent 必须按下文「worker dispatch prompt」干活——只 import 共享契约、守红线/非目标、从集成分支切、PR base 指向集成分支、过 CI + 独立评审才允许关闭。**关闭前必须过闸**（这是不做"全自动无人闭环"的关键，保留验证兜底）。

**合并/集成纪律（避免并发踩踏，首轮真实教训）**：orchestrator 的**试合并、解冲突、合入都在专用集成 worktree 做**（`git worktree add ../integ <集成分支>`），**绝不在共享主工作树留半成品 merge 态**——并发的 reviewer 会读到脏主树、甚至误 `git reset --hard` 冲掉你未提交的工作。reviewer 侧对应铁律见下「verifier dispatch」第 0 步：只读共享态、不动主树。两边一起守，并发才安全。

### worker dispatch prompt（派发时注入 worker，不进 issue body）

orchestrator 收到 `DISPATCH` 起 worker 时，把下面这份**基线 loop** materialize 进 worker 的 prompt（worker 可能是别的 coding agent、没装本 skill，所以正文必须随 prompt 给到它），末尾附 issue 指针。**loop 正文只在本 skill 留一份，绝不复制进 issue body**；`<集成分支>`/`<N>`/测试命令由 orchestrator 从 issue body 与项目配置代入。

> **集成分支是参数，不是常量**：orchestrator 启动时确定它 = 自己当前所在分支（`git rev-parse --abbrev-ref HEAD`）或显式配置，派发时代入 `<集成分支>`。**本 skill 绝不写死任何分支名**，对 master / main / develop / feature-x 等任何命名通用。

**第一步永远是能力检测**：worker 先判断自己有没有 Superpowers——
- **有** → 直接用对应 Superpowers skill（见映射表，battle-tested、更省事）；
- **没有** → 严格照下面基线自然语言流程执行，**目标完全一致**。

**基线 worker loop（工具无关，任何 coding agent 可独立执行）**
```
目标：把本 issue 的「验收」全部做到绿；做不到就如实报告，禁止假装完成。
1 认领+读全：读 issue body(目标/契约/红线/验收) + 它指向的唯一口径文档全文 + 仓库 CLAUDE.md/AGENTS.md；冲突一律以设计文档为准
2 隔离：**显式**从集成分支切——`git fetch origin && git switch -c <工作分支> origin/<集成分支>`。⚠️**别信任 worktree 的默认 base**(可能是仓库默认分支/旧 commit，不含你要改的内容)；切完先核验预期内容存在(如关键目录/契约)，缺失即说明集成分支参数错→停下报告
3 拆解(按需)：偏大则 `gh issue create --parent <n>` 拆 2–5 个 sub-issue，再逐个做
4 测试先行：按「验收」写/补测试，再最小实现；只 import 共享契约，守红线与非目标
5 反馈闸(每轮之间跑)：跑本 issue「测试落点」里的命令(如需建 venv，放在被扫描代码树之外，免得边界扫描误扫依赖包) → 红则修、循环；退出条件=绿；迭代上限=<N>；到顶仍红→停下报告，不强推
  ⚠️**完成判定必须装全依赖 + 跑全量 not-integration 套件，绝不只跑本卡子集**(真实教训：worker 在新 worktree 只装本模块依赖、只跑本模块用例，缺 fastapi 致 7 个跨模块测试 collection error 被静默跳过，误判"61 passed 已完成")。子集绿只是中途信号；交活前必须 `装全 requirements → pytest -m 'not integration'` 全绿。
6 PR：`gh pr create --base <集成分支>`（⚠️绝不主干）
7 CI 绿：轮询 CI(`gh run ...`)，修到绿或到上限
8 独立评审：交给"非实现者"的全新 agent 盲审(只看 diff×口径文档×红线，不看实现理由)；改到过
9 关闭：合并后关本卡 → 其下游自动解锁
```

**verifier / reviewer dispatch prompt（派发独立评审时注入，工具无关）**

闸的语义层：全新 agent（**非实现者**）盲审——**不看实现者自述/理由**，只凭客观产出判断语义是否偏离设计。派发时给足入口，免得它空耗在勘探环境（首轮教训）：

```
你是独立 reviewer，盲审工单 #N 的分支 <工作分支>。不读实现者自述。
0 只读共享态：用 `git diff <集成分支>...<工作分支>` / `git show <ref>:<path>` 审阅；
  ⚠️**绝不在共享主工作树 reset/checkout/merge**——编排者可能正在那里集成，你一动就冲掉它；
  要跑测试就进被审分支自己的 worktree(`git worktree list` 定位，或 `git worktree add` 新建)里跑。
1 读工单 #N(目标/必消费契约/红线/范围边界/验收/唯一文档) + 唯一文档 + CLAUDE.md/AGENTS.md。
2 审 diff 逐条核：契约只 import 未重定义？守红线/非目标？未触禁区？语义未漂移？分层规范？
3 契约存在性核对：对「必消费契约」清单 grep 契约文件确认其**已冻结**——区分"该 import 却自造"(违规)
  与"契约尚未定义的合理本地占位"(放行)。
4 验收↔测试映射(**强制产出表格**)：每条「验收」锚定到具体 test 函数；无对应=覆盖缺口。
5 独立复跑测试：探测 venv(`.venv/bin/python` 否则 fallback)，在被审分支 worktree 跑测试命令。
输出：APPROVE / REQUEST_CHANGES + 具体问题(文件:行 + 为什么 + 建议)。只读不改代码。
```

有 Superpowers 时用 `requesting-code-review` + `code-reviewer` agent，把上面"只读共享态/入口/映射表"要求一并带上。

> **共享 infra 由 orchestrator 集中改**：worker 若被共享 infra（契约 / 边界扫描 / CI / 事件协议等）的 bug 卡住，**报给 orchestrator 统一修，不在本卡分支擅改共享文件**——并行 worker 各改共享文件 = 合并冲突 + 口径分裂。

**Superpowers 映射（检测到才用，意图等价，不重复）**

| 基线步骤 | 对应 Superpowers skill |
|---|---|
| 2 隔离 | `using-git-worktrees` |
| 4 测试先行 | `test-driven-development` |
| 5 反馈闸 / 完成判定 | `verification-before-completion` |
| 6–7 PR / 合并 | `finishing-a-development-branch` |
| 8 独立评审 | `requesting-code-review` + `code-reviewer` agent（worker 侧 `receiving-code-review`） |
| 3 拆子卡 / 并行 | `subagent-driven-development` / `dispatching-parallel-agents` |

> 基线是唯一源，映射只是"有 Superpowers 就替换对应步骤"。没装也能按基线达成原目标，装了走捷径——**两者不重复、不强依赖**。

## 防跑偏三层（方法论 §2/§7）

接口层=契约即代码（偏不了）；边界层=CI 闸门（偏了红灯）；语义层=独立 reviewer（兜底）。CI 抓接口/边界漂移，评审抓语义漂移。

## 移植到新项目

```
[ ] 复制 docs/方法论/...契约先行...md（道）与 scripts/orchestrator/（术，命令 + 测试）
[ ] 确认 gh ≥2.94；建 label：wave1/wave2 + track:<X> + failed
[ ] Superpowers 可选：装了 worker 走捷径，没装按基线 loop——无需为此 skill 额外安装任何插件
[ ] 阶段 A 冻结地基四件套
[ ] 阶段 B 按本 skill 把 plan 拆成卡级 issue + blocked-by DAG + 锚定 body + 执行协议
[ ] 阶段 C 编排 Agent 跑 orchestrate-tick 主循环到 ALL_DONE
```

## 参考

- 方法论：`docs/方法论/2026-06-19-契约先行的并行开发拆解方法论.md`
- 命令与退出码/digest：`scripts/orchestrator/README.md`、`scripts/orchestrator/orchestrate.py`
- 实例：本仓 GitHub issues（`[KEY]` + wave/track label + blocked-by DAG）
