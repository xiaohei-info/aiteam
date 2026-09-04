# Agent 客户端快速集成

客户端只负责四件事：**带上完整 Agent 目录、启动进程、把本地 URL 交给前端、退出时关闭进程**。

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
AGENT_DIR/config/agent.env → CLIENT_DATA_ROOT/agent.env
```

下文称目标文件为 `CONFIG_FILE`。CI 使用企业 Environment 打包时，这个文件已经包含对应 Manager 配置；客户端团队不需要重新生成。taiyi 测试包可以直接使用现成配置。

另外创建持久化数据目录：

```text
macOS:  ~/Library/Application Support/<Vendor>/<Client>/agent-data/
Windows: %LOCALAPPDATA%\<Vendor>\<Client>\agent-data\
```

下文称它为 `DATA_DIR`。升级时可以覆盖 `CONFIG_FILE`，但**不得删除或覆盖 `DATA_DIR`**。

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

前端创建 API Client 时传入该地址，禁止写死 `8180`：

```ts
new AgentApiClient({
  baseUrl: agentBaseUrl,
  getToken: () => token,
});
```

如果直接打开 Agent 自带页面，访问：

```text
http://127.0.0.1:PORT_VALUE/
```

## 6. 登录并确认 Manager 连接

页面只请求本地 Agent，不直接请求 Manager 或 Operator。首次登录按以下顺序：

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
停止旧 Agent → 替换 AGENT_DIR → 更新 CONFIG_FILE → 保留 DATA_DIR → 重新启动并检查 healthz/readyz
```

## 最小验收

- [ ] 未安装 Node.js 的机器可以启动 Agent；
- [ ] 启动后可读到 `agent-port.json`；
- [ ] `/healthz` 和 `/readyz` 通过；
- [ ] WebView 使用动态 `agentBaseUrl`；
- [ ] 登录、授权同步成功；
- [ ] 客户端退出后 Agent 进程同步退出；
- [ ] 升级后原有会话和数据仍存在。

> taiyi 包是测试包，连接 `http://121.40.78.201:8782`，不能作为生产包发布。Windows 包在生产发布前仍需完成原生 sandbox 验收。
