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
