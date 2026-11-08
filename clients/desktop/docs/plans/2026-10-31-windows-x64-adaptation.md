# 桌面端 Windows x64 适配方案

状态：部分完成，其余待排期，由另一位开发在 Windows 环境实施并验证。
- 2026-10-31：余飞确认本轮只验收 macOS ARM64，Windows 后续适配（基线 main `3a2f7964`）。
- 2026-11-08：完成三项与平台相关的修复（见「一、已完成」），并按 main `450b4475` 重新盘点剩余改动。**这三项都没有在 Windows 上编译或运行过。**

## 现状概览

- **Agent 侧已支持 Windows**，不用改：
  - `scripts/build-agent-package.mjs` 支持 `win32-x64`/`win32-arm64`，随包 `node.exe`，产物是 zip；
  - `agent-package` workflow 默认构建 `darwin-arm64` 和 `win32-x64`；
  - Agent 沙箱已有 Windows ACL runner（`server/agent_service/src/pi/sandbox.ts`）。
- **桌面端只在 macOS 上可用**，具体有三处：
  - `src-tauri/build.rs` 遇到非 `aarch64-apple-darwin` 目标直接 panic，所以 Windows 目标目前构建不了。
  - `src-tauri/src/lib.rs` 里，以下内容全部只在 macOS 下编译：`agent`、`local_directory_host`、`local_directory_reader` 三个模块，`agent::setup`/`agent::stop`，`get_agent_base_url` 命令，`project_runner::end_leftovers`。即使放开 `build.rs`，Windows 版也没有本机 Agent：前端 `invoke('get_agent_base_url')` 会失败，本地目录检索返回「尚不支持此平台」。
  - 下面这些已经有 Windows 分支，只需要在 Windows 上回归：
    - `file_access.rs`、`files.rs`、`external_links.rs`、`agent_solutions.rs`、`office_editor.rs`、`agent_projects/`；
    - `project_runner/`：已有 `node.exe`、`CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`、`taskkill /T /F`。

## 一、已完成（分支 `fix/desktop-windows-sync`，未推送）

| 提交 | 内容 | 验证情况 |
| --- | --- | --- |
| `7853621d` | Agent 包导入、检查、构建按目标平台工作 | macOS 实测导入；Windows 路径只有模拟测试 |
| `d33f6576` | 时钟偏差提示按平台写出校时入口 | 单元测试 |
| `cbb7fa92` | Windows 上用 DPAPI 保护凭据库主密钥 | 只在 macOS 跑过同一模块的测试，Windows 代码没编译过 |

`7853621d` 的具体改动：
- 新增 `scripts/agent-target.mjs`，统一描述各目标平台：`darwin-arm64` 用 tar.gz 包，运行时是 `runtime/node`；`win32-x64` 用 zip 包，运行时是 `runtime/node.exe`。
- `check-agent` / `import-agent` / `build-agent` / `check-agent-package` / `agent-runtime` 按主机平台或 `manifest.target` 工作。
- 解压统一用系统 bsdtar，Windows 用 `%SystemRoot%\System32\tar.exe`；拒收与目标平台不符的包。
- `quarantine.mjs` 在 Windows 上用 PowerShell `Unblock-File` 清除下载标记 Zone.Identifier。目录路径通过环境变量传给 PowerShell，不拼进脚本。
- `integrate-agent.mjs` 在 Windows 上通过 shell 调 `pnpm.cmd`（Node 修复 CVE-2024-27980 后，直接 spawn `.cmd` 会报 EINVAL）。

`d33f6576` 的具体改动：
- `src/lib/loginServiceError.ts` 根据 WebView 的 UA 判断平台：WebView2 带 `Windows NT`，WKWebView 带 `Macintosh`。
- Windows 提示「设置 > 时间和语言 > 日期和时间」并点「立即同步」；macOS 提示「系统设置 > 通用 > 日期与时间」。

`cbb7fa92` 的具体改动：
- `src-tauri/src/secure_session.rs`：Windows 上用 `CryptProtectData` 加密 `master.key`。
  - 加密结果绑定当前用户，并带应用熵值 `com.aiteam.desktop/auth-vault/master-key`，存储时加 `dpapi:` 前缀。
  - 旧的明文主密钥在读取时自动改为加密存储。
  - 解密失败时重新生成主密钥，用户需要重新登录，凭据库不会因此被锁住。
- `Cargo.toml` 增加 `[target.'cfg(windows)'.dependencies] windows-sys = 0.61`，开启 `Win32_Foundation` 和 `Win32_Security_Cryptography`。
- **首次在 Windows 上编译时，先看这段代码**：windows-sys 0.61 的函数签名可能需要微调。

## 二、待做的修改点

### 1. 构建入口
- `src-tauri/build.rs`：放开 `x86_64-pc-windows-msvc`，并按构建目标校验随包 Agent 的 `manifest.target` 是否为 `win32-x64`。
- `src-tauri/src/lib.rs`：完成下面第 2、3 项之后，把 `#[cfg(target_os = "macos")]` 改成同时覆盖 Windows，或者改成按平台模块分别实现。

### 2. Agent 子进程托管（`src-tauri/src/agent.rs`）
| 现状（Unix） | Windows 改法 |
| --- | --- |
| 启动 `runtime/node` | 按 `manifest.target` 启动 `runtime/node.exe`，加 `CREATE_NO_WINDOW`，避免弹出控制台 |
| `process_group(0)` 建进程组 | 用 Job Object 托管 Agent 及其子进程，设置 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。宿主退出或崩溃时，系统会结束整个进程树 |
| `libc::kill` 先发 SIGTERM，超时再发 SIGKILL | 先让 Agent 正常退出（关闭 stdin，或调用本机关闭接口），超时后调用 `TerminateJobObject` |
| `libc::kill(pid, 0)` 判断进程是否还活着（约第 704 行） | 用 `OpenProcess` 加 `GetExitCodeProcess` 判断 |
| `desktop.lock` 用 `libc::flock` 做单实例锁 | 改用跨平台文件锁（如 `fs4`）或 Tauri single-instance 插件 |

建议先把启动、终止、存活检查、文件锁抽成按平台实现的模块，macOS 行为不变，两个平台各自补单元测试。

### 3. 本地目录检索（这部分原方案没写到，涉及安全边界）
- **`local_directory_host.rs`**：桌面宿主和 Agent 之间的私有通道，现在用 `UnixListener`，socket 文件权限是 0600。
  - Windows 改用命名管道 `\\.\pipe\aiteam-<随机串>`，设置 `PIPE_REJECT_REMOTE_CLIENTS`，访问控制只允许当前用户。
  - 管道路径照旧通过 `AITEAM_LOCAL_HOST_SOCKET` 传给 Agent。Agent 端 `local-directory-host.ts` 用的 `net.createConnection(path)` 原生支持命名管道，**Agent 不用改**。
- **`local_directory_reader.rs`**：目前只支持 macOS。做法是逐级用 `openat(O_NOFOLLOW)` 打开路径，再用 `F_GETPATH` 复核真实路径，目录用 `fdopendir` 读取。
  - Windows 的对应做法：
    - 用 `CreateFileW` 加 `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS` 逐级打开；
    - 遇到 `FILE_ATTRIBUTE_REPARSE_POINT`（符号链接、junction）直接拒绝；
    - 用 `GetFinalPathNameByHandleW` 复核路径仍在授权根目录内；
    - 用 `GetFileInformationByHandleEx(FileIdBothDirectoryInfo)` 枚举目录。
  - 必须补测试：符号链接逃逸、junction 逃逸、路径大小写、`\\?\` 长路径、8.3 短文件名。

### 4. 次要的 Unix 专属代码
- `diagnostics.rs`：日志文件的 0600 权限只在 Unix 生效。Windows 依赖 `%APPDATA%` 默认只有本用户能访问，需要确认，并补一个回归测试。
- `project_runner`：
  - Windows 上 `start_time` 返回 `None`，所以上次被强杀后残留的工作台项目进程不会被清理。可以用 `GetProcessTimes` 补上进程启动时间。
  - `end_leftovers` 依赖第 2 项的单实例锁，那一项做完后再放开。

### 5. 窗口与界面
- `tauri.conf.json`：现在是 `decorations: false`、`transparent: true`、`macOSPrivateApi`。Windows 上关闭透明，或改用 Mica/Acrylic。
- 自绘标题栏目前是 macOS 红黄绿按钮，位置在左侧，分布在 `Login/index.tsx`、`Layout/Sidebar.tsx`、`Profile/index.tsx`、`AppRecovery/BackendStartupScreen.tsx`。Windows 的习惯是最小化、最大化、关闭放在右侧，需要按平台切换。

### 6. 打包、脚本与 CI
- 新增 Windows 打包：NSIS 安装包，配置 WebView2 引导安装（`webviewInstallMode`）。`bundle.targets` 现在是 `all`，需要明确指定。
- `scripts/dev-env.mjs:243` 断言 `process.platform === 'darwin'`，要允许 win32。
- `scripts/office-editor-middleware.mjs:295` 打开浏览器只处理了 darwin，要补 Windows（`cmd /c start` 或 `rundll32 url.dll,FileProtocolHandler`）。
- `.github/workflows/desktop-ci.yml` 现在两个任务都跑在 ubuntu 上。增加一个 `windows-2022` 任务，执行：
  - `pnpm test`、`tsc`；
  - `cargo test --lib`、`cargo clippy --all-targets`；
  - `tauri build --no-bundle`。
- 代码签名：Windows 安装包需要 Authenticode 证书，否则会被 SmartScreen 拦截。

## 不变的约定

- Agent 仍只监听 `127.0.0.1` 的动态端口，端口通过 `agent-data/agent-port.json` 发现，前端仍只接受本机地址。
- 配置与数据仍放在应用数据目录，Windows 上是 `%APPDATA%\com.aiteam.desktop`：
  - 随包配置按 manifest 哈希复制到 `agent-config/<hash>/`；
  - 用户数据在 `agent-data/`；
  - 升级只替换随包 Agent，不动这两处。
- 本机 `agent.env` 覆盖随包配置的规则不变。
- 桌面端不 import `server/` 或 `web/` 源码，只走 HTTP 和本机通道。

## 建议顺序

1. 在 Windows 机器或 `windows-2022` CI 上先放开 `build.rs`，把 `fix/desktop-windows-sync` 编译通过（重点看 DPAPI 那段），再跑一遍现有测试。
2. 第 2 项 Agent 托管：做完后应用能启动、登录、退出，退出后没有残留进程。
3. 第 3 项本地目录检索：涉及安全边界，需要单独评审。
4. 第 5、6 项：窗口、安装包、CI、签名。

## 验收

- 在一台干净的 Windows 10/11 x64 机器上完成安装、首次启动、登录和退出。
- 随包 Agent 能启动，`healthz` 和 `readyz` 正常，端口是动态的。
- 应用正常退出、被任务管理器强制结束后，都没有残留的 Agent 进程（`node.exe`）。
- 从浏览器下载的 Agent zip 导入后，没有残留的 Zone.Identifier，首次启动不被拦截。
- 凭据库 `master.key` 以 `dpapi:` 开头。换一个 Windows 用户读取会失败，应用应提示重新登录，不能崩溃。
- 时钟偏差提示指向 Windows 的设置路径。
- 升级安装后，登录状态和本机数据还在。
- 本地目录检索：授权目录内能读取，经由符号链接或 junction 指向目录外的路径会被拒绝。
- 再按 macOS 验收清单走一遍功能：段落评估、不评估重置、用量、记忆、知识来源、人才市场套餐周期、办公室地图编辑器。

## 待定

- 是否同时支持 Windows ARM64（Agent 侧已有 `win32-arm64` target）。
- 代码签名证书的类型（OV 或 EV）和存放位置。
- Windows 标题栏的样式：沿用自绘，还是改用系统标题栏。
