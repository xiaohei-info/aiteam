# macOS 后台与 Agent 接入（2026-09-10）

桌面 HTTP 接口统一以 [8783 Swagger 文档](http://121.40.78.201:8783/docs)及其 [OpenAPI](http://121.40.78.201:8783/openapi.json) 为准。后台业务和本机 Agent 业务使用同一份路由契约，仅目标地址不同；不再使用 Manager / Operator 的独立接口契约。

> **已实施（2026-10-20）**：桌面端只连本机 Agent。本机 Agent 处理身份、授权同步和本地目录，其余契约内的请求转发到远端 Agent（`AITEAM_AGENT_UPSTREAM_URL`）。下表“桌面目标”一列在桌面端都应读作“本机 Agent，再转发到该远端地址”；浏览器开发仍按下文代理。Tauri capability 和 CSP 里的 8783 暂未删除，待清理。实施记录见 [方案文档](plans/2026-10-19-local-directory-remote-session-gap.md) 第 11 节。

## 服务与身份

| 业务 | 客户端 | 桌面目标与接口 |
| --- | --- | --- |
| 登录、重置密码、账号解析 | `backendApi` | `VITE_BACKEND_BASE_URL`，缺省 TEST `http://121.40.78.201:8783`；`/api/auth/resolve-tenant-by-account`、`/api/agent/login`、`/api/agent/reset-password` |
| 组织、人才市场、员工信息、语音转写 | `backendApi` | 同上；`/api/agent/org/tree`、`/api/agent/marketplace/templates`、`/api/agent/grants/experts`、`/api/agent/audio/transcriptions` |
| 会话、附件、产物、事件流、工作记录、用量、办公状态 | `agentApi` | `VITE_BACKEND_BASE_URL`，缺省 `http://121.40.78.201:8783`；会话创建、历史、prompt、SSE、附件和已读均使用该远端 Agent |
| 远端会话使用的员工、方案及就绪检查 | `agentApi` | 远端 `/api/agent/grants/experts`、`/solutions`、`/experts/{employee_id}/readiness` |
| 本地目录登记、员工绑定、撤销、引用核验 | `agentApi`（`getLocalClient`） | IPC 发现的本机 Agent 端口；`/api/agent/local-directories/**`、`/api/agent/local-directory-citations/{citation_id}/verify`。只有本机 Agent 有桌面宿主的授权通道 |

桌面开发和发布均使用原生 HTTP。所有请求（`backendApi`、`agentApi` 与 SSE）都发往 IPC 发现的本机 Agent，由它转发到远端 Agent；会话及执行数据仍保存在远端，与网页共用。本机身份校验、授权同步和本地目录接口由本机 Agent 自己处理。后台与本机使用同一企业登录凭证，登录后通过本机 `whoami` 核对企业及成员，再保存到系统凭证库。

登录填写企业代码或名称时，通过 `enterprise` 字段直接远端 login；留空时先按账号 resolve，使用内部 `tenant_id` 登录；随后本机 whoami 验证身份，携带同一 token 调用 grants/sync（tenant_id、member_id、known_versions: {}），最后检查 grants/readiness。登录、改密后登录和恢复会话均执行同步；失败不开放工作台，恢复失败保留凭证供重试。同步加载专家、方案和授权配置，不包含远端聊天历史；客户端不直接读取快照。

`src/api/agent/contract.ts` 校验请求方法与路径；拒绝文档外路径，并排除快照直接读取；授权同步已允许。新接口必须先有文档契约，再更新客户端。客户端不再请求 `/api/manager/*` 或 `/api/operator/*`。分发包内部依赖的 `AITEAM_MANAGER_URL` 是 Agent 自身配置，不属于 WebView 接口分流。

独立浏览器开发：`/backend-api` 代理到 `VITE_BACKEND_BASE_URL`；`/api`、`/healthz`、`/readyz` 代理到 `VITE_AGENT_BASE_URL` / `VITE_API_BASE_URL`，未配置时两者均使用 TEST 8783。桌面端所有请求都使用 IPC 地址，由本机 Agent 转发。

正式部署应设置 `VITE_BACKEND_BASE_URL` 并同步配置 Tauri capability / CSP 的 HTTPS origin；TEST 地址只用于联调。

## 本机 Agent 安装与打包

Agent 完整资源已纳入 Git，超过 100 MB 的 `runtime/node` 以 `runtime/node.gz` 无损保存，避免当前 Gitee 仓库不支持 LFS 的限制。克隆后运行 `pnpm agent:check`，按 manifest 校验并恢复可执行文件；桌面启动和构建会自动执行。后续使用 `pnpm agent:import` 更新时自动重建压缩文件。Actions 产物是生产配置模板，当前只有一个环境，`pnpm agent:import` 导入时会自动把 `config/agent/taiyi-test.env` 固化进随包（dev 与打包共用）；增加正式环境时仍需部署方提供有效配置与公钥。

1. 通过部署方提供的可信通道取得包含本轮新接口的对应 CPU 架构完整 macOS Agent 分发包，将其解压到 `src-tauri/resources/agent/`。必须包含 runtime/node、node_modules/tsx、bin/start-agent.mjs、config/agent.env，以及文件型 JWKS 对应的公钥文件。
2. 由部署方确认 Manager URL、JWT issuer/audience、可信 RSA JWKS、技能验证公钥和可选 RAG MCP 配置。禁止打包密码、私钥、service token 或模型/知识服务凭据。
3. 通过 `pnpm agent:import <artifact.zip>` 导入具有 manifest 的完整 darwin-arm64 包（当前会自动固化唯一环境的配置；使用其它配置时运行 `pnpm agent:configure <enterprise-agent.env>` 将企业公共配置（含配套 JWKS）固化进随包 `config/`），再运行 `pnpm agent:check`、`pnpm check:agent-package` 并执行 `pnpm tauri:build:mac:installer`。`check:agent-package` 会拒绝仍是配置模板的包（`manifest.configured=false`）：客户机没有 `agent.env` 时 Agent 会直接拒绝启动，只改 `config/` 而不刷新 manifest 也会被拒。当前导入工具与发布构建限定 Apple Silicon macOS；Intel 需要对应架构运行包并更新平台集成后再构建。普通 `pnpm build` 只校验和构建前端，不生成可独立运行的本机 Agent 安装包。
桌面开发联调使用 `pnpm tauri dev --config src-tauri/tauri.agent.conf.json`，同样需要上述本机包和公共配置。

4. 宿主按 manifest hash 将随包配置和 JWKS 成套复制到应用数据目录，优先使用 `AITEAM_AGENT_CONFIG` 或管理员自定义 `agent.env`，用 `--host 127.0.0.1 --port 0 --data-dir <app-data>/agent-data` 启动。保留 DATA_DIR，并将进程输出保存到本机 agent.log。
5. 宿主持有跨进程文件锁，校验端口文件 schema / 当前 child PID / loopback / 合法端口，并检查 healthz、readyz 和本轮新增 OpenAPI 路由。子进程退出后重新启动和发现，退出客户端时终止并等待 child。
6. 升级或轮换由安装流程在停止 Agent 后替换完整分发目录及应用数据目录的公共配置、配套 JWKS；保留自定义设置和 `agent-data`。先分发新旧可信公钥并重启，再切换签名，最后受控移除旧 key。公钥不从未知地址自动发现。

`check:agent-package` 是结构、配置完整性与配置引用校验，不代替正式签名、CPU 架构、纯净 macOS、原生 sandbox 或发行验收。

## 环境切换（测试 / 生产）

桌面端只连本机 Agent，连接哪个后台由 Agent 的环境配置决定（`AITEAM_MANAGER_URL`、`AITEAM_AGENT_UPSTREAM_URL`、JWKS 等），与前端代码无关。环境配置放在 `config/agent/`：

| 环境 | 命令 | 配置 |
| --- | --- | --- |
| 测试 | `pnpm dev:test` | `config/agent/taiyi-test.env`（已入库） |
| 生产 | `pnpm dev:prod` | `config/agent/production.env`（由部署方提供，模板见 `config/agent/production.env.example`） |

- 命令会先校验配置，再停止已在运行的开发实例，最后用所选配置启动 `pnpm tauri dev`。配置通过 `AITEAM_AGENT_CONFIG` 指定，优先于随包配置和应用数据目录里的 `agent.env`，因此不受它们影响。
- `pnpm dev:status` 显示当前实例连接的环境，`pnpm dev:stop` 只停止不启动。
- 校验规则：`AITEAM_ENV` 必须与环境一致（test / production）；生产配置必须是 HTTPS、issuer 与 Manager 地址逐字一致、带公钥和技能验签公钥，且不能是 example.com 占位地址；JWKS 只能含 kty/alg/kid/n/e/use。校验不通过时不会停止正在运行的实例。
- 切换环境后原登录令牌来自另一个后台，需要重新登录。生产环境的写操作（如添加部门）会真实生效，客户端无法撤销。
- 这两个命令只影响开发联调。打包仍用 `pnpm agent:configure <env 文件>` 固化配置；`pnpm agent:configure:test` 会往应用数据目录写 `agent.env`，让这台机器上的打包应用固定使用测试配置。
- `src/lib/portals.ts` 与 `src-tauri/src/external_links.rs` 里的后台入口链接目前固定为测试地址，生产环境需要随之调整。

## 业务能力边界

- 人才市场列表与详情使用文档中的 templates 接口，保留真实字段和未知值；文档未提供招募接口，招募入口禁用。
- 组织架构可读取，员工列表表示当前身份在后台可见的授权员工。企业所有者/管理员（owner、enterprise_admin）可在客户端添加部门、为员工追加所属部门；请求由本机 Agent 转发给 Manager（`POST /api/agent/org/departments`、`PATCH /api/agent/org/assignments/{employee_id}`），角色以 Manager 校验为准。部门重命名、删除、员工移出或调动，以及岗位、绑定和记忆配置写入均未开放。
- 文档中的 `GET /api/agent/knowledge-bases` 明确返回 410，页面如实显示不可用。上传、编辑、绑定和重试不会回退调用 Manager。
- 群聊使用远端 Agent 的方案与员工授权；组织树只提供筛选信息，不能扩大可执行成员范围。
- 会话附件与产物保留授权二进制下载及原生保存；SSE 和会话一样连接远端 Agent（`src/api/agent/events.ts` 使用 `resolveBackendBaseUrl`）。
- 工作记录、用量与办公状态和会话一样来自远端 Agent。
- 授权目录只登记在本机 Agent，远端会话目前用不到它，原因和方案见 [方案文档](plans/2026-10-19-local-directory-remote-session-gap.md)。

## 全量接口核对

[api.json](api.json) 已替换为当前 8783 OpenAPI，逐项调用位置见 [核对表](api-audit.md)。Manager 遗留类型、原生任意 URL 二进制预览通道与模拟技能 API 已移除；消息附件使用文档中的会话附件下载。本地文件预览保留，文档未提供的远程知识预览禁用。

## 验证

- `pnpm check:api-contract`：全量文档方法/路径与客户端调用核对，CI 必须通过。

- `pnpm test`：业务回归。
- `pnpm agent:test`：真实客户端与登录 store 的模拟传输回归，验证远端登录、本机身份核对、授权同步顺序、无快照直读请求、动态端口、SSE 与浏览器代理。
- `pnpm check:service-clients`：文档路径校验、授权下载、JSON 上传与 envelope。
- `pnpm build`、`pnpm lint`、`pnpm check:tauri-security`、`pnpm check:secure-auth`、`pnpm check:sensitive-logs`。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`：端口发现、进程管理与原生 HTTP scope；真实包 smoke 测试见 [Agent 安装说明](agent-sidecar.md)。

模拟测试不代表真实账号及本机授权员工已完成对话验收。修改原生 HTTP capability 后需重新编译并重启桌面进程。

企业标识入口要求 Agent 服务的登录和改密 schema 支持 `enterprise`（与内部 `tenant_id` 至少提供一个）。Manager 已支持企业代码或名称解析。本次同步修改 FredServer Agent 源码和随包运行文件，远端 8783 须部署对应版本后才支持新请求。`docs/api.json` 保留抓取时的线上契约，部署后应重新抓取更新。强制改密沿用 enterprise；会话和授权同步仍使用返回 claims 中的内部 tenant_id。
