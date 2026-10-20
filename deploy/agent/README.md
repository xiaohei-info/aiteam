# Agent sidecar 打包

Agent 作为本地 sidecar 随 macOS/Windows 客户端安装。客户端集成只需阅读包内 [`CLIENT-INTEGRATION.md`](CLIENT-INTEGRATION.md)。

## CI 打包

运行 GitHub Actions workflow：

```text
agent-package
```

参数：

```text
release_environment = 企业配置所在 GitHub Environment
a package_version    = 可选版本号
include_darwin_x64   = 是否同时构建 Intel macOS
```

GitHub Environment 可配置 multiline secret：

```text
AITEAM_AGENT_PACKAGE_CONFIG
```

其内容来自 [`config/agent.env.example`](config/agent.env.example)。CI 配置了该 secret 时，包内 `config/agent.env` 已经可直接使用；未配置时只生成模板包。

默认产物：

```text
aiteam-agent-darwin-arm64
aiteam-agent-win32-x64
```

## 本地打包

必须在目标平台构建，避免 native dependency 错配：

```bash
# Apple Silicon
node scripts/build-agent-package.mjs --target darwin-arm64 --config /path/to/agent.env

# Intel macOS
node scripts/build-agent-package.mjs --target darwin-x64 --config /path/to/agent.env

# Windows x64（在 Windows 构建机执行）
node scripts/build-agent-package.mjs --target win32-x64 --config C:\path\to\agent.env
```

不传 `--config` 会生成模板包：

```bash
node scripts/build-agent-package.mjs --target darwin-arm64
```

## 包结构

```text
aiteam-agent-<version>-<target>/
├── runtime/node[.exe]
├── bin/start-agent.mjs
├── bin/start-agent.sh
├── bin/start-agent.cmd
├── dist/
├── node_modules/
├── web/agent/dist/
├── config/agent.env
├── config/agent.env.example
├── manifest.json
├── README.md
└── CLIENT-INTEGRATION.md
```

用户端包不包含 Operation/Manager 后端、控制面前端或冻结的 `app/`。

## 配置边界

允许进入 Agent 配置的内容：

```text
Manager URL
JWT issuer/audience/public JWKS
Skill signing public key
WebView allowed origin
本地监听参数
```

禁止进入 Agent 配置的内容：

```text
Provider key
Manager/Hindsight/LightRAG token
service token
JWT/Skill private key
用户密码
```

## 发布注意

- macOS：签名嵌套的 `runtime/node`，并随客户端 notarize；
- Windows：签名 `runtime/node.exe` 和最终安装包；
- 升级只替换 Agent 安装目录，保留用户数据目录；
- taiyi 包使用测试配置，不得用于生产；
- Windows production 发布前仍需完成原生 sandbox 验收。

## 本地目录知识：宿主边界与开放条件

Agent 的本地目录工具仅在 macOS 桌面宿主桥、已验签成员身份、当前员工知识策略、用户目录授权与员工绑定、前台受限会话同时有效时启用。缺少宿主配置、私有同 uid socket 或有效令牌时失败关闭；Linux/Windows sidecar 不提供该目录能力。引用与文件正文只在本机按需读取，不持久化到控制面。

**桌面网关模式**（配置 `AITEAM_AGENT_UPSTREAM_URL` 时）：会话在上游 Agent 执行，本机 Agent 只保留身份、授权同步和本地目录，其余契约路由带着成员自己的 Bearer 原样流式转发（`src/http/upstream-gateway.ts`、`src/http/gateway-routes.ts`）。私聊 prompt 转发前，本机在入口员工已启用的绑定里做一次有预算的检索或列目录，把命中的片段、文件名放进 `<aiteam-local-context>` 块追加到 `text`（`src/services/gateway-local-context.ts`）。这条路径不依赖本机会话记录，也不按 `permission_mode` 拦截，因为上游工具碰不到这台电脑；但仍要求已验签成员、当前员工知识策略和启用的绑定。**命中的片段和文件名会进入上游的对话历史并被持久化**，撤销授权无法收回已发出的内容。群聊与带提及的 prompt 不检索。

Seatbelt 限制的是受限 Bash 子进程的文件读取和网络访问。Node 主进程及受信任扩展仍具有宿主 uid 权限；此功能不提供针对恶意 Node 扩展或同 uid 本地程序的隔离。

本仓的 HTTP、合成宿主协议和原生 Bash 测试不代表桌面产品联调验收。桌面开放前必须记录实际桌面仓库/PR/完整 SHA、打包 Agent SHA，并验证原生 selector、一次性票据消费、原子文件身份、软硬链接/TOCTOU、撤权与宿主重启。尚未取得该配套版本及联调证据时，保持桌面功能未验收；三端服务部署成功不代表桌面功能已发布。
