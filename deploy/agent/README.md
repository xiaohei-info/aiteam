# Agent 桌面 sidecar 分发包

`server/agent_service` 是用户本机的数据面服务，不是第二个桌面 UI。桌面客户端把它作为 **sidecar** 随客户端安装并启动，页面只访问本机 loopback 地址；Operator/Manager 仍在云端，Agent 通过 `AITEAM_MANAGER_URL` 主动访问对应企业的 Manager 实例。

## 产物形态

构建产物是一个按平台/架构拆分的目录和压缩包：

```text
 aiteam-agent-<version>-darwin-arm64/
 ├── runtime/node                 # 固定 Node 22，不依赖用户预装 Node
 ├── bin/start-agent.mjs          # 跨平台启动入口
 ├── bin/start-agent.sh           # macOS 客户端可直接 exec
 ├── bin/start-agent.cmd          # Windows 客户端可直接启动
 ├── dist/                        # 编译后的 Agent Service（不含 TS 源码）
 ├── web/agent/dist/              # Agent SPA
 ├── node_modules/                # 当前目标平台的 production 依赖/native optional deps
 ├── config/agent.env             # 本企业配置（只放公钥/URL，不放 secret）
 └── manifest.json                # 文件 SHA-256、目标平台和 Node 版本
```

不要把 `operation_service`、`manager_service`、`web/operation`、`web/manager` 或 `app/` 放进此产物。Agent 的 Pi 会话、SQLite、附件和 workspace 默认写到用户数据目录，不写安装目录。

客户端团队的逐步实施手册见包内 `CLIENT-INTEGRATION.md`；本 README 解释打包、配置和平台边界。

> **发布闸门**：macOS 可在完成目标系统 Seatbelt 矩阵后发布；Windows 当前只能先生成/联调 sidecar，现有 Windows ACL 后端尚未提供网络隔离和完整 piped-grandchild 输出能力，不能直接标记为 production-ready（详见文末平台前置条件）。

## 本机构建

必须在目标 OS/架构上构建（native optional dependency 不能用 macOS 构建出可信的 Windows 包）：

```bash
# Apple Silicon
node scripts/build-agent-package.mjs \
  --target darwin-arm64 \
  --config deploy/agent/config/acme.env

# Intel macOS
node scripts/build-agent-package.mjs --target darwin-x64 --config deploy/agent/config/acme.env

# Windows PowerShell
node scripts/build-agent-package.mjs \
  --target win32-x64 \
  --config deploy/agent/config/acme.env
```

脚本会完成：

1. 构建 `web/shared`、`web/agent` 和 Agent TypeScript runtime；
2. 以 `--prod --ignore-scripts --node-linker=hoisted` 安装目标平台依赖；
3. 下载并校验固定 Node 22 runtime（可用 `--node-runtime <path>` 离线替换）；
4. 生成 manifest/SHA-256，并输出 `.tar.gz`（macOS）或 `.zip`（Windows）。

没有 `--config` 时会输出一个**未绑定企业**的模板包，必须先填写 `config/agent.env` 才能以 production 启动。`AITEAM_ENV=test` 也可用于连接 taiyi 等测试环境（允许 HTTP；若启用 `AITEAM_AGENT_DEV_AUTH=true`，仅限测试包）：

```bash
node scripts/build-agent-package.mjs --target darwin-arm64
```

`--manager-url` 仅用于填充模板，正式构建应使用配置文件：

```bash
node scripts/build-agent-package.mjs \
  --target darwin-arm64 \
  --manager-url https://manager.acme.example
```

`--node-runtime` 适合构建机不能访问 nodejs.org 的场景；该二进制仍必须是 Node 22 且与目标平台匹配。脚本拒绝在非目标平台上“伪造”跨平台包。

### CI 构建并下载

`.github/workflows/agent-package.yml` 支持 `workflow_dispatch` 和 `agent-v*` tag。它会在 macOS/Windows 原生 runner 上分别构建并上传压缩包，完成后从 GitHub Actions run 的 **Artifacts** 下载对应平台包。

要让 CI 同时生成某个企业的绑定包：

1. 在仓库 GitHub **Environment**（例如 `acme`）中创建 multiline secret `AITEAM_AGENT_PACKAGE_CONFIG`；
2. 将 `deploy/agent/config/agent.env.example` 填成该企业配置后作为 secret 内容保存；只放 Manager URL、JWT issuer/audience、public JWKS、Skill public key 和客户端 origin；测试环境可使用 `AITEAM_ENV=test` + `AITEAM_AGENT_DEV_AUTH=true`；CI 场景建议使用 inline `AITEAM_AGENT_JWKS_JSON`，若使用 `AITEAM_AGENT_JWKS_PATH`，需在 CI 另外写入对应 public 文件；
3. 手动运行 `agent-package`，把 `release_environment` 选为 `acme`，可选填写 `package_version`；
4. 下载 `aiteam-agent-<target>` artifact。没有该 secret 时，CI 输出的是要求安装后再填写的模板包。

该 secret 即使由 GitHub Secret 保存，也不能包含 Provider key、Hindsight/LightRAG token 或 private key；构建脚本会在打包前拒绝这些字段。不同企业使用不同 GitHub Environment/secret，或直接在本地用 `--config` 构建。

## 启动与客户端集成

macOS：

```bash
./bin/start-agent.sh --config /path/to/agent.env --port 0 \
  --data-dir "$HOME/Library/Application Support/AI Team/agent"
```

Windows：

```powershell
.\bin\start-agent.cmd --config C:\ProgramData\AiTeam\agent.env --port 0
```

不传参数时，启动器读取包内 `config/agent.env`，默认：

- `HOST=127.0.0.1`（`AITEAM_AGENT_LOCAL_ONLY=true` 时拒绝非 loopback）；
- `PORT=8180`；传 `--port 0` 可让 OS 分配空闲端口；
- macOS：`~/Library/Application Support/AI Team/agent`；Windows：`%LOCALAPPDATA%\AI Team\agent`；
- 在数据目录写 `agent-port.json`，客户端可轮询它等待服务就绪；同时 stdout 输出 `AI_TEAM_AGENT_READY {...}`。

客户端流程：

1. 安装/解压 sidecar 到应用私有目录；
2. 生成或写入 `config/agent.env`（或通过 `--config` 指定安装外配置）；
3. 启动 `start-agent.sh`/`start-agent.cmd`，读取 port file，并轮询 `/healthz`（需要执行能力时再确认 `/readyz` 为 200）；
4. 将页面 API base URL 设置为 `http://127.0.0.1:<port>`，只调用 `/api/agent/*` 和 `/api/auth/*`；
5. 应用退出时终止 sidecar，并在升级前等待旧进程退出；
6. 登录时由 Agent 把账号请求转发到配置的 Manager，企业租户由 Manager 解析。不要让页面直接调用 Manager。

独立桌面页面跨 origin 调用时，在配置中填**精确**的客户端 origin：

```dotenv
AITEAM_AGENT_ALLOWED_ORIGINS=aiteam://desktop,http://127.0.0.1:5173
```

不支持 `*`；如果页面以 `file://` 加载，浏览器 origin 通常是 `null`，需显式配置 `null`。如果客户端通过本地反向代理把页面和 Agent 合并为同源，则保持为空即可。

## 配置与安全边界

每个企业只需要替换 `AITEAM_MANAGER_URL`、JWT issuer/audience、Manager 的 **RSA 公钥 JWKS** 和客户端 origin；无需把企业账号、Provider key、Hindsight/LightRAG token、service token 或任何 private key 放进包。Provider 凭据由 Manager 按员工授权短期下发到 Agent 内存，不能写入 `agent.env`、SQLite、日志或前端 bundle。

`AITEAM_AGENT_JWKS_JSON` 只能是 public JWKS；也可以让客户端在启动时通过 `AITEAM_AGENT_JWKS_PATH` 指向公钥文件。使用 `--config` 构建时，脚本会校验并把该 public JWKS 文件复制为包内 `config/manager-jwks.json`；运行时由客户端提供的 `AITEAM_AGENT_JWKS_PATH` 会优先于包内配置。不同 Manager 部署实例使用不同的 `AITEAM_MANAGER_URL`/issuer/JWKS 组合；同一个通用包可以在安装时改配置，不需要为每个用户重新编译。

## 客户端发布签名

sidecar 内含可执行的 Node runtime，不能只签外层客户端：

- macOS：把 `runtime/node` 作为嵌套可执行文件一并 code-sign，并由客户端的 `.app`/安装包统一 notarize；升级时重新签名。
- Windows：按客户端发布策略对 `runtime/node.exe`/安装包做 Authenticode 签名，避免 SmartScreen 将嵌套运行时视为未知程序。
- 发布前校验 `manifest.json`，只从受信构建产物解压；不要运行用户可写数据目录中的可执行文件。

## 客户端团队集成手册（逐步）

本节是给桌面客户端团队的实施清单。客户端负责安装/签名/启动 sidecar 和把 Agent URL 注入页面；Agent 负责本地会话、Pi 执行和主动访问 Manager。客户端不需要启动 Python、PostgreSQL、Operator 或 Manager。

### 1. 解压并规划目录

GitHub Actions 下载的 Artifact 还有一层 GitHub ZIP 包装。先解压 Artifact，再解压其中的真正 Agent 包：

- macOS：外层 ZIP → `aiteam-agent-*-darwin-*.tar.gz` → Agent 目录；
- Windows：外层 ZIP → `aiteam-agent-*-win32-*.zip` → Agent 目录。

建议安装目录不可写：

```text
macOS:  <Client>.app/Contents/Resources/agent/
Windows: C:\\Program Files\\<Vendor>\\<Client>\\resources\\agent\\
```

不要把 SQLite、Session、workspace、附件或可变配置写入上述目录。建议使用独立用户数据目录：

```text
macOS:  ~/Library/Application Support/<Vendor>/<Client>/agent-data/
Windows: %LOCALAPPDATA%\\<Vendor>\\<Client>\\agent-data\\
```

升级时替换安装目录，保留 `agent-data`；回滚时也只回滚安装目录，不删除数据目录。

### 2. 准备企业配置

客户端可以直接使用包内 `config/agent.env`，也可以把配置复制到用户数据目录之外，再通过 `--config` 指定。推荐使用外部配置，便于企业切换和客户端升级。

最小生产配置：

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

字段说明：

| 配置 | 客户端用途 |
|---|---|
| `AITEAM_MANAGER_URL` | 当前企业 Manager 实例；每企业可以不同，不能填 Docker 内部地址 |
| `AITEAM_AGENT_JWT_ISSUER` / `AUDIENCE` | Agent 验证 Manager 签发 token |
| `AITEAM_AGENT_JWKS_JSON` 或 `JWKS_PATH` | 只放 RSA public JWKS，不放私钥 |
| `AITEAM_SKILL_SIGNING_PUBLIC_KEY` | 验证 Manager 下发的签名 Skill，只放公钥 |
| `HOST` / `PORT` | 本地监听；桌面客户端必须保持 loopback |
| `AITEAM_AGENT_ALLOWED_ORIGINS` | 独立 WebView origin 的精确白名单，不支持 `*` |

配置优先级从高到低为：

1. 启动参数，例如 `--port`、`--data-dir`、`--manager-url`；
2. 客户端启动 Agent 时注入的进程环境变量；
3. `--config` 指定的 env 文件；
4. 启动器默认值。

Provider key、账号密码、Hindsight/LightRAG token、service token、JWT 私钥和 Skill 私钥都不能进入这个文件。Provider 凭据由 Manager 按员工授权短期下发到 Agent 进程内存。

### 3. 客户端启动 Agent

客户端原生代码应直接启动子进程，不依赖用户安装 Node，也不要依赖当前工作目录。

macOS 推荐 argv：

```text
<agent>/runtime/node
--import <agent>/node_modules/tsx/dist/esm/index.mjs
<agent>/bin/start-agent.mjs
--config <client-data>/agent.env
--port 0
--data-dir <client-data>/agent-data
```

Windows 推荐 argv：

```text
<agent>\\runtime\\node.exe
--import <agent>\\node_modules\\tsx\\dist\\esm\\index.mjs
<agent>\\bin\\start-agent.mjs
--config <client-data>\\agent.env
--port 0
--data-dir <client-data>\\agent-data
```

手工调试也可以使用：

```bash
# macOS
./bin/start-agent.sh --config /path/to/agent.env --port 0 --data-dir "/path/to/agent-data"
```

```powershell
# Windows
.\\bin\\start-agent.cmd --config C:\\path\\to\\agent.env --port 0 --data-dir C:\\path\\to\\agent-data
```

客户端启动选项：

- macOS 记录 stdout/stderr 到客户端私有日志，不要把会话正文上传到云端；
- Windows 使用 `CREATE_NO_WINDOW` 或等效的无控制台子进程选项；
- 只启动一个 Agent 实例，避免两个进程同时打开同一个 SQLite/Session 目录；
- 设置启动超时，例如 30 秒；超时后读取 stderr 并终止子进程，不要无限等待；
- 保存子进程 PID，但最终状态以 port file 和 HTTP 探针为准。

### 4. 检查 Agent 是否启动成功

Agent 启动后会在 `data-dir` 下生成：

```text
agent-port.json
```

内容类似：

```json
{
  "schema_version": 1,
  "pid": 12345,
  "host": "127.0.0.1",
  "port": 53124,
  "started_at": "2026-09-03T08:00:00.000Z"
}
```

客户端必须依次检查：

1. 文件存在且 JSON 可解析；
2. `host` 是 `127.0.0.1`、`localhost` 或 `::1`；
3. `port` 在 1–65535；
4. PID 仍然是 Agent 子进程；
5. `GET http://127.0.0.1:<port>/healthz` 返回 HTTP 200；
6. 页面需要本地执行时，再检查 `GET /readyz` 返回 HTTP 200 且 `data.ready=true`。

`/healthz` 只表示进程存活；`/readyz` 会检查本地数据库、工作目录和 sandbox。不能只看到进程存在就把页面标记为 ready。

客户端也可以监听 stdout 中的机器可读行：

```text
AI_TEAM_AGENT_READY {"host":"127.0.0.1","port":53124,"pid":12345}
```

port file 和 stdout 都没有出现时，视为启动失败。port file 可能是上一次崩溃留下的旧文件，必须重新检查 PID 和 `/healthz`，不能直接复用旧端口。

### 5. 将 Agent URL 注入客户端页面

浏览器/WebView 不能直接读取本地 `agent-port.json`。应由客户端原生层读取端口，再通过 preload、IPC 或页面初始化参数传给前端：

```text
agentBaseUrl = http://127.0.0.1:<port>
```

前端 API Client 应使用这个动态地址：

```ts
const client = new AgentApiClient({
  baseUrl: agentBaseUrl,
  getToken: () => localToken,
});
```

禁止在前端写死 `8180`，因为生产客户端应使用 `--port 0`。

如果客户端直接打开包内 Agent SPA：

```text
http://127.0.0.1:<port>/
```

页面和 Agent 同源，不需要 CORS。如果客户端页面来自自定义 scheme 或另一个 localhost 端口，则配置精确 origin：

```dotenv
AITEAM_AGENT_ALLOWED_ORIGINS=aiteam://desktop,http://127.0.0.1:5173
```

`file://` 页面通常发送 origin `null`，需要显式配置 `null`。CORS 配置修改后必须重启 Agent。

### 6. 检查 Manager 连接和登录链路

Agent 不直接连接 Operator。客户端页面只访问本地 Agent，由 Agent 主动访问配置的 Manager。

推荐在页面启动后的连接检查中按以下顺序执行：

1. 页面调用 `POST /api/auth/resolve-tenant-by-account`，根据账号解析企业；
2. 页面调用 `POST /api/agent/login`，密码只通过 HTTPS/本地请求传输，不写日志；
3. 保存返回的短期 token，使用安全的客户端会话存储；
4. 调用 `GET /api/agent/whoami`，确认 `tenant_id`、`user_id` 和 `roles`；
5. 调用 `POST /api/agent/grants/sync` 拉取当前成员授权投影；
6. 调用 `GET /api/agent/grants/readiness`，确认授权员工和 runtime 状态；
7. 最后再开放聊天、SSE 和本地执行按钮。

常见状态：

| 状态 | 含义 | 客户端处理 |
|---|---|---|
| `/healthz` 200 | Agent 进程存活 | 可以继续 readiness 检查 |
| `/readyz` 503 | 本地 DB/workspace/sandbox 未就绪 | 展示“本地执行不可用”，可保留登录页 |
| 登录 401/403 | 账号、token 或企业授权问题 | 清理本地 token，要求重新登录 |
| 登录/同步 503 | Manager 不可达 | 展示离线/稍后重试，不要伪造成功 |
| `/api/agent/grants/readiness` 中专家 blocked | 当前员工没有可用模型、Skill 或授权 | 禁用对应员工，不影响 Agent 进程存活 |

密码、token、完整请求体和会话正文不能写入客户端日志、诊断报告或 crash dump。

### 7. 客户端运行期间的请求约定

页面只调用以下本地路径：

```text
/api/agent/*
/api/auth/*
/healthz
/readyz
```

私聊/群聊事件使用 Agent SSE：

```text
GET /api/agent/conversations/{conversation_id}/events
```

页面不要：

- 直接请求 Manager 或 Operator；
- 读取 Agent SQLite 或 Session JSONL；
- 读取 Node runtime、workspace 或 Skill cache；
- 把 Manager/Hindsight/LightRAG 凭据注入浏览器；
- 把会话正文上传到客户端自己的云端日志。

### 8. 客户端退出、重启和升级

正常退出：

1. 禁止页面继续创建新 prompt；
2. 等待当前 UI 状态稳定，必要时调用 abort；
3. 向 Agent 子进程发送 SIGTERM/等效终止信号；
4. 等待进程退出，确认 `agent-port.json` 被清理；
5. 客户端退出。

异常退出时，下一次启动必须重新验证 PID、端口和 `/healthz`，不能相信旧 port file。

升级：

1. 停止旧 Agent；
2. 保留用户 `agent-data`；
3. 替换只读安装目录中的 sidecar；
4. 使用相同 `--config` 和 `--data-dir` 启动；
5. 重新执行 health/readiness/Manager 连接检查；
6. 失败时回滚安装目录，不能删除数据目录。

### 9. 客户端发布前验收清单

客户端团队至少应在每个目标 OS/架构执行：

- 安装后首次启动；
- 已安装客户端再次启动；
- 固定端口和随机端口；
- Agent 进程崩溃后的自动重启；
- Manager 暂时不可达后的恢复；
- 登录、whoami、授权同步、readiness；
- 私聊、群聊、SSE 断线重连；
- 客户端退出时 Agent 子进程确实退出；
- 升级/回滚后 SQLite、Session 和附件仍可读取；
- 自定义 WebView origin 的 CORS；
- Windows/macOS 的 code-sign、权限和防火墙行为；
- `manifest.json` 文件校验和安装目录不可写。

### 10. taiyi 测试包说明

本次 CI 的 `taiyi` 包是测试包：

```text
AITEAM_ENV=test
AITEAM_AGENT_DEV_AUTH=true
AITEAM_PI_FAKE=false
AITEAM_MANAGER_URL=http://121.40.78.201:8782
```

它用于连接 taiyi 测试 Manager，不是生产配置。运行机器必须能访问该测试地址；测试包使用 HTTP 和开发认证，不能复制到正式用户环境。

## 当前平台前置条件

- macOS 使用系统 Seatbelt (`sandbox-exec`)；须在目标 macOS 做 native readiness/deny 矩阵验证。
- Windows 当前依赖 `dsh-sandbox-windows-acl`。该后端提供文件写入限制，但上游明确不提供网络隔离、读侧隔离，且受限子进程的 piped-grandchild 输出存在边界；在 Windows production 发布前必须完成原生 sandbox hardening，不能仅凭“包能启动”宣称生产就绪。
- 因此构建脚本可以产出 Windows sidecar，但发布门禁必须阻止尚未通过 Windows sandbox 矩阵的 production 包；开发/联调包与生产包不要混用。
