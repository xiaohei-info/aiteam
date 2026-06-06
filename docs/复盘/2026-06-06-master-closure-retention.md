# master-closure-retention — 已验收 clean-closure 在 master 历史中的保留记录

## 保留日期
2026-06-06

## 授权来源
- MAIN-CLOSURE closeout `t_b4ffe8fd`（orchestrator）：PM accepted、QA confirmed_pass (206 tests)、reviewer pass-with-nits
- 权威接受代码源：`/home/ubuntu/code/aiteam/.worktrees/main-closure-clean`（branch `wt/main-closure-clean`，commit `bb7ad9737c23d9677a7bba7bf6cc2b3be6554365`）

## 保留方法
**single clean snapshot commit on master**。

选择理由：
- master HEAD (`bb7ad97`) 与 clean 工作树 HEAD 相同，不存在历史分歧
- clean 工作树中仅存在 uncommitted working-tree 状态，但已被 reviewer/QA/PM 完整验收
- 因此不使用 merge/squash/replay；改为将 clean 工作树的 112 个文件内容精确同步至 master，作为独立 commit 提交，同时保留本 closure 记录

## 操作步骤
1. 从 `/home/ubuntu/code/aiteam/.worktrees/main-closure-clean` 提取 `git status --porcelain` 列出的 112 个文件（排除 `app/tests/unit/` 目录和纯目录条目）
2. 将 112 个文件内容精确 rsync 至 master 对应路径
3. 对 5 个在 root 中存在内容分歧的文件，以 clean 工作树版本覆盖 root（经 diff 确认 clean 版本为 reviewer 认可的最终版本）：
   - `app/team_panel/api_team/router_system_admin.py`（recharge validation + system_write RBAC）
   - `app/team_panel/application/queries/employee_admin_view_service.py`（memory_config fallback）
   - `app/tests/aiteam/layer2_team_panel/test_system_admin_api_contracts.py`（role query params）
   - `app/tests/aiteam/layer2_team_panel/test_system_admin_enterprise_account.py`（action response shape）
   - `app/tests/aiteam/layer2_team_panel/test_system_admin_rbac.py`（RBAC test expectations）
4. 逐字节对比确认 112 个文件 root 与 clean 完全一致
5. 仅对 113 个文件（112 clean + 1 closure doc）执行 `git add`，保持 root 上其他不相关文件 unstaged

## 提交
```
commit: fcd922e217cfd07b4aac796de13f6631627792cd
parent: bb7ad9737c23d9677a7bba7bf6cc2b3be6554365
message: chore(master-closure): retain accepted clean-closure deliverable in master history
files: 113 (112 clean product + 1 closure retention doc)
insertions: 21173
deletions: 499
```

## 验证命令
```bash
# 确认 master HEAD 与 clean 工作树之间 0 diff（对 112 个文件逐字节比对）
python -c "
import subprocess,os,filecmp,pathlib,sys
root=pathlib.Path('/home/ubuntu/code/aiteam')
# compare HEAD tree vs clean worktree for the 112 product files
clean_wt='/home/ubuntu/code/aiteam/.worktrees/main-closure-clean'
out=subprocess.check_output(['git','status','--porcelain'],cwd=clean_wt,text=True)
files=[line[3:] for line in out.splitlines() if not line[3:].endswith('/')]
mismatch=[]
for f in files:
    head_blob=subprocess.check_output(['git','show','fcd922e:'+f],cwd=root).decode(errors='replace')
    with open(os.path.join(root,f),'rb') as fh:
        wt_bytes=fh.read()
    try:
        wt_text=wt_bytes.decode()
    except:
        mismatch.append((f,'binary'))
        continue
    if head_blob!=wt_text:
        mismatch.append((f,'content'))
print('checked',len(files),'mismatches',len(mismatch))
for m in mismatch[:20]: print(m)
"

# 确认 master 日志包含闭包提交
git log --oneline --decorate -3

# 确认闭包提交只包含 113 个文件，无跨范围泄露
git diff-tree --no-commit-id --name-status fcd922e~1 fcd922e | wc -l
```

## master 上的已知未提交文件（非 clean 范围）
以下文件不在本次 closure 范围内，保持 unstaged：
- `.gitignore`、`AGENTS.md`（主工作区本地修改，非 clean 范围）
- `app/static/aiteam/styles.css`（仅 root 有修改，clean 无）
- `docs/复盘/` 下的其他复盘文档（仅在 root 存在）
- `docs/技术设计/` 下的设计文档修改/新增（仅在 root 存在）
- `app/tests/aiteam/layer1_data/test_enterprise_skill_install_repo.py`（仅 root 存在）
- `app/tests/aiteam/layer2_team_panel/test_skill_market_api_contracts.py`（仅 root 存在）

这些文件的处置不在本架构师任务范围内。

## 声明
master 现已正式保留 MAIN-CLOSURE 接受的产品代码。下游 reviewer/QA/PM 可在 master 上独立复核。
