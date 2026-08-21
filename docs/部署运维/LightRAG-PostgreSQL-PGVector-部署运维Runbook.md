# LightRAG + PostgreSQL/pgvector 部署运维 Runbook（P2）

## 适用范围与边界

本文是 v1 Manager-side LightRAG 外部组件的目标部署手册，不是旧 `app/` 单体 SOP 的补丁。

- 适用：taiyi / 生产 Manager 部署，以及可选的本地 Compose 联调。
- LightRAG 只被 Manager 服务访问；不向 Agent 镜像、Agent 环境或用户端下发 API key。
- LightRAG 使用独立 PostgreSQL/pgvector 数据库、独立 role 和固定 workspace；不复用 AI Team 控制面数据库/role。
- LightRAG 服务不暴露主机公网端口。Manager 通过内网 URL 调用，Agent 仍只调用 Manager MCP facade。
- 本文命令中的 `--dry-run` 不连接数据库、不拉镜像、不停止服务、不写备份；没有标注的 bootstrap/恢复/升级命令只在 taiyi/生产执行。

当前验证基线为 LightRAG `1.5.6`，Compose 默认使用 `ghcr.io/hkuds/lightrag:1.5.6`，禁止 `latest`。生产可替换为已经验证的同版本 `@sha256:<64位摘要>`；更换 LightRAG、embedding dimension 或 storage adapter 前必须先在隔离 PG 数据库完成 clean-install smoke，并把镜像引用写入受控环境文件。`pgvector/pgvector:pg16` 同样固定 PG major，不要漂移到 `latest`。

## 1. Manager-only 环境契约

将下面变量放到 Manager 主机的 mode-600 `.env.prod` / secret store；不要提交 `.env`，不要把值复制进 Agent 配置。尖括号是占位说明，不是可用值：

```dotenv
# Manager -> LightRAG（生产使用内网 TLS/服务发现地址）
LIGHTRAG_URL=https://lightrag.manager.internal
LIGHTRAG_API_KEY=<secret-store>
LIGHTRAG_WORKSPACE=<manager-derived-fixed-workspace>
LIGHTRAG_IMAGE=ghcr.io/hkuds/lightrag:1.5.6

# LightRAG 专用 PG；管理员凭据只给 bootstrap，运行时使用 lightrag role
LIGHTRAG_DB_HOST=<private-pg-host>
LIGHTRAG_DB_PORT=5432
LIGHTRAG_DB_NAME=lightrag
LIGHTRAG_DB_USER=lightrag
LIGHTRAG_DB_PASSWORD=<secret-store>
LIGHTRAG_DB_ADMIN_USER=<secret-store>
LIGHTRAG_DB_ADMIN_PASSWORD=<secret-store>
```

`LIGHTRAG_WORKSPACE` 必须是 Manager 已推导并固定的实例 namespace（例如 `tenant-hash__ks_default`），不能由前端/Agent 请求覆盖。生产校验：

```bash
# taiyi/生产；只读校验，不调用 LightRAG，不打印 key/password
bash scripts/validate-lightrag-env.sh --production --env-file /etc/aiteam/manager.env
```

URL、API key、workspace 任一缺失时 Manager 应保持 fail-closed；不要用空 key 作为生产默认值。Compose 的空密码只为保持默认三端 `docker compose config` 可解析，启用 profile 前必须由 secret store 注入真实值。

## 2. 初始化独立数据库、role、pgvector

### 2.1 taiyi/生产（真实执行）

先由数据库管理员创建或提供 LightRAG PG 实例。使用管理员连接执行一次幂等 bootstrap；脚本会创建 `LIGHTRAG_DB_USER` role、数据库，并在该数据库执行 `CREATE EXTENSION vector`。密码从 mode-600 env 文件或 secret manager 注入，不出现在命令行：

```bash
# taiyi/生产；真实变更。先确认 LIGHTRAG_DB_* 来自 /etc/aiteam/lightrag.env
set -a; source /etc/aiteam/lightrag.env; set +a
bash deploy/lightrag/init-db.sh
```

脚本可重复运行：role 密码会被同步，已存在数据库/extension 不会重复创建。运行时只给 LightRAG `LIGHTRAG_DB_USER`，`LIGHTRAG_DB_ADMIN_*` 仅给该 bootstrap/DDL 流程。

### 2.2 dry-run（开发机/CI）

```bash
bash deploy/lightrag/init-db.sh --dry-run
```

该命令只校验 identifier 并打印目标数据库/role/extension，明确省略密码，不需要 PostgreSQL。

## 3. 本地 Compose 联调（不改变三端默认行为）

默认 `docker compose up` 仍只启动 operation、manager、agent 和原控制面 pg。LightRAG profile 必须显式启用；生产不要把这个开发 compose 当作公网入口。

```bash
# 开发/测试；值由临时 secret 注入，不要提交到文件
export LIGHTRAG_DB_ADMIN_PASSWORD="$(openssl rand -hex 32)"
export LIGHTRAG_DB_PASSWORD="$(openssl rand -hex 32)"
export LIGHTRAG_API_KEY="$(openssl rand -hex 32)"
export LIGHTRAG_WORKSPACE=tenant_demo__ks_default
export LIGHTRAG_URL=http://lightrag:9621

# 启动独立 pgvector + LightRAG（Manager-only network）
docker compose -f deploy/docker/docker-compose.yml --profile lightrag up -d lightrag-postgres
export LIGHTRAG_DB_HOST=127.0.0.1 LIGHTRAG_DB_PORT=55432
bash deploy/lightrag/init-db.sh
docker compose -f deploy/docker/docker-compose.yml --profile lightrag up -d lightrag
```

Compose 的 LightRAG 服务只使用 `expose: 9621`，不把服务端口发布给 Agent 或主机；Manager 容器通过 `LIGHTRAG_URL=http://lightrag:9621` 访问。要让 Manager 使用它，启动三端时显式提供同一个 Manager-only `LIGHTRAG_URL`、key 和 workspace；Agent service 的 environment 没有这些变量。

## 4. 备份与恢复

备份是 PostgreSQL custom format，包含 LightRAG 的 KV、doc status、table graph 和 pgvector 表。它不替代 Manager 业务数据库备份。生产备份目录应位于加密、受权限控制的盘，并由外部定时器/对象存储做第二份保留。

```bash
# 任何真实变更前先 dry-run（本命令不 mkdir、不连接 PG）
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env --dry-run backup

# taiyi/生产真实备份（密码来自 env；输出文件 chmod 600）
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env \
  backup --output /var/backups/aiteam/lightrag/pre-change-$(date -u +%Y%m%dT%H%M%SZ).dump

# dry-run 恢复：需要存在的 dump，但不停止服务
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env \
  --dry-run restore --input /var/backups/aiteam/lightrag/known-good.dump --yes

# taiyi/生产真实恢复：维护窗口执行，会停止 LightRAG writer，再启动
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env \
  restore --input /var/backups/aiteam/lightrag/known-good.dump --yes
```

恢复前须确认 dump 来自同一 storage adapter、embedding dimension 和兼容 LightRAG 版本；恢复会 `pg_restore --clean --if-exists` 覆盖目标 LightRAG 数据，不能在线对同一 workspace 运行旧 writer。

## 5. 升级与 rollback

升级/rollback 都会先做备份。`--image` 必须是版本 tag 或 sha256 digest，脚本拒绝 `latest`；`upgrade` 和 `rollback` 需 `--yes` 才会真实拉取/重启。真实执行必须传 `--env-file`，脚本会只更新其中的 `LIGHTRAG_IMAGE` 行，使 pin 在后续主机重启后仍然生效，不改动 secret 行。

```bash
# dry-run，确认备份路径与将执行的动作
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env --dry-run \
  upgrade --image ghcr.io/hkuds/lightrag:1.5.6

# taiyi/生产升级：先在 staging clean-install + query/ingestion smoke
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env \
  upgrade --image ghcr.io/hkuds/lightrag:1.5.7 --yes

# taiyi/生产 rollback 到已验证的上一版本；同样先备份
bash scripts/lightrag-ops.sh --env-file /etc/aiteam/lightrag.env \
  rollback --image ghcr.io/hkuds/lightrag:1.5.6 --yes
```

升级顺序是备份 → 拉取固定镜像 → 重启 LightRAG writer → health/query smoke。不要让旧版本与新版本同时写同一 workspace；schema/向量 dimension 变化必须走新的隔离数据库和重建索引，而不是直接回滚容器标签。

## 6. 验收与故障边界

```bash
# shell syntax、默认 compose config、部署目录静态 secret scan
bash scripts/check-deploy.sh

# CI 等价 dry-run
bash deploy/lightrag/init-db.sh --dry-run
bash scripts/validate-lightrag-env.sh
bash scripts/lightrag-ops.sh --dry-run backup
```

未覆盖的真实运行风险：LightRAG 上游镜像、PG adapter 和 provider/embedding API 的可用性仍需在目标环境做 clean-install 验证；本仓库静态检查不会证明网络/TLS、外部模型额度、实际 pgvector index 性能或跨租户业务授权正确。Manager 业务授权和 Agent/MCP 契约不在本运维切片内。
