# AI Team 内部 NewAPI Relay 部署运维 Runbook

## 1. 边界

内部 NewAPI 是 Operator 管理的平台 AI Relay，不是第四个业务控制面：

- Operator 配置上游 channel、发布模型/价格、签发 tenant 受限 token。
- Manager/Agent 永远不获得 NewAPI 管理 token 或上游 channel key。
- Agent 只使用 tenant 独立、可撤销、可限模型/限额的推理 token。
- NewAPI DB/Redis 不发布公网；HTTP 默认绑定 `127.0.0.1:${NEWAPI_PORT:-9300}`。

## 2. 配置

复制 `.env.example` 后至少设置：

```dotenv
NEWAPI_IMAGE=calciumion/new-api:v0.13.2
NEWAPI_PORT=9300
NEWAPI_DB_USER=newapi
NEWAPI_DB_PASSWORD=<strong-random>
NEWAPI_DB_NAME=newapi
NEWAPI_REDIS_PASSWORD=<strong-random>
NEWAPI_SESSION_SECRET=<openssl-rand-hex-32>
NEWAPI_CRYPTO_SECRET=<openssl-rand-hex-32>
NEWAPI_ADMIN_BASE_URL=http://127.0.0.1:9300
NEWAPI_PUBLIC_BASE_URL=https://<relay-domain>/v1
```

环境文件必须 `chmod 600 .env.<env>`。生产还必须在首次 setup 后设置 Operator-only：

```dotenv
NEWAPI_ADMIN_USER_ID=1
NEWAPI_ADMIN_TOKEN=<newapi-dashboard-access-token>
```

## 3. 启停与健康

```bash
./scripts/ctl.sh start --env test --server newapi
./scripts/ctl.sh status --env test --server newapi
./scripts/ctl.sh logs --env test --server newapi --follow
curl -fsS http://127.0.0.1:9300/api/status
```

健康响应必须是 HTTP 2xx 且 `success=true`。

## 4. 首次初始化

仅在 loopback/受控 SSH 隧道中执行，不把 setup 页面暴露公网：

1. `GET /api/setup` 确认 `status=false`。
2. `POST /api/setup` 创建 root 用户；密码使用随机强密钥。
3. root 登录后创建独立管理 access token，配置到 Operator 的 `NEWAPI_ADMIN_TOKEN`。
4. 禁止把 root 密码或管理 token 放入仓库、命令历史、截图或普通日志。

## 5. 配置现有上游

内部 NewAPI channel 指向当前上游：

```text
base_url = https://newapi.xiaohei.tech
models   = 通过 /api/channel/fetch_models 或上游 /v1/models 发现
key      = 当前上游推理 key（只写入 NewAPI 管理面）
```

创建后必须：

1. 单 channel connectivity test 成功。
2. `/v1/models` 包含 `minimax-m3`。
3. 使用临时模型受限 token 完成一次真实 `/v1/chat/completions`。
4. 删除临时 token，后续由 Operator tenant-access 流程签发。

## 6. 备份

停止写入或在一致性快照窗口内执行：

```bash
docker exec aiteam-newapi-pg pg_dump -U "$NEWAPI_DB_USER" -d "$NEWAPI_DB_NAME" -Fc > newapi-$(date +%Y%m%d-%H%M%S).dump
docker volume inspect "${NEWAPI_DATA_VOLUME:-aiteam_newapi_data_test}"
```

备份文件按密钥材料处理，至少 `chmod 600`，不得提交 Git。

## 7. 恢复与回滚

1. 记录当前镜像和卷：`docker inspect aiteam-newapi`、`docker volume ls | grep newapi`。
2. 停止 NewAPI，保留卷。
3. 将 `NEWAPI_IMAGE` 回退到上一个已验证固定 tag/digest。
4. 若 schema 不兼容，创建新 DB 卷并从 `pg_restore` 恢复匹配备份；不要在未知 schema 上强行降级。
5. 启动后验证 status、models、tenant token 和真实 completion。

## 8. 安全检查

- `docker inspect` 只允许受控主机管理员读取；其 environment 视为 secret。
- Manager/Agent `/proc/<pid>/environ` 不得出现 `NEWAPI_ADMIN_TOKEN`、DB/Redis/session/crypto secrets。
- Operator 普通 API、OpenAPI、问题响应、日志不得回显 channel key/管理 token。
- tenant token 必须独立、可撤销、可轮换并限制模型/配额；禁止共享全平台推理 token。
- 公网推理入口必须通过 TLS 反代；管理/API setup 路径应限制来源。
