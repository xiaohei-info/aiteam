# 太乙 TEST 三端公网恢复

本部署继续使用现有 `aiteam-v1` / `scripts/ctl.sh` / GitHub `deploy-main.yml`。工作流每次写完 TEST secret 后持久设置 `MANAGER_HOST=0.0.0.0`（8782）、`OPERATION_HOST=0.0.0.0`（8781）及既有 Agent 8783 监听和真实鉴权。设置限定 `/root/app/aiteam`、`aiteam-v1`、TEST 及指定端口；数据库、Redis、NewAPI、LightRAG 的绑定不变。不要只手工追加 HOST，下一次发布会重写 env。

Manager/Operation 的公开监听恢复遵循用户明确接受的既有 TEST 配置；默认服务令牌和 TEST onboarding 写接口风险仍存在，本次不修改令牌、鉴权或 GitHub Secret 内容。`control_plane_public=false` 可独立将这两端恢复回环；`agent_public` 继续只控制 Agent。

## 固定 Manager 验签

`AITEAM_AGENT_JWKS_MODE=manager` 复用 Manager `/api/auth/{tenant_id}/jwks.json`，仅允许运维配置的固定 `AITEAM_MANAGER_URL` origin（无用户信息、路径、query、fragment），禁止重定向。太乙使用 `http://127.0.0.1:8782`。issuer/audience 从同一 TEST env 的 Manager `AITEAM_JWT_ISSUER`/`AITEAM_JWT_AUDIENCE` 取得；缺省值对应当前 Manager 的 `aiteam-manager`/`aiteam-agent`。不会根据 token 的 issuer、jku、x5u 或客户端字段发现 URL。

登录/重置成功响应须先本地 RS256 验签；响应 claims 由已验证 token 替换。只有固定 Manager 已成功认证的 tenant 才能进入公钥缓存。tenant 必须是 UUID，kid 必须精确为该 tenant 的 `tenant:version`；验签、issuer、audience、exp、iat、nbf、identity 失败均拒绝。后续 HTTP 受保护路由复用同一验证器，开发固定 bearer 不受理。未登记租户的 bearer 不能触发 JWKS GET（Manager 的 GET 可能 ensure 创建 key）。

缓存为进程内最多256租户，每租户最多32公钥；下载最多64KiB、3秒超时；同租户单飞，未知 kid/失败最短5秒退避，全局最多4个并发、每秒16次下载。材料60秒到期；到期下载失败则拒绝，不延长旧材料。成功下载完整替换旧公钥列表，以 Manager current+retired24h 列表为轮换真相；移除/撤销最多有60秒已有缓存窗口。Manager 短暂离线时，未到期材料可继续本地验签。

**进程重启或缓存淘汰后需重新登录**；不接受陌生 bearer 的任意租户发现。这既支持现有与新开户租户，又避免未授权 GET 创建 signing key。不会读取 Manager 数据库、私钥或 admin DSN。

默认 `static` 模式保留原有受控 JWKS JSON/path（两者二选一）及协调轮换契约。`manager` 与任一静态 JWKS 或 dev auth 同时配置会在监听前失败。生产 launch guard 仍要求原静态交付配置，本次动态启用限定太乙 TEST。

## 发布与安全回退

先运行 `pnpm --dir server/agent_service check` 和对应测试。GitHub CI 还会在服务启动前重复类型检查和合成 Manager 鉴权测试。正常发布通过 PR 合并 main 自动触发既有部署，无需再手动 dispatch；发布后核对运行 SHA。以下命令仅供明确需要手动发布/回退时使用，workflow ref 与 branch input 都须指向受验版本：

```bash
gh workflow run deploy-main.yml --repo xiaohei-info/aiteam --ref main -f branch=main -f agent_public=true -f control_plane_public=true
```

CI 写 env 前将原 env、unit、SHA 保存到 `/root/app/aiteam-release-backups/<run-id>/`（目录700，文件600）。原 env 可能含开发鉴权，不可直接恢复并公开监听。

若需撤回公网开放，用同一已验签修复版本经 CI 恢复回环监听，仍关闭开发鉴权：

```bash
gh workflow run deploy-main.yml --repo xiaohei-info/aiteam --ref main -f branch=main -f agent_public=false -f control_plane_public=false
```

此回退仅关闭公网，不恢复旧版 decode-only 鉴权。后续要回退业务代码，应保留本鉴权补丁并选定受验分支再走相同 CI；不得把旧 main 配公网 dev auth。

验收包括禁proxy外部 health、空 JSON 登录422、无bearer/开发bearer401、部署SHA及监听/鉴权配置读回、内部依赖健康。合成测试不替代真实用户账户端到端；用户应在安全 UI 使用既有账户登录验证，勿在聊天发送密码/token，勿为验收创建账户或生产钥匙。
