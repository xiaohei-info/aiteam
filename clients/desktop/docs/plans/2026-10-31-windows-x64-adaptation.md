# 桌面端 Windows x64 适配方案

状态：**部分完成**。PR #183（2026-11-12）已落地平台抽象、构建脚本与 Windows CI 任务，但这些改动**都没有在 Windows 真机上验证过**。

- 2026-10-31：余飞确认本轮只验收 macOS ARM64，Windows 后续适配（基线 main `3a2f7964`）。
- 2026-11-12：PR #183 落地，逐项状态见下节。

## #183 实施状态

### 已完成

| 方案步骤 | 落地内容 |
| --- | --- |
| 1 平台抽象 | `agent.rs` 按平台分流：Windows 用 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）托管子进程，先走 Agent 正常退出、超时再结束 Job；单实例锁在 Windows 改用独占共享模式（`share_mode(0)`，靠 `ERROR_SHARING_VIOLATION` 判定「已在运行」）代替 `flock`；`secure_session.rs` 在 Windows 用 DPAPI 保护凭据库主密钥，并把 `Corrupt` / `ForeignDpapi` 分开诊断 |
| 2 构建脚本 | 新增 `scripts/agent-target.mjs` 统一描述目标平台；`build-agent` / `import-agent` / `check-agent` / `check-agent-package` / `agent-runtime` / `quarantine` / `integrate-agent` 按目标平台工作；`quarantine` 在 Windows 上用 `Unblock-File` 清除 Zone.Identifier；`build.rs` 放开 `x86_64-pc-windows-msvc` 并按目标校验随包 manifest |
| 4 CI | `desktop-ci.yml` 新增 `windows-2022` job：`cargo check --all-targets` / `cargo test --lib` / `cargo clippy --all-targets -- -D warnings` |

附带修掉的 Windows 阻塞项：

- `start-agent.cmd` 改用相对 specifier 引 tsx，绕开安装路径里的 `#` / `%` / 空格。
- `src-tauri/icons/icon.ico` 换成真实多尺寸图标。
- Agent 沙箱补齐 Windows 契约测试（原先只测 macOS 分支）。

### 仍未完成

- `scripts/dev-env.mjs` 仍断言 `process.platform === 'darwin'` —— Windows 上跑不了开发环境。
- `scripts/office-editor-middleware.mjs` 未补 Windows 的打开方式。
- 方案步骤 3 整体未做：窗口样式（透明 / Mica）、NSIS 打包、WebView2 引导。
- 方案步骤 4 里的 `tauri build --no-bundle` 未在 Windows CI 跑（当前只跑 check / test / clippy）。
- 方案步骤 5（Authenticode 签名）未做，证书未定。
- 方案「验收」一节的 Windows 真机验收全部未做。

## 现状

**Agent 侧已支持 Windows**，不需要改：

- `scripts/build-agent-package.mjs` 支持 `win32-x64` / `win32-arm64`，随包 `node.exe`，产物为 zip。
- `agent-package` workflow 默认构建 `darwin-arm64` 与 `win32-x64`。
- Agent 沙箱已有 Windows ACL runner（`server/agent_service/src/pi/sandbox.ts`）。

**桌面端只支持 darwin-arm64**，以下位置写死了平台：

| 位置 | 现状 | 适配内容 |
| --- | --- | --- |
| `src-tauri/build.rs` | 非 `aarch64-apple-darwin` 目标直接 panic | 放开 `x86_64-pc-windows-msvc`，按目标校验随包 Agent 的 `manifest.target` |
| `scripts/build-agent.mjs` | 只允许在 darwin-arm64 主机构建 | 按主机平台选择 target；Windows 主机构建 `win32-x64` |
| `scripts/import-agent.mjs` | 只认 `*-darwin-arm64.tar.gz` | 按目标平台选内层包：Windows 为 zip |
| `scripts/check-agent.mjs` | `manifest.target` 必须是 `darwin-arm64` | 改为与当前构建目标一致 |
| `scripts/dev-env.mjs` | 断言 `process.platform === 'darwin'` | 允许 win32 |
| `src-tauri/src/agent.rs` 启动 | 启动 `runtime/node`；用 `process_group(0)` 建进程组 | Windows 用 `runtime/node.exe`；用 Job Object（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）托管子进程，保证应用退出或崩溃时 Agent 一并结束 |
| `src-tauri/src/agent.rs` 退出 | `libc::kill` 发 SIGTERM，超时后 SIGKILL | Windows 先走 Agent 的正常退出（关闭 stdin 或调用本机关闭接口），超时后结束 Job |
| `src-tauri/src/agent.rs` 单实例锁 | `libc::flock` | 改用跨平台文件锁（如 `fs4`），或 Tauri single-instance 插件 |
| `src-tauri/tauri.conf.json` | `macOSPrivateApi`、透明无边框窗口 | Windows 关闭透明，或改用 Mica/Acrylic；自绘标题栏需补最小化、最大化、关闭按钮和拖拽区 |
| `scripts/build-macos-installer.sh` | 只出 DMG | 新增 Windows 打包：NSIS 安装包，附 WebView2 引导安装 |
| `scripts/office-editor-middleware.mjs` | 浏览器打开命令只处理 darwin | 补 Windows 的打开方式 |

`file_access.rs`、`files.rs`、`external_links.rs`、`agent_solutions.rs` 已经有 Windows 分支，只需要回归测试。

## 不变的约定

- Agent 仍只监听 `127.0.0.1` 的动态端口，端口通过 `agent-data/agent-port.json` 发现，前端仍只接受本机地址。
- 配置与数据仍放在应用数据目录（Windows 为 `%APPDATA%\com.aiteam.desktop`）：随包配置按 manifest 哈希复制到 `agent-config/<hash>/`，用户数据在 `agent-data/`，升级只替换随包 Agent，不动这两处。
- 本机 `agent.env` 覆盖随包配置的规则不变。

## 实施步骤

1. **平台抽象**：把 `agent.rs` 中进程启动、进程组、终止和文件锁抽成按平台实现的模块，macOS 行为保持不变，并补齐两平台的单元测试。
2. **构建脚本**：`build-agent`、`import-agent`、`check-agent` 改为按目标平台工作，`build.rs` 同步放开。
3. **窗口与安装包**：Windows 窗口样式、NSIS 打包、WebView2 引导。
4. **CI**：`desktop-ci` 增加 `windows-2022` 任务，执行前端检查、`cargo test` 和 `tauri build --no-bundle`。
5. **签名**：Windows 安装包需要 Authenticode 代码签名证书，否则 SmartScreen 会拦截。证书由余飞确认采购和保管方式。

## 验收

- 在一台干净的 Windows 10/11 x64 机器上完成安装、首次启动、登录和退出。
- 随包 Agent 能启动，`healthz` 和 `readyz` 正常，端口是动态的。
- 应用退出和崩溃后都没有残留的 Agent 进程。
- 升级安装后登录状态和本机数据还在。
- 再按 macOS 验收清单走一遍功能：段落评估、不评估重置、用量、记忆、知识来源、人才市场套餐周期、办公室地图编辑器。

## 待定

- 是否同时支持 Windows ARM64（Agent 侧已有 `win32-arm64` target）。
- 代码签名证书的类型（OV 或 EV）和存放位置。
