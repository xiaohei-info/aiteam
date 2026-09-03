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

## 当前平台前置条件

- macOS 使用系统 Seatbelt (`sandbox-exec`)；须在目标 macOS 做 native readiness/deny 矩阵验证。
- Windows 当前依赖 `dsh-sandbox-windows-acl`。该后端提供文件写入限制，但上游明确不提供网络隔离、读侧隔离，且受限子进程的 piped-grandchild 输出存在边界；在 Windows production 发布前必须完成原生 sandbox hardening，不能仅凭“包能启动”宣称生产就绪。
- 因此构建脚本可以产出 Windows sidecar，但发布门禁必须阻止尚未通过 Windows sandbox 矩阵的 production 包；开发/联调包与生产包不要混用。
