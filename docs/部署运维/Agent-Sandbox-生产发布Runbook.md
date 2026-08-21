# Agent Sandbox 与生产发布 Runbook（P1.2/P2）

## 边界

- Agent coding tool 的 `bash/read/write/edit` 只能使用当前 conversation workspace；路径会先做 canonical/realpath 校验，bash 进程由 dsh runner 包裹。
- Linux 优先使用经功能探测的 `bwrap`，再尝试 Landlock；最终 spawn seam 额外关闭网络。macOS 使用 Seatbelt 并显式拒绝 network；Windows/未知平台没有可接受后端时保持 unavailable。
- sandbox readiness 不是环境变量自报：`AITEAM_AGENT_SANDBOX_READY=true` 只是生产配置声明，Agent 启动仍会实际 probe；probe 失败不得绑定生产端口。
- sandbox 子进程环境会剥离 API key、token、password、credential、数据库连接串和私钥；取消/超时会终止整个 detached process-group。

## 可重复验证入口

### 开发机/CI（不把 skip 当生产 ready）

```bash
# 只查看将执行的 native gate，不 spawn、不联网、不改服务
bash scripts/check-agent-sandbox.sh --dry-run

# macOS Seatbelt 或已配置 Linux runner 的真实正负向测试
bash scripts/check-agent-sandbox.sh

# 没有 native runner 的开发机只能做 portable contract 验证；结果不能用于发布
bash scripts/check-agent-sandbox.sh --allow-unsupported
```

测试覆盖 harmless execution、workspace 越界/符号链接边界、loopback 网络拒绝、凭据剥离、取消和 timeout。`--allow-unsupported` 仅允许本地测试报告 skip，不能设置或模拟 readiness。

### taiyi Linux bwrap/Landlock 矩阵

在目标 Linux 主机上执行以下命令。它只启动短命测试子进程，不重启 Agent、不连接 Manager、不修改 PG：

```bash
bash scripts/check-agent-sandbox.sh --linux-matrix
```

该入口会分别执行 bwrap 与 Landlock，并要求两者都能在 no-network wrapper 下正向完成；默认 provider 的正向/越界/网络/凭据/取消/timeout 测试也必须通过。若 bwrap 因 user namespace 策略不可用，或 Landlock 内核/LSM/unshare 不可用，命令失败而不是标记 ready。未知平台也必须失败。

## 生产 Agent 启动门禁

生产必须显式提供 `AITEAM_ENV=production`，并同时满足：

- `AITEAM_AGENT_SANDBOX_READY=true`，且真实 sandbox probe 成功；
- `AITEAM_PI_FAKE`、`AITEAM_AGENT_DEV_AUTH` 均不是 `true`；
- `AITEAM_MANAGER_URL` 是绝对 `http(s)` URL；
- `AITEAM_AGENT_JWT_ISSUER`、`AITEAM_AGENT_JWT_AUDIENCE` 和 `AITEAM_AGENT_JWKS_JSON`/`AITEAM_AGENT_JWKS_PATH` 均存在；JWKS 至少含可用 RSA/RS256 `kid/n/e`；
- Agent skill signing public key 与 key id 已由生产 secret injection 提供。

缺任何一项，启动在监听前失败。不要通过设置 `AITEAM_AGENT_SANDBOX_READY=true` 绕过 native probe；不要把生产 key、JWKS 私钥或 Manager 凭据写入仓库、日志、Compose 文件或 CI 输出。

## 发布/回滚 dry-run 闸门

所有 CI 与发布前检查都不连接 taiyi 生产 PG、不拉镜像、不停服务、不写 backup：

```bash
bash scripts/check-deploy.sh
bash scripts/check-agent-sandbox.sh --dry-run
bash deploy/lightrag/init-db.sh --dry-run
bash scripts/validate-lightrag-env.sh
bash scripts/lightrag-ops.sh --dry-run backup
bash scripts/lightrag-ops.sh --dry-run upgrade --image ghcr.io/hkuds/lightrag:1.5.6
bash scripts/lightrag-ops.sh --dry-run rollback --image ghcr.io/hkuds/lightrag:1.5.6
```

`check-deploy.sh` 会验证：

1. shell 语法和 Compose 默认服务；LightRAG 仅能通过 `--profile lightrag` 启动；
2. 所有 Compose 镜像都带固定版本 tag/digest，拒绝 `latest/dev/test/edge`；
3. LightRAG role/database/`vector` extension bootstrap 的 dry-run；
4. deployment/docs/workflow 的静态 secret scan；
5. `ctl.sh` 的 stale Agent PID/process-group 清理和生产启动门禁。

### 真实维护窗口（仅目标主机）

真实 bootstrap、backup、upgrade、rollback 必须由运维在 mode-600 env file 和明确 `--yes` 下执行。`lightrag-ops.sh` 会要求固定镜像、保留备份、使用 `--profile lightrag`，并在 pull 成功后持久化 image pin；CI 不执行这些命令。生产 Compose 运行前还必须完成上面的 taiyi native sandbox 矩阵。

## stale Agent PID/process-group

`ctl.sh` 用 `setsid` 启动本地 Agent，PID 同时作为进程组 leader。停止或发现 stale PID 时只对 `PGID == PID` 的进程组发送 TERM，超时再发送 KILL；PID 被复用为无关进程时不按组误杀。发布前的静态闸门只验证清理逻辑存在，实际端口占用、优雅重启和现场 orphan 检查仍由目标主机维护窗口确认。

## 未在本工作树执行的原生证据

本地/CI 不能代替 taiyi 的 Linux 内核、user namespace、bwrap 包、Landlock LSM、`unshare --net`、容器 capabilities 和真实 systemd 进程树。发布记录必须附 `--linux-matrix` 输出、Agent `/healthz`/`/readyz`、systemd 日志、端口占用和 rollback smoke；在这些证据齐全前不得宣称 P1.2/P2 native acceptance 完成。
