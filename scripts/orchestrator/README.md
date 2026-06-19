# orchestrate —— 多 Agent 并行开发中轴命令

把"方法论 + GitHub issue DAG + Agent"闭合成可推进的执行环。命令本身只做两件确定性的事:
**① 输出整张任务图的全局进度真相；② 阻塞等待"值得决策的变化"或超时，用退出码告诉外层怎么继续。**

判断/编排留给 Agent，机械观测/等待留给命令——这正是"省 token 的事件驱动"分工。

## 前提

- `gh ≥ 2.94`（原生 issue 依赖 `blockedBy`/`blocking`）。`gh auth status` 已登录、有 `repo` scope。
- issue 约定：标题前缀 `[KEY]`（如 `[M0]`）；label `wave1`/`wave2` + `track:X`；失败用 label `failed`。

## 用法

```bash
# 立即打印全局进度，退出（Agent 想"看一眼进度"时用）
python3 orchestrate.py status -R owner/repo

# 阻塞推进：有变化/需决策/超时即返回（loop 的每一拍）
python3 orchestrate.py tick -R owner/repo --timeout 600 --interval 20
```

可选参数：`--scope-label`（默认 `wave1,wave2`）、`--failed-label`（默认 `failed`）、
`--json`（机器可读 digest）、`--on-ready CMD`/`--on-failed CMD`（机械派发钩子，置则不再返回 DISPATCH）、
`--state PATH`（跨调用 diff 的快照文件，默认 `.tick-state.json`）。

## 退出码（外层据此驱动）

| 码 | 含义 | Agent 该做什么 |
|---|---|---|
| 0  | `CHANGED` 有进度变化 | 记录，正常继续 |
| 10 | `TIMEOUT` 在跑的仍在跑、无变化 | **无需推理**，直接再 `tick`（薄外层自动循环） |
| 20 | `NEEDS_DECISION` 有失败/死锁 | 决策：重跑 / 改 issue body / 补依赖 / 拆子卡 |
| 25 | `DISPATCH` 有 ready 且无自动派发钩子 | 认领 ready → 派 worktree agent → 再 `tick` |
| 30 | `ALL_DONE` 全部完成 | 收尾退出 |

## Agent + 命令的闭环（伪码）

```
loop:
  rc = run("orchestrate.py tick -R repo --timeout 600")   # 阻塞，cheap，不烧 token
  case rc:
    DISPATCH(25):       digest 里挑 ready → 原子认领(assign+label) → 派 worktree coding agent(prompt=该 issue 执行协议)
    NEEDS_DECISION(20): 看 failures/deadlock → 重跑 / 编辑 issue / --add-blocked-by 补依赖 / --parent 拆子卡
    CHANGED(0):         看 transitions，按需调整优先级
    TIMEOUT(10):        直接再 tick（可由极薄 wrapper 自动做，不惊动 Agent 推理）
    ALL_DONE(30):       结束
```

## digest 给了什么（全局掌控）

分 track/wave 的 done/in_progress/ready/blocked/failed 与百分比、当前 frontier（可领取 + 进行中）、
失败清单、自上次以来的 status 迁移（transitions）、**关键路径（最长未完成依赖链）**、死锁/完成判定。

## 测试

```bash
python3 test_orchestrate.py     # 纯逻辑离线测试(classify/digest/decide/normalize/关键路径)
```

> 方法论与"为什么这么设计"见 `docs/方法论/2026-06-19-契约先行的并行开发拆解方法论.md` §6。
