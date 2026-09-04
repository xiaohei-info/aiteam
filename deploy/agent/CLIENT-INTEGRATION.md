# AI Team Agent 客户端集成手册

> **读者**：桌面客户端（macOS/Windows）开发团队。
>
> **目标**：把 Agent sidecar 放进你们的客户端安装包。用户打开客户端后，客户端自动启动 Agent，等待 Agent 就绪，把本地 URL 注入 WebView/前端；页面的 Agent 请求全部走 localhost，Agent 再主动访问对应企业的 Manager。
>
> **不需要做的事**：客户端不需要启动 Python、PostgreSQL、Operator、Manager，也不需要让用户安装 Node.js。

## 0. 先看最终运行关系

```text
┌──────────────────────┐
│ 桌面客户端原生壳       │
│ 进程管理 / 配置 / IPC  │
└──────────┬───────────┘
           │ spawn Agent sidecar
           ▼
┌──────────────────────┐       localhost HTTP       ┌──────────────────────┐
│ Agent sidecar         │ ◀──────────────────────── │ 客户端 WebView/前端   │
│ Node runtime + Pi    │                            │ API base = Agent URL  │
│ SQLite + Session      │                            └──────────────────────┘
└──────────┬───────────┘
           │ 主动访问（测试环境 HTTP，生产环境 HTTPS）
           ▼
┌──────────────────────┐
│ 当前企业 Manager      │ ────────► Operator（由 Manager 负责）
└──────────────────────┘
```

客户端页面**不直接访问 Manager/Operator**。Operator URL 不是 Agent 配置的一部分，这是 v1 的通信边界。

## 1. 你从 CI 拿到的是什么

GitHub Actions Artifact 有两层：

```text
GitHub Artifact 外层 ZIP
└── macOS: aiteam-agent-...-darwin-....tar.gz
└── Windows: aiteam-agent-...-win32-....zip
```

macOS：

```bash
unzip aiteam-agent-darwin-arm64.zip
cd aiteam-agent-darwin-arm64
tar -xzf aiteam-agent-0.1.0-taiyi-test-darwin-arm64.tar.gz
```

Windows PowerShell：

```powershell
Expand-Archive .\aiteam-agent-win32-x64.zip .\artifact
Expand-Archive .\artifact\aiteam-agent-0.1.0-taiyi-test-win32-x64.zip .\agent
```

解压后的 Agent 目录必须包含：

```text
runtime/node              # macOS
runtime/node.exe          # Windows
bin/start-agent.mjs
bin/start-agent.sh        # macOS 手工调试
bin/start-agent.cmd       # Windows 手工调试
node_modules/
dist/
web/agent/dist/
config/agent.env
manifest.json
README.md
CLIENT-INTEGRATION.md
```

客户端发布包中应保留整个 Agent 目录，不要只复制 `dist/` 或 `runtime/`。

## 2. 安装目录和数据目录必须分开

### 2.1 安装资源目录

安装资源目录应该随客户端安装，并尽量不可写：

```text
macOS:
<Client>.app/Contents/Resources/agent/

Windows:
C:\Program Files\<Vendor>\<Client>\resources\agent\
```

这个目录包含 Agent 可执行文件和依赖，不要让 Agent 把 SQLite 或 Session 写进去。

### 2.2 用户数据目录

建议客户端自行决定 Vendor/Client 名称：

```text
macOS:
~/Library/Application Support/<Vendor>/<Client>/agent-data/

Windows:
%LOCALAPPDATA%\<Vendor>\<Client>\agent-data\
```

该目录保存：

```text
agent.sqlite
attachments/
capabilities/
pi/
sessions/
workspaces/
agent-port.json
```

升级或回滚时只替换安装资源目录，必须保留 `agent-data`。

### 2.3 配置文件目录

建议配置文件放在用户数据目录之外，但不要放在 Agent 安装资源目录中：

```text
macOS:
~/Library/Application Support/<Vendor>/<Client>/agent.env

Windows:
%LOCALAPPDATA%\<Vendor>\<Client>\agent.env
```

客户端启动时通过 `--config` 明确传入该路径。

## 3. 准备 Agent 配置

### 3.1 taiyi 测试包配置

本次 CI 生成的是 taiyi 测试包，配置已经写入包内 `config/agent.env`：

```dotenv
AITEAM_ENV=test
AITEAM_AGENT_DEV_AUTH=true
AITEAM_PI_FAKE=false
AITEAM_AGENT_SANDBOX_READY=true
AITEAM_AGENT_LOCAL_ONLY=true
HOST=127.0.0.1
PORT=8180
AITEAM_MANAGER_URL=http://121.40.78.201:8782
AITEAM_RAG_MCP_URL=http://121.40.78.201:8782/api/manager/rag/mcp
AITEAM_AGENT_ALLOWED_ORIGINS=aiteam://desktop
```

测试包只用于测试环境，不要把 `AITEAM_AGENT_DEV_AUTH=true` 或 HTTP 地址带到生产。

### 3.2 生产配置

生产配置至少需要：

```dotenv
AITEAM_ENV=production
AITEAM_AGENT_LOCAL_ONLY=true
AITEAM_AGENT_SANDBOX_READY=true
HOST=127.0.0.1
PORT=8180
AITEAM_MANAGER_URL=https://manager.example.com
AITEAM_AGENT_JWT_ISSUER=https://manager.example.com
AITEAM_AGENT_JWT_AUDIENCE=aiteam-agent
AITEAM_AGENT_JWKS_JSON='{"keys":[...]}'
AITEAM_SKILL_SIGNING_PUBLIC_KEY=...
AITEAM_SKILL_SIGNING_KEY_ID=skills-current
AITEAM_AGENT_ALLOWED_ORIGINS=aiteam://desktop
```

只允许放入：

- 当前企业 Manager URL；
- JWT issuer、audience；
- RSA public JWKS；
- Skill signing public key；
- 客户端 WebView origin；
- 本地监听参数。

禁止放入：

- Provider API key；
- Hindsight/LightRAG token；
- Manager credential key；
- service token；
- JWT private key；
- Skill signing private key；
- 用户密码。

配置覆盖顺序：

```text
启动参数 > 客户端注入的进程环境变量 > --config 文件 > 启动器默认值
```

## 4. 客户端启动 Agent

### 4.1 推荐：原生代码直接 spawn，不调用 shell

不要依赖客户端当前工作目录。所有路径都使用绝对路径。

假设：

```text
AGENT_DIR  = 客户端安装资源中的 Agent 根目录
CONFIG     = 客户端数据目录之外的 agent.env
DATA_DIR   = 用户数据目录中的 agent-data
```

macOS 的进程参数：

```text
可执行文件：AGENT_DIR/runtime/node

参数：
--import
AGENT_DIR/node_modules/tsx/dist/esm/index.mjs
AGENT_DIR/bin/start-agent.mjs
--config
CONFIG
--port
0
--data-dir
DATA_DIR
```

Windows 的进程参数：

```text
可执行文件：AGENT_DIR\\runtime\\node.exe

参数：
--import
AGENT_DIR\\node_modules\\tsx\\dist\\esm\\index.mjs
AGENT_DIR\\bin\\start-agent.mjs
--config
CONFIG
--port
0
--data-dir
DATA_DIR
```

伪代码：

```text
agentProcess = spawn(
    executable = AGENT_DIR + "/runtime/node[.exe]",
    args = [
        "--import",
        AGENT_DIR + "/node_modules/tsx/dist/esm/index.mjs",
        AGENT_DIR + "/bin/start-agent.mjs",
        "--config", CONFIG,
        "--port", "0",
        "--data-dir", DATA_DIR,
    ],
    cwd = AGENT_DIR,
    stdout = PIPE,
    stderr = PIPE,
)
```

Windows 创建进程时使用 `CREATE_NO_WINDOW` 或客户端框架对应的隐藏控制台选项。

### 4.2 手工调试方式

macOS：

```bash
cd /absolute/path/to/AGENT_DIR
./bin/start-agent.sh \
  --config /absolute/path/to/agent.env \
  --port 0 \
  --data-dir "/absolute/path/to/agent-data"
```

Windows：

```powershell
Set-Location C:\absolute\path\to\AGENT_DIR
.\bin\start-agent.cmd `
  --config C:\absolute\path\to\agent.env `
  --port 0 `
  --data-dir C:\absolute\path\to\agent-data
```

`start-agent.sh`/`start-agent.cmd` 只适合手工调试；正式客户端推荐 4.1 的原生 spawn 方式。

## 5. 客户端启动状态机

客户端不要只判断子进程是否存在。建议实现以下状态：

```text
STOPPED
   │ spawn
   ▼
STARTING
   │ port file + healthz 通过
   ▼
ALIVE
   │ readyz 通过
   ▼
READY
   │ 登录/授权同步通过
   ▼
CONNECTED
```

异常状态：

```text
STARTING 超时        → ERROR
进程提前退出          → ERROR
healthz 失败          → ERROR 或 RESTARTING
healthz 通过、readyz 503 → DEGRADED（禁止本地执行）
Manager 登录/同步 503  → OFFLINE（可显示离线）
```

### 5.1 读取 port file

Agent 会在 `DATA_DIR/agent-port.json` 写入：

```json
{
  "schema_version": 1,
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 53124,
  "started_at": "2026-09-04T02:00:00.000Z"
}
```

客户端轮询间隔建议 200–500ms，总超时建议 30 秒。每次读取都检查：

1. JSON 是否有效；
2. `pid` 是否仍然是当前 Agent 子进程；
3. `host` 是否为 loopback；
4. `port` 是否在 1–65535；
5. 是否能访问 healthz。

### 5.2 healthz 和 readyz

将 port file 中的端口保存为变量 `PORT_VALUE`，不要把尖括号占位符直接放入 URL：

```text
GET http://127.0.0.1:PORT_VALUE/healthz
```

成功响应：

```json
{"data":{"status":"ok"}}
```

需要本地执行能力时继续检查：

```text
GET http://127.0.0.1:PORT_VALUE/readyz
```

只有 HTTP 200 且响应中 `data.ready=true` 时，客户端才可以开放文件操作、bash 或其他本地执行功能。

### 5.3 stdout ready 事件

客户端也可以监听 stdout：

```text
AI_TEAM_AGENT_READY {"host":"127.0.0.1","port":53124,"pid":12345}
```

port file 和 stdout 二选一即可，但仍然必须调用 `/healthz` 进行确认。

## 6. 把 Agent URL 注入 WebView/前端

浏览器不能直接读取 `agent-port.json`。必须由客户端原生层读取端口后，通过 preload、IPC 或页面初始化参数传给前端：

```text
agentBaseUrl = "http://127.0.0.1:" + port
```

前端 API Client 的初始化必须使用动态地址：

```ts
const client = new AgentApiClient({
  baseUrl: agentBaseUrl,
  getToken: () => localToken,
});
```

不要在前端写死：

```text
http://127.0.0.1:8180
```

`8180` 只是默认值，生产客户端推荐使用随机端口。

### 6.1 CORS

如果 WebView 的 origin 是：

```text
aiteam://desktop
```

配置：

```dotenv
AITEAM_AGENT_ALLOWED_ORIGINS=aiteam://desktop
```

如果客户端页面是 `http://127.0.0.1:5173`：

```dotenv
AITEAM_AGENT_ALLOWED_ORIGINS=http://127.0.0.1:5173
```

如果页面从 `file://` 加载，通常要配置：

```dotenv
AITEAM_AGENT_ALLOWED_ORIGINS=null
```

不允许使用 `*`。

## 7. 登录和 Manager 连接检查

前端 API base URL 设置好后，按以下顺序检查连接：

### 7.1 解析企业

```http
POST http://127.0.0.1:PORT_VALUE/api/auth/resolve-tenant-by-account
Content-Type: application/json

{"account":"用户账号"}
```

### 7.2 登录

```http
POST http://127.0.0.1:PORT_VALUE/api/agent/login
Content-Type: application/json

{
  "tenant_id":"上一步返回的 tenant_id",
  "account":"用户账号",
  "password":"用户输入的密码"
}
```

保存返回的短期 token。密码和 token 不能写入日志。

### 7.3 验证身份

```http
GET http://127.0.0.1:PORT_VALUE/api/agent/whoami
Authorization: Bearer TOKEN_VALUE
```

确认返回的 `tenant_id`、`user_id` 和 `roles` 正确。

### 7.4 同步授权

```http
POST http://127.0.0.1:PORT_VALUE/api/agent/grants/sync
Authorization: Bearer TOKEN_VALUE
Content-Type: application/json

{
  "tenant_id":"当前身份 tenant_id",
  "member_id":"当前身份 user_id",
  "known_versions":{}
}
```

### 7.5 检查员工执行能力

```http
GET http://127.0.0.1:PORT_VALUE/api/agent/grants/readiness
Authorization: Bearer TOKEN_VALUE
```

只有完成以上检查后，再开放聊天、群聊、SSE 和本地执行按钮。

## 8. 客户端退出、崩溃和升级

### 8.1 正常退出

1. 页面停止接受新的 prompt；
2. 必要时调用 Agent abort 接口；
3. 向 Agent 子进程发送 SIGTERM（Windows 使用等效终止）；
4. 等待进程退出；
5. 确认 `agent-port.json` 被清理；
6. 客户端退出。

### 8.2 自动重启

Agent 异常退出时：

1. 记录退出码和 stderr 摘要；
2. 删除或忽略旧 port file；
3. 使用同一个 `CONFIG` 和 `DATA_DIR` 重新 spawn；
4. 重新执行 port file、healthz、readyz、登录态检查；
5. 不要创建新的数据目录，否则会导致用户看不到旧会话。

### 8.3 升级/回滚

```text
停止旧 Agent
  → 替换安装资源目录
  → 保留 agent-data
  → 启动新 Agent
  → healthz/readyz
  → whoami/grants/readiness
  → 恢复页面
```

不要删除或覆盖：

```text
agent.sqlite
sessions/
workspaces/
attachments/
capabilities/
```

## 9. 日志和安全要求

客户端可以保存本地启动日志，但不能上传：

- 用户密码；
- JWT/access token；
- Provider key；
- Manager/Hindsight/LightRAG token；
- 会话正文；
- Pi 原始事件；
- workspace 中的任意文件内容。

安装资源目录应只读，用户数据目录应使用操作系统的用户私有目录。macOS 需要对嵌套 `runtime/node` 一并 code-sign/notarize；Windows 需要按客户端发布策略进行 Authenticode 签名。

## 10. 客户端验收清单

交付前逐项验证：

- [ ] 安装后客户端自动启动 Agent；
- [ ] 用户没有安装 Node.js 也能启动；
- [ ] 客户端不依赖当前工作目录；
- [ ] port file 能被读取，旧 port file 不会误判；
- [ ] healthz/readyz 状态能正确映射到 UI；
- [ ] WebView 使用动态 Agent URL；
- [ ] CORS origin 与实际 WebView origin 一致；
- [ ] resolve tenant、login、whoami 成功；
- [ ] grants/sync、grants/readiness 成功；
- [ ] Manager 不可达时显示离线而不是伪造成功；
- [ ] Agent 崩溃后可以复用原数据目录重启；
- [ ] 客户端退出时 Agent 子进程确实退出；
- [ ] 升级/回滚不丢 SQLite、Session、附件；
- [ ] macOS/Windows 签名和安装权限验证通过；
- [ ] taiyi 测试包没有被误用作生产包。

## 11. taiyi 测试包限制

本次测试包使用：

```text
AITEAM_ENV=test
AITEAM_AGENT_DEV_AUTH=true
AITEAM_PI_FAKE=false
AITEAM_MANAGER_URL=http://121.40.78.201:8782
```

客户端必须能访问 taiyi 测试 Manager。该包只用于联调，不是正式发布配置。

当前 Windows sidecar 可以完成构建和基础进程检查，但 Windows 原生 sandbox 尚未完成网络隔离和完整子进程输出验收，因此不能把这个 Windows 测试包标记为生产就绪。
