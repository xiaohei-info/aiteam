# Agent 客户端快速集成

本篇说明 Agent sidecar 宿主集成：**带上完整目录与公共配置、公钥，启动进程，把动态本地 URL 交给前端，退出时关闭进程**。macOS 三端复合客户端另外按模块直接访问 Operator/Manager，并使用对应端身份权限；不要求 Agent 通用代理控制面。20 项业务接入见仓库 `docs/客户端接入/2026-09-05-macOS三端接口接入说明.md`。

## 1. 解压并放入客户端安装包

GitHub Artifact 有两层：先解压外层 ZIP，再解压里面的：

```text
macOS:  aiteam-agent-*-darwin-*.tar.gz
Windows: aiteam-agent-*-win32-*.zip
```

把解压后的**整个目录**放入客户端资源目录，不要只复制其中几个文件：

```text
macOS:  <Client>.app/Contents/Resources/agent/
Windows: <Client>\resources\agent\
```

下文称该目录为 `AGENT_DIR`。

## 2. 准备配置和数据目录

客户端安装或升级时复制：

```text
AGENT_DIR/config/agent.env         → CLIENT_DATA_ROOT/agent.env
AGENT_DIR/config/manager-jwks.json → CLIENT_DATA_ROOT/manager-jwks.json（文件型 JWKS 包）
```

下文称目标配置文件为 `CONFIG_FILE`。有企业公共配置的包可使用随包配置；模板包不能直接登录。文件型 JWKS 打包后通常写为 `AITEAM_AGENT_JWKS_PATH=manager-jwks.json`，相对路径以 **CONFIG_FILE 所在目录**解析，不以 `cwd` 或可执行文件目录解析。因此不能只复制 env；自定义相对路径也必须保持对应目录结构，或由宿主设置可信公钥文件的绝对路径。`AITEAM_AGENT_JWKS_JSON` 与 `AITEAM_AGENT_JWKS_PATH` 必须二选一；同时配置会被 runtime/package/ctl 拒绝，不存在优先级或 fallback。

正式交付需要企业确认 Manager HTTPS 正式地址、与 Manager `AITEAM_JWT_ISSUER` **逐字相同**的 `AITEAM_AGENT_JWT_ISSUER`、与 JWT aud 一致的 `AITEAM_AGENT_JWT_AUDIENCE`、可信 RSA RS256 公共 JWKS（kid/n/e）和技能验证公钥。Manager URL 不自动等于 issuer；不能改写 scheme/path/末尾斜杠来“修复”验签。现有严格打包器要求 URL 型 issuer，生产包要求 HTTPS；如 Manager 仍用开发默认 `aiteam-manager`，应由部署方正式配置一致的 issuer 后交付，不能客户端自行猜一个 URL。

Agent 在启动时载入公钥，不会自动下载 JWKS、发现 issuer 或热加载文件。轮换时通过受控安装/配置通道先分发可信 current+next 公钥并重启 Agent，再由 Manager 切换签名；旧 token 有效期及重叠窗口结束后受控移除旧公钥并再次重启。未知 kid/issuer/audience 必须失败，不得自动信任。公钥不等于签名私钥；任何用户密码、service token、Provider/Hindsight/LightRAG secret 均不得入包。

企业知识能力可在公共配置中设置 `AITEAM_RAG_MCP_URL=https://manager.example.com/api/manager/rag/mcp`（示例域名）。它必须与配置的 Manager 同 origin、固定此路径、无 query/hash/凭据；测试 Manager 可对应使用 `http://121.40.78.201:8782/api/manager/rag/mcp`。不配置时不装载该 MCP 工具，不把企业 LightRAG 内网地址交给客户端。运行时认证由 Agent 当前会话在内存中提供。

另外创建持久化数据目录：

```text
macOS:  ~/Library/Application Support/<Vendor>/<Client>/agent-data/
Windows: %LOCALAPPDATA%\<Vendor>\<Client>\agent-data\
```

下文称它为 `DATA_DIR`。升级时可受控更新 `CONFIG_FILE` 及配套 JWKS（保留宿主定制 origin/目录等设置），但**不得删除或覆盖 `DATA_DIR`**。

如果客户端 WebView 的 origin 不是配置中的 `aiteam://desktop`，只需修改 `CONFIG_FILE` 中这一项：

```dotenv
AITEAM_AGENT_ALLOWED_ORIGINS=客户端真实origin
```

同源页面留空；`file://` WebView 通常填 `null`；禁止填 `*`。

## 3. 客户端打开后自动启动 Agent

确保桌面客户端本身是单实例，然后用原生进程 API 启动 Agent。所有路径使用绝对路径。

### macOS

```text
executable = AGENT_DIR/runtime/node
args = [
  "--import", AGENT_DIR/node_modules/tsx/dist/esm/index.mjs,
  AGENT_DIR/bin/start-agent.mjs,
  "--config", CONFIG_FILE,
  "--port", "0",
  "--data-dir", DATA_DIR
]
cwd = AGENT_DIR
```

### Windows

```text
executable = AGENT_DIR\runtime\node.exe
args = [
  "--import", AGENT_DIR\node_modules\tsx\dist\esm\index.mjs,
  AGENT_DIR\bin\start-agent.mjs,
  "--config", CONFIG_FILE,
  "--port", "0",
  "--data-dir", DATA_DIR
]
cwd = AGENT_DIR
```

Windows 使用隐藏控制台方式启动。客户端保存子进程句柄，并接管 stdout/stderr；不要把密码、token 或会话内容上传到云端日志。

手工验证时可运行：

```bash
# macOS
AGENT_DIR/bin/start-agent.sh --config CONFIG_FILE --port 0 --data-dir DATA_DIR
```

```powershell
# Windows
AGENT_DIR\bin\start-agent.cmd --config CONFIG_FILE --port 0 --data-dir DATA_DIR
```

## 4. 等待 Agent 就绪

启动后轮询 `DATA_DIR/agent-port.json`，建议间隔 300ms、最多等待 30 秒：

```json
{"schema_version":1,"pid":12345,"host":"127.0.0.1","port":53124,"started_at":"..."}
```

必须确认：

- `pid` 是刚启动的 Agent 子进程；
- `host` 是 loopback；
- `port` 在 1–65535。

随后依次检查：

```text
GET http://127.0.0.1:PORT_VALUE/healthz
期望：HTTP 200

GET http://127.0.0.1:PORT_VALUE/readyz
期望：HTTP 200 且 {"data":{"ready":true}}
```

`healthz` 失败表示 Agent 未启动；`readyz` 失败表示本地数据库、目录或 sandbox 未就绪，此时不要开放本地执行功能。

## 5. 把 Agent URL 交给前端

原生客户端把下面的值通过 preload/IPC/初始化参数传给 WebView：

```text
agentBaseUrl = http://127.0.0.1:PORT_VALUE
```

宿主可实现 `get_agent_base_url` IPC，返回经过上一节进程/健康校验的 URL；它是原生宿主接口，**不是 Agent 新增 HTTP 路由**。每次进程重启后重新发现，禁止缓存旧端口或在失败时回退到 taiyi 远程 Agent。前端创建 API Client 时传入该地址，禁止写死 `8180`：

```ts
new AgentApiClient({
  baseUrl: agentBaseUrl,
  getToken() { return token; },
});
```

如果直接打开 Agent 自带页面，访问：

```text
http://127.0.0.1:PORT_VALUE/
```

## 6. 登录并确认 Manager 连接

Agent 自带页面/本地聊天模块使用下面的既有认证窄通道；它不是所有业务的通用代理。复合客户端企业招募、组织/知识管理、企业汇总直接访问 Manager 并使用该企业身份；平台运营模块直接访问 Operator 并使用平台身份，不能复用企业 token 冒充平台权限。首次本地登录按以下顺序：

```text
POST /api/auth/resolve-tenant-by-account
POST /api/agent/login
GET  /api/agent/whoami
POST /api/agent/grants/sync
GET  /api/agent/grants/readiness
```

登录或同步返回 `503` 表示 Manager 不可达，客户端展示离线状态；不要把它当成本地 Agent 启动失败。

## 7. 客户端退出和升级

客户端退出时：

1. 停止发送新请求；
2. 终止并等待 Agent 子进程退出；
3. 再退出客户端。

客户端升级时：

```text
停止旧 Agent → 替换 AGENT_DIR → 更新 CONFIG_FILE 及配套公共 JWKS → 保留 DATA_DIR → 重新发现端口并检查 healthz/readyz
```

## 最小验收

- [ ] 未安装 Node.js 的机器可以启动 Agent；
- [ ] 启动后可读到 `agent-port.json`；
- [ ] `/healthz` 和 `/readyz` 通过；
- [ ] WebView 使用动态 `agentBaseUrl`；
- [ ] 登录、授权同步成功；
- [ ] 客户端退出后 Agent 进程同步退出；
- [ ] 升级后原有会话和数据仍存在。

> taiyi 包是测试包，Manager 地址为 `http://121.40.78.201:8782`，不能作为生产包发布；本说明不表示本轮已部署或正式 JWKS 已交付。taiyi 云端服务升级不等于用户已安装的本机 sidecar 自动升级；本轮本地新增接口需要单独升级包含对应代码的 Agent 包，并验证本地 `/openapi.json`。Windows 包在生产发布前仍需完成原生 sandbox 验收。
