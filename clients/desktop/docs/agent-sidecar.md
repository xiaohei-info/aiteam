# 本机 Agent 集成（macOS ARM64）

桌面端随包内嵌用户端 Agent（本仓库 `server/agent_service`），启动时拉起它，并通过 `get_agent_base_url` IPC 取得经过健康校验的动态本地地址。WebView 的全部请求（`agentApi`、`backendApi` 和会话 SSE）都发往这个本机 Agent；本机地址不可用时不回退到远程 Agent。用户配置与数据存放在应用数据目录，不进仓库。

## 当前架构（2026-10-23 起）

- 会话、附件、审批、工作记录、用量、记忆等都由本机 Agent 执行和落库。本机 Agent 直接访问 Manager（`AITEAM_MANAGER_URL`），自己处理登录、`whoami`、授权同步和本地目录。
- 不再转发到远端 Agent：`server/agent_service` 已不读取 `AITEAM_AGENT_UPSTREAM_URL`。`scripts/configure-agent-package.mjs`、`scripts/dev-env.mjs` 和 `config/agent/production.env.example` 仍校验或显示这个变量，属于待清理的遗留。
- 员工检索授权目录走本机会话里的 `local_dir_search` / `local_dir_read` 工具（`server/agent_service/src/pi/local-directory-tools.ts`），设计见[本地目录检索技术设计](plans/local-directory-knowledge-design.md)。2026-10-20 至 10-23 的网关模式曾把检索结果以 `<aiteam-local-context>` 块附在消息末尾，前端 `src/lib/localContextBlock.ts` 仍会把旧消息里的这个块收起显示；网关方案见[归档](archive/plans/2026-10-19-local-directory-remote-session-gap.md)。
- 接口路由、登录流程和客户端能力边界见下文「接口与登录」。

## 构建随包 Agent

随包 Agent 不入库（`src-tauri/resources/` 在 `.gitignore` 里），从同一提交的后端源码构建，前后端版本由提交天然对齐：

```bash
pnpm agent:build          # 构建 server/agent_service 与 web/agent，打成 darwin-arm64 包并导入 src-tauri/resources/agent
pnpm agent:check          # 按 manifest 校验并还原 runtime/node，打印版本
pnpm tauri dev
pnpm tauri:build:mac:arm64
```

- `agent:build`（`scripts/build-agent.mjs`）调用仓库根的 `scripts/build-agent-package.mjs`：在 `server/agent_service` 和 `web/` 执行 `pnpm install --frozen-lockfile` 并构建，产物放在仓库根 `dist/agent-packages/`，再交给 `agent:import` 导入。只能在 Apple Silicon macOS 上运行；额外参数原样传给打包脚本，例如 `pnpm agent:build --skip-build` 复用已有构建产物。
- 版本号为 `<agent_service 版本>-src.<提交号>`；`server/agent_service` 或 `web/` 有未提交改动时再加 `.dirty`，方便确认装的是哪份代码。
- 也可以导入 GitHub Actions `agent-package` 工作流的产物：`pnpm agent:import <artifact.zip | package.tar.gz | 包目录>`。
- 导入时按 manifest 检查每个文件的大小与 SHA-256；Node 以 `runtime/node.gz` 存放，由 `agent:check` 还原并设置执行权限，桌面开发和构建会自动执行。完整目录由 Tauri 复制到 `AIFred.app/Contents/Resources/agent/`，包含 Node 运行时、原生依赖、启动器和配置，用户机器无需安装 Node。
- 导入的包仍是配置模板（`configured=false`）时，会自动固化下一节的测试配置，导入后 manifest 为 `configured=true`、`config_source=provided`。Rust 构建会拒绝其他架构，避免生成无法运行的安装包。

## 当前唯一环境的配置（dev 与打包共用）

目前只有一个环境，即 taiyi TEST（Manager `8782`），`pnpm tauri dev` 和打包出的安装包使用同一份配置，保存在 `config/agent/taiyi-test.env`（与 FredServer `.env.test.example` 及 `scripts/ctl.sh --env test` 对齐）：

- `pnpm agent:build` / `pnpm agent:import` 导入后自动运行 `agent:configure`，把这份配置写入随包 `config/agent.env` 并刷新 `manifest.json`。
- 因此 `pnpm tauri dev` 和 `pnpm tauri:build:mac:installer` 都不需要再手动配置；`pnpm check:agent-package` 也能直接通过。
- 需要改配置时，修改 `config/agent/taiyi-test.env` 后运行 `pnpm agent:configure config/agent/taiyi-test.env`（或重新 `pnpm agent:build`）；随包目录不入库，只提交 env 文件。

配置使用 `AITEAM_ENV=test`、`AITEAM_AGENT_DEV_AUTH=false`、`AITEAM_PI_FAKE=false` 和 `AITEAM_MANAGER_URL=http://121.40.78.201:8782`。登录调用真实 Manager 校验账号密码；**本机 Agent 对 Bearer 做真实 RS256 验签**，`AITEAM_AGENT_JWKS_MODE=manager` 按租户从 Manager 拉取公钥（见下文「固定 Manager 验签模式」），随包不再携带静态公钥，新增租户或 Manager 轮换密钥都不需要重新打包。issuer/audience 为 Manager 默认的 `aiteam-manager`/`aiteam-agent`。不使用开发认证，是因为本地目录知识（`/api/agent/local-directories`）要求"已验证的调用者"，开发认证下该接口一律 403。`config/agent/taiyi-test-jwks.json` 是静态验签模式时代留下的公钥文件，当前配置不再引用。增加正式环境时，给它单独的 env 文件（见下一节），不要沿用这份配置。

`~/Library/Application Support/com.aiteam.desktop/agent.env` 仍然优先于随包配置，仅用于覆盖；`pnpm agent:configure:test` 会把同一份配置（连同它引用的公钥文件）写到这个位置，现在只在需要本机覆盖时才用得上。**覆盖文件不会随包更新**：如果本机留有旧的开发认证 `agent.env`，它会一直盖住随包配置，导致本地目录检索 403；删除或改名该文件即可回到随包配置。

无账号密码也可验证启动和 Manager 只读连通性：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --offline test_profile_startup_and_manager_connection -- --ignored --nocapture
```

测试以独立临时目录启动随包 Agent，检查 healthz/readyz、无 Bearer 请求返回 401，再使用随机不存在账号确认请求已到达 Manager（404，非连接失败的 503）。不代表真实账号已成功登录。

## 正式环境必需的企业公共配置

**打包脚本产出的配置是生产模板**（导入时会被上一节的配置替换）：`config/agent.env` 中 Manager 为 `https://manager.example.com`，公共 JWKS 和技能验签公钥为空，没有配置覆盖时 Agent 会拒绝启动。以下内容只在将来增加正式环境时需要：正式环境需要有效的 `agent.env` 和配套公共 JWKS，包括：

- `AITEAM_MANAGER_URL`：Manager 正式 HTTPS 地址。
- `AITEAM_AGENT_JWT_ISSUER`、`AITEAM_AGENT_JWT_AUDIENCE`：与 Manager 签发的 JWT 完全一致。
- `AITEAM_AGENT_JWKS_PATH` 或 `AITEAM_AGENT_JWKS_JSON`：可信 RSA 公共 JWKS，二选一。
- `AITEAM_SKILL_SIGNING_PUBLIC_KEY`、`AITEAM_SKILL_SIGNING_KEY_ID`：技能验签公共信息。

### 固定 Manager 验签模式（仅太乙 TEST）

源码 `6f8ec811`（Actions run 39125312324）起，Agent 支持 `AITEAM_AGENT_JWKS_MODE=manager`：从固定的 `AITEAM_MANAGER_URL` origin（不能带路径、用户信息、query 或 fragment，禁止重定向）按租户拉取 `/api/auth/{tenant_id}/jwks.json`，不再需要静态 JWKS。该模式与 `AITEAM_AGENT_DEV_AUTH`、静态 JWKS 互斥，同时配置会在监听前失败；issuer/audience 缺省按 Manager 的 `aiteam-manager`/`aiteam-agent` 取值。默认仍是 `static`。`fba600c3` 起生产 launch guard 也接受 manager 模式（不得同时配置静态 JWKS），`check:agent-package` 已同步；当前随包 `config/agent.env`（`AITEAM_ENV=test`）使用 manager 模式；桌面端 Rust 预检（`incomplete_enterprise_config`）也只在 `AITEAM_ENV=production` 时检查静态 JWKS。

无论哪种模式，只要不是开发认证，登录（`/api/agent/login`）与重置密码成功后，提供这两个接口的 Agent 都会先对 Manager 返回的 token 做本地 RS256 验签，claims 取自已验证的 token。桌面端的登录由随包 Agent 处理，所以验签就在本机执行；`whoami`、授权同步等请求同样校验 Bearer。验签失败（公钥不匹配、系统时间偏差、issuer/audience 不符）与 Manager 不可达一样返回 HTTP 503 `manager_unavailable`，只有 `detail` 为 `Manager token failed local verification` 时才是前者；登录页据此给出“核对公钥配置和系统时间”的提示（`src/lib/loginServiceError.ts`）。manager 模式下进程重启或缓存淘汰后需重新登录，公钥缓存 60 秒到期。详见包内 `CLIENT-INTEGRATION.md` 和上游 `deploy/ci/TAIYI-PUBLIC-LOGIN.md`。

### 新版 Agent 的行为变化（run 39125312324）

以下行为由随包 Agent 提供。

- 自选成员群：`PATCH /conversations/{id}/participants` 增减成员、`PUT /conversations/{id}/orchestration` 整体替换编排；会话执行中返回 409，移出的成员保留历史发言，重新加入沿用原 Session。**只有保存了编排规则的自选成员群可编辑**，方案创建的群、没有编排规则的旧群会被拒绝（422 `invalid_group_configuration`），前端对这些群把“管理成员”置灰并提示“仅自选成员群支持增减成员”。前端按本机 Agent 的 `/openapi.json` 探测后启用（`src/api/agent/customGroups.ts`）。
- 完全访问会话：`permission_mode=full-access` 下，`bash`/`write`/`edit` 调用由策略自动批准（审批记录 `approved_by=policy:full-access`，不再推送 `approval_required`）；外部连接器和未知工具仍需人工审批。
- 审批摘要不再把路径替换为“路径已隐藏”，仅隐藏 token、密钥等敏感字段。

### 增加正式环境后：把配置固化进安装包

客户机没有 `agent.env` 时只会看到启动失败或超时，所以 DMG 必须自带完整配置。当前由 `agent:build` / `agent:import` 自动完成；换成正式配置时手动执行：

```bash
pnpm agent:configure /path/to/enterprise-agent.env   # 校验并写入随包 config/，刷新 manifest.json
pnpm agent:check && pnpm check:agent-package         # 校验包完整性与配置完整性
pnpm tauri:build:mac:installer                       # 打包 DMG（脚本内部也会再跑一次配置检查）
```

`tauri build` 的 `beforeBuildCommand` 也会运行 `agent:check` 和 `check:agent-package`，所以 `pnpm tauri:build:mac:arm64` 等其它打包命令不会再打出带模板配置的包。注意：`agent:import` 只在导入的包仍是模板时自动固化测试配置，用上面的命令换成正式配置后，下次 `agent:build` 或重新导入会被改回测试配置，所以增加正式环境时需要同步调整 `scripts/import-agent.mjs` 选用的配置文件。

`agent:configure` 会把 env 与相对路径引用的公共 JWKS 一并复制进去、把相对 JWKS 路径改写为文件基名、校验 JWKS/技能公钥格式，并把 `manifest.json` 的 `configured` 置为 true、`config_source` 置为 `provided`、重新计算 `config/**` 的哈希。**必须刷新 manifest**：manifest 的哈希同时是随包配置复制目录（`agent-config/<hash>/`）的缓存键，只改 `config/` 而不刷新 manifest 会让已运行过的机器继续使用旧配置。`scripts/check-agent.mjs` 会拒绝这种不一致。

`pnpm check:agent-package` 现在要求随包配置完整（生产环境必须有 HTTPS Manager、逐字一致的 issuer、JWKS 与技能验签公钥），否则直接失败，避免把模板包交给客户。仅在内部联调、依赖本机 `agent.env` 时可用 `AITEAM_ALLOW_TEMPLATE_AGENT=1` 跳过这条检查。

使用外部配置启动：

```bash
AITEAM_AGENT_CONFIG=/absolute/path/to/agent.env pnpm tauri dev
```

也可以将实际配置放到 `~/Library/Application Support/com.aiteam.desktop/agent.env`，适用于从 Finder 启动安装后的应用。相对 JWKS 路径以该 env 文件所在目录为基准，必须一并放置对应文件。配置为数据文件，不执行 shell 展开。不需要也不应提供 Manager 私钥、用户密码或服务端密钥。

当前包在 production 模式下还要求 Manager URL 与 issuer 完全相等；若部署配置不符合，应由服务端提供匹配的包或配置，客户端不改写 issuer 或放宽验签。

## 生命周期与存储

应用数据根目录为 Tauri 的 `app_data_dir`，macOS 默认：

```text
~/Library/Application Support/com.aiteam.desktop/
├── desktop.lock                 # OS 单实例锁，退出/崩溃后自动释放锁
├── agent.env                    # 可选，管理员自定义配置
├── manager-jwks.json            # 可选，自定义配置引用的公共 JWKS
├── agent-config/<manifest-hash>/ # 自动复制的随包完整配置目录
├── agent-data/                  # Agent SQLite、会话、工作目录；升级时保留
├── agent.log                    # 当前进程 stdout/stderr，仅保留在本地
└── agent.previous.log           # 上次启动日志
```

配置优先级：`AITEAM_AGENT_CONFIG` → 数据根目录 `agent.env` → 随包配置副本。不同包的 manifest hash 对应独立配置副本，因此升级时 env 与 JWKS 成套更新，不覆盖管理员配置或 `agent-data`。使用管理员配置时，公钥轮换由管理员同步更新配置文件并重启应用。

宿主以绝对路径执行 `runtime/node --import …/tsx/dist/esm/index.mjs …/bin/start-agent.mjs --config … --host 127.0.0.1 --port 0 --data-dir …`，接管日志并保存进程句柄。它校验 `agent-port.json` 的 schema、PID、loopback 和端口范围，依次检查 `/healthz` HTTP 200、`/readyz` HTTP 200 且 `data.ready=true`，最长等待约 30 秒。随后检查 OpenAPI 中的群成员、消息搜索、工作历史及用量接口；全部通过后才恢复会话、开放业务页面。

配置缺失、异常退出或超时会显示启动错误和日志位置。宿主在启动前会先检查生效的 `agent.env`：production 模式若缺少企业公共 JWKS 或技能验签公钥，会立即以“企业公共配置不完整”的配置错误结束，而不是等 30 秒健康检查超时；客户端会把它归为 `BACKEND_CONFIGURATION_ERROR`。子进程在就绪前退出时，`desktop.jsonl` 会写入 `agent.exited_early`（含 `exit_code`），配置预检失败写入 `agent.config_incomplete`（含原因 code）。子进程的原始输出仍是隐私边界内不落盘的内容，日志中只有 `agent.unstructured_output_omitted` 提示存在非 JSON 输出；排查真实报错需手工运行随包 Node 与启动器：

```bash
A=/Applications/AIFred.app/Contents/Resources/agent
"$A/runtime/node" --import "$A/node_modules/tsx/dist/esm/index.mjs" "$A/bin/start-agent.mjs" \
  --config "$HOME/Library/Application Support/com.aiteam.desktop/agent-config/$(ls "$HOME/Library/Application Support/com.aiteam.desktop/agent-config" | head -1)/agent.env" \
  --host 127.0.0.1 --port 0 --data-dir /tmp/aifred-agent-probe
```

退出应用时向 Agent 独立进程组发送 SIGTERM，等待最多 5 秒，再清理残留子进程并回收句柄。已就绪的 Agent 异常退出后，下一次 API 或 SSE 请求会触发重新启动、端口发现及契约校验。启动配置错误仍需修正配置后重启桌面应用。

## 浏览器调试

`pnpm dev` 不启动桌面宿主。需手工启动已配置的 Agent，再把端口文件中的地址传给 Vite：

```bash
src-tauri/resources/agent/bin/start-agent.sh \
  --config /absolute/path/to/agent.env --port 0 \
  --data-dir /absolute/path/to/browser-agent-data
# 从该数据目录的 agent-port.json 读取本次端口，示例为 53124：
VITE_AGENT_BASE_URL=http://127.0.0.1:53124 pnpm dev
```

纯浏览器开发未显式配置时默认代理到 TEST Agent；手工启动本机 Agent 时按上述示例覆盖地址。纯浏览器开发请求通过 Vite 代理；桌面模式忽略这个地址覆盖，始终使用 IPC 获取的本地端口。

## 环境切换（测试 / 生产）

桌面端只连本机 Agent，连接哪个后台由 Agent 的环境配置决定（`AITEAM_MANAGER_URL`、验签模式等），与前端代码无关。环境配置放在 `config/agent/`：

| 环境 | 命令 | 配置 |
| --- | --- | --- |
| 测试 | `pnpm dev:test` | `config/agent/taiyi-test.env`（已入库） |
| 生产 | `pnpm dev:prod` | `config/agent/production.env`（由部署方提供，模板见 `config/agent/production.env.example`） |

- 命令先校验配置，再停止已在运行的开发实例，最后用所选配置启动 `pnpm tauri dev`。配置通过 `AITEAM_AGENT_CONFIG` 指定，优先于随包配置和应用数据目录里的 `agent.env`。
- `pnpm dev:status` 显示当前实例连接的环境，`pnpm dev:stop` 只停止不启动。
- 校验规则：`AITEAM_ENV` 必须与环境一致（test / production）；生产配置必须是 HTTPS、issuer 与 Manager 地址逐字一致、带公钥和技能验签公钥，且不能是 example.com 占位地址。校验不通过时不会停止正在运行的实例。
- 切换环境后原登录令牌来自另一个后台，需要重新登录。生产环境的写操作（如添加部门）会真实生效，客户端无法撤销。
- 这两个命令只影响开发联调；打包仍用 `pnpm agent:configure <env 文件>` 固化配置。`src/lib/portals.ts` 与 `src-tauri/src/external_links.rs` 里的后台入口链接目前固定为测试地址，生产环境需要随之调整。

## 接口与登录

- **路由**：桌面端 `backendApi`、`agentApi` 和会话事件流都走 `resolveBackendBaseUrl()`，在桌面端返回 IPC 发现的本机 Agent 地址（`src/api/backend/config.ts`）。本机 Agent 不可用时不回退到远端。
- **例外**：企业知识库的浏览和上传仍由客户端直连 Manager `/api/manager/knowledge-spaces`；个人知识库服务由客户端直连，见 [工作入口说明](workspace-functions.md#三类知识来源)。
- **登录流程**：账号解析及登录 → `whoami` 身份核对 → `grants/sync` 授权同步 → `grants/readiness`，全部由本机 Agent 处理；任一步失败都不会开放工作台。登录填写企业代码或名称时直接用 `enterprise` 字段登录，留空时先按账号 resolve 出内部 `tenant_id`。登录、改密后登录和恢复会话都会同步授权；恢复失败保留凭证供重试。客户端不请求 `grants/snapshots`。`src/api/agent/index.ts` 的 `getLocalClient` 单独保留，区别只是本地目录面板的 401 不触发登出。
- **接口白名单**：`src/api/agent/contract.ts` 校验请求方法与路径，拒绝契约外路径；新接口要先进 `server/agent_service` 的 OpenAPI，再更新客户端。`pnpm check:api-contract` 用 `docs/api.json` 核对全部调用点，`--write-report` 重新生成 [api-audit.md](api-audit.md)。**已知问题**：`docs/api.json` 仍是 2026-09-10 从 TEST 8783 抓取的副本，没有包含本机 Agent 后来新增的路由，所以该检查目前失败；应改为从 `server/agent_service` 导出 OpenAPI。
- **浏览器开发（`pnpm dev`）**：不启动桌面宿主，经 Vite 的 `/backend-api` 代理到 `VITE_BACKEND_BASE_URL`，`/api`、`/healthz`、`/readyz` 代理到 `VITE_AGENT_BASE_URL`；未配置时都指向 TEST 8783（`src/api/agent/config.ts` 的 `TEST_AGENT_BASE_URL`）。要验证本机 Agent 的新接口，按上一节手工启动 Agent 并覆盖地址。
- **遗留的 8783 配置**：Tauri capability（`src-tauri/capabilities/default.json`）、CSP（`tauri.conf.json`）、`scripts/check-tauri-security.mjs` 和后台入口链接（`src/lib/portals.ts`、`src-tauri/src/external_links.rs`）里仍有 TEST 8783，桌面端运行时已不访问它，待清理。

### 请求日志

开发模式下，在 WebView 开发者工具的 Console 筛选 `AgentApi`、`BackendApi` 或 `AgentSse`。每次请求只记录两条：开始时显示方法、URL、query/body 参数；完成时显示同一编号、HTTP 状态与响应结果。密码、token、账号等字段脱敏，大数组只显示前 3 项、长字符串最多 200 字符，每段参数或结果最多 1500 字符。SSE 只记录连接结果，不打印每条事件。桌面原生 HTTP 通常不显示在 WebView Network 面板；浏览器代理目标可在 Vite 终端的 `[Vite proxy]` 查看。发布构建关闭请求日志。

### 网络权限

若 Agent 健康检查正常，但登录提示应用网络权限不足，检查 `src-tauri/capabilities/default.json`。HTTP 插件使用 URLPattern 解析整组 scope；未转义的 `http://[::1]:*/**` 会触发解析错误，即使请求目标是 IPv4 也会失败。本地 sidecar 固定监听 `127.0.0.1`，白名单不需要这条 IPv6 规则。修改 capability 后需要重新编译并重启桌面进程，前端热更新无法替换已加载的原生权限。

`cargo test --manifest-path src-tauri/Cargo.toml --test http_scope` 使用与 HTTP 插件一致的 URLPattern 引擎，校验所有白名单条目可解析、动态端口与登录/SSE 路由可访问，以及非白名单来源仍被拒绝。

## 验证

```bash
pnpm build
pnpm agent:test
cargo test --manifest-path src-tauri/Cargo.toml --offline
cargo test --manifest-path src-tauri/Cargo.toml --offline packaged_agent_smoke -- --ignored --nocapture
# 构建 ARM64 .app 后验证应用包内的 Agent：
cargo test --manifest-path src-tauri/Cargo.toml --offline bundled_agent_smoke -- --ignored --nocapture
```

前端测试覆盖桌面开发/生产下 API 与 SSE 动态地址一致、启动失败无远程回退及浏览器代理。Rust 测试覆盖非法/陈旧端口文件和单实例锁。显式 smoke 测试使用临时目录与现场生成的测试公共密钥，启动真实随包 Node，检查 healthz/readyz、优雅退出及第二次启动后 SQLite 数据保留；它不登录 Manager，也不修改交付配置。可通过 `AITEAM_SMOKE_AGENT_DIR` 指向构建后 app 内的 `Contents/Resources/agent`，验证资源打包完整性。

真实账号登录与实际对话需要有效企业配置和本机授权数据另行验收。

2026-09-09 验证结果：前端构建、4 项 API/SSE 传输测试、2 项 Rust 单元测试、源资源及应用包内 Agent 的 smoke 测试均通过。ARM64 `.app` 已生成，包内 manifest 的 23,742 个文件 SHA-256 全部匹配。Smoke 测试均使用临时测试公共密钥；交付包仍保留原始模板配置。
