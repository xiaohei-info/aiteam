# deploy/ci —— PR merge 自动部署流水线

## 文件清单

| 文件 | 用途 | 何时改 |
|---|---|---|
| `deploy/ci/run.sh` | 切分支 + pull --ff-only + `ctl.sh restart` + `/healthz` 冒烟 | **不动**：所有支流共用 |
| `.github/workflows/deploy-feature-v1.0.0.yml` | `feature/v1.0.0` PR merge → taiyi 的绑定关系 | **仅**创建新支流 / 改路由时复制并改三件套 |
| `deploy/ci/README.md` | 本手册 | 新手指引 |

## 触发链（单线）

```
PR merged to feature/v1.0.0
        │
        ▼ on.pull_request (base.ref = feature/v1.0.0, merged == true)
  checkout code @ merge_commit
  write  GitHub Secret "ENV_CONTENTS_TEST" → .env.test (runner 上)
  bash deploy/ci/run.sh --branch feature/v1.0.0 --env test
        │
        ▼
  scripts/ctl.sh restart --env test   # 读 .env.test
  smoke /healthz on 8781 / 8782 / 8783
```

## 三件套（绑定义）

每个 `deploy-<branch>.yml` 把以下三处**写死**：

```
on.pull_request.branches      例: [feature/v1.0.0]
env.ENV_NAME                  例: test → 写 .env.test + 从 secret ENV_CONTENTS_TEST 读
jobs.deploy.runs-on           例: taiyi (self-hosted runner label)
```

分支切换就**复制 deploy-feature-v1.0.0.yml → deploy-<新分支>.yml，改这三处 + push**。

## 首次配置（每台机器一次）

### 1. 安装 self-hosted runner

在目标机器上（例：taiyi）：

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner-linux-x64-<version>.tar.gz -L <url-from-github-ui>
tar xzf actions-runner-linux-x64-<version>.tar.gz

# 去 repo Settings → Actions → New self-hosted runner，拿 URL + token
./config.sh --url https://github.com/<org>/<repo> --token <REDACTED>

# 让 runner reboot 后自启：
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status   # 应该显示 "Running"
```

### 2. 给 runner 打 label

Settings → Actions → Runners → 找到你的 runner → Edit labels：

- `taiyi`     （被 `deploy-feature-v1.0.0.yml` 引用）
- `self-hosted`（默认）

### 3. 在 GitHub 上配 secret

Settings → Secrets and variables → Actions → New repository Secret：

```
Name:  ENV_CONTENTS_TEST
Value: (整个 .env.test 文件的内容，包括换行 —— 原样粘贴)
```

多配几个就多几个环境的密钥：
```
ENV_CONTENTS_TEST   (taiyi 上的 .env.test)
ENV_CONTENTS_DEV    (machine-a 上的 .env.dev)
ENV_CONTENTS_ST     (machine-b 上的 .env.st)
ENV_CONTENTS_PROD   (machine-c 上的 .env.prod)
```

### 4. 保护规则（关键！避免 PR 合并到任意分支都跑部署）

在部署分支的保护规则（Settings → Branches → Branch protection rules）里：
- Pull request 合并**必须**：
  - "Require status checks to pass before merging" 加入 `deploy / deploy (feature/v1.0.0 → taiyi / .env.test)`
  - 这样只有绿色流水线通过后才能合并

## 新增一台机器 / 新环境

1. 在脚本机器装 self-hosted runner + 打 label（如 `next`）
2. 在 GitHub 上增加 secret：`ENV_CONTENTS_NEXT`
3. 创建新的 workflow yaml（例：`deploy-next-branch-name.yml`）——复制 `deploy-feature-v1.0.0.yml`，改三件套：

```
on.pull_request.branches: [next-branch-name]
env.ENV_NAME:             next → 写 .env.next + 从 ENV_CONTENTS_NEXT 读
jobs.deploy.runs-on:      next (self-hosted runner label)
```

4. push。

## 故障排查

| 现象 | 排查点 |
|---|---|
| PR merge 后 workflow 没跑 | 分支保护规则里有没有把 deploy 加入 required status checks？github 上 PR 页面下段 "checks" 栏能看到 |
| 跑但报 `empty secret` | ENV_CONTENTS_TEST 的 secret 内容是否完整？`\n` 是否保存？`.env.test` 是否有至少一个非空行？ |
| runner offline | `sudo ./svc.sh status`（在机器上）；UI Settings → Actions → Runners 看状态 |
| 冒烟失败 | 在 taiyi 上 `bash scripts/ctl.sh logs --env test` 看启动错误；通常是本地 `PGPASSWORD` 与 secret 里的值不匹配（需要修改 .env.test 内容 → 改 GitHub Secret） |
| 明文 .env 留在 runner 上 | 部署完成后残留的 `.env.{env}` 是明文——这是 runner 自己文件系统的事。若每次部署需要清理可在 run.sh 里加 `trap 'rm -f .env.${ENV_TARGET}' EXIT`；但当前保留它方便下次断电热启动 |

## Secret 安全 FAQ

Q: `echo … > .env.xxx` 会让 secret 暴露到 job log 吗？

A: **不会**。GitHub Actions 内置 secret masking：任何在 `${{ secrets.* }}` 出现过的字符串值，在 job log 里都会被 mask 成 `***`。官方声明的 mask 范围包括整个 appearances in the log output —— 所以 `cat .env.xxx` 在 job 里 `echo` 出来仍是 `***`，不会泄漏。
