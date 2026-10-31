> 本目录是 AI Team 单仓里的桌面客户端（`clients/desktop`），2026-10-30 从原 gitee AITeam 仓库迁入（不含历史，原仓库 `develop` `c95551c9`）。仓库总览见根目录 `README.md`，桌面端文档索引见 [docs/README.md](docs/README.md)。
>
> 原 gitee 仓库（`mwj424/ty-aiteam`）已弃用，只读保留用来查历史，不再接受提交，单仓的改动也不会同步回去。那边的 `MIGRATION.md` 列了没有迁移的分支，以及把旧补丁带到这里的方法（`git am --directory=clients/desktop`）。
>
> 桌面端只连随包的本机 Agent（本仓库 `server/agent_service`），会话在本机执行，本机 Agent 直接访问 Manager。见 [本机 Agent 集成](docs/agent-sidecar.md)。

# AI Team Desktop

多智能体协作桌面应用，基于 Tauri 2 + React 18 + TypeScript。

## 环境要求

- **Node.js** >= 22
- **pnpm** >= 8
- **Rust** stable（本次构建验证使用 1.95.0）
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发模式（Tauri 桌面窗口 + HMR）
pnpm tauri dev

# 仅启动前端（浏览器调试，不启动 Tauri 窗口）
pnpm dev
# 访问 http://localhost:1420
```

## 构建发布包

以下命令均在项目根目录（`AITeam/`）执行。构建会自动检查 Agent 资源，并运行 `pnpm build` 编译前端。

### 快速打包：附带脚本和说明的测试安装包

**需要在安装盘中显示脚本入口时，请使用以下命令，不要使用普通 `pnpm tauri build`：**

```bash
# Release：包含临时放行脚本和安装说明
pnpm tauri:build:mac:installer

# Debug：包含临时放行脚本和安装说明
pnpm tauri:build:mac:installer --debug
```

默认输出目录分别为 `src-tauri/target-fresh/release/bundle/dmg/` 和 `src-tauri/target-fresh/debug/bundle/dmg/`。请选择文件名以 **`_release_with-helper.dmg`** 或 **`_debug_with-helper.dmg`** 结尾的安装包。

打开后卷名为 **`AIFred Installer`**，其中包含应用、Applications 快捷方式、`修复应用无法打开.command` 和 `安装说明.txt`。脚本会清除下载隔离标记并重新进行本地临时签名，不等同于 Developer ID 签名或 Apple 公证；具体限制见下方说明。

> 普通的 `AIFred_0.1.0_aarch64.dmg` 不含脚本。若窗口中只有应用和 Applications，请推出旧安装盘，重新打开带 `_with-helper` 后缀的包。

### 普通 Release 版本（不附带脚本）

```bash
pnpm tauri build

# 仅打包 macOS DMG
pnpm tauri build --bundles dmg
```

产物在 `src-tauri/target/release/bundle/` 下：`dmg/` 为安装包，`macos/` 为 `.app` 应用。

### 普通 Debug 版本（不附带脚本）

```bash
pnpm tauri build --debug

# 仅打包 macOS DMG
pnpm tauri build --debug --bundles dmg
```

产物在 `src-tauri/target/debug/bundle/` 下，同样包含 `dmg/` 和 `macos/` 子目录。

Debug 安装包可以独立运行，不需要启动前端开发服务器；Rust 使用 Debug 构建，通常体积更大、运行更慢。当前配置仍执行 `pnpm build`，因此前端仍为生产构建。日常热更新开发请使用 `pnpm tauri dev`。

### 项目移动后出现旧缓存路径错误

如果报错 `failed to read plugin permissions`，且其中的 `app_hide.toml` 等权限文件路径指向项目移动前的位置，说明 Cargo 构建缓存仍引用旧绝对路径。任选以下一种方式处理。

**方式一：使用新的构建缓存目录（不删除原缓存）。**

```bash
# Release
CARGO_TARGET_DIR="$PWD/src-tauri/target-fresh" pnpm tauri build --bundles dmg

# Debug
CARGO_TARGET_DIR="$PWD/src-tauri/target-fresh" pnpm tauri build --debug --bundles dmg
```

`CARGO_TARGET_DIR=...` 必须与 `pnpm` 命令在同一行，只对该次命令生效。对应产物分别位于：

```text
src-tauri/target-fresh/release/bundle/dmg/
src-tauri/target-fresh/release/bundle/macos/
src-tauri/target-fresh/debug/bundle/dmg/
src-tauri/target-fresh/debug/bundle/macos/
```

`src-tauri/target-fresh/` 已加入项目 `.gitignore`，避免大量编译文件显示为未跟踪文件。若另选缓存目录，也需添加对应忽略规则。如果再次移动项目，新的缓存目录也可能需要清理。

**方式二：清理默认目录的旧 Debug 缓存，再使用默认命令。**

```bash
cargo clean --manifest-path src-tauri/Cargo.toml \
  --target-dir "$PWD/src-tauri/target" --profile dev

pnpm tauri build --debug --bundles dmg
```

这里 Cargo 的 `dev` profile 对应 Debug 构建。清理只删除指定目录的构建缓存，不删除源码，也不影响 `target-fresh/` 中的产物。若需清理默认目录的 Release 缓存，将 `--profile dev` 改为 `--profile release`。

### 带安装说明和临时放行工具的 DMG

如需让用户在安装时直接看到临时放行脚本，使用以下专用命令（普通 `pnpm tauri build` 不会添加这些顶层文件）：

```bash
# Release
pnpm tauri:build:mac:installer

# Debug
pnpm tauri:build:mac:installer --debug
```

命令先通过 `pnpm tauri build --bundles app` 构建应用，再用 macOS `hdiutil` 生成并校验 DMG。默认使用 `src-tauri/target-fresh/`，也可通过 `CARGO_TARGET_DIR` 指定目录。仅支持本机架构，不接受 `--target` 或自定义 Tauri 配置参数。

默认产物路径（Apple Silicon，当前版本）：

```text
src-tauri/target-fresh/release/bundle/dmg/AIFred_0.1.0_aarch64_release_with-helper.dmg
src-tauri/target-fresh/debug/bundle/dmg/AIFred_0.1.0_aarch64_debug_with-helper.dmg
```

打开 DMG 后，顶层包含：

```text
AIFred.app
Applications → /Applications
修复应用无法打开.command
安装说明.txt
```

用户先将应用拖入 Applications。如遇下载隔离检查拦截，再双击脚本，选择已安装的应用并确认操作。脚本和说明源文件位于 `installer/macos/`；构建 DMG 时不会修改 `.app` 内部内容，用户运行修复脚本时会替换所选应用的现有签名。自定义 DMG 使用系统默认 Finder 布局，不沿用 Tauri DMG 的图标位置或背景配置。

**此脚本删除所选应用的 `com.apple.quarantine` 属性，执行 `codesign --force --deep --sign -` 进行本地临时签名，再以 `codesign --verify --deep --strict --verbose=2` 验证。只有验证通过后才提示打开应用；签名或验证失败会以非零状态退出。它会替换应用及内嵌代码的现有签名，不会完成 Developer ID 签名、Apple 公证、修复损坏文件或关闭 Gatekeeper。** 仅用于可信测试版本；如系统提示包含恶意软件，请停止，不要绕过。脚本本身也可能被 macOS 拦截，无法保证首次双击即可运行；安装说明包含确认可信后通过 `/bin/bash` 显式执行的备用方式。正式发布前应替换为签名、公证流程；本命令不会对最终 DMG 额外签名或公证。

### 架构与分发注意

- 默认构建当前机器架构；Apple Silicon Mac 上默认为 ARM64，不是 Intel 或 Universal 版本。内嵌 Agent 也必须与目标架构匹配。
- Release 和 Debug 均不会自动绕过 macOS 安全检查。以上命令没有额外配置 Developer ID 签名或 Apple 公证，正式对外分发仍需完成签名与公证。
- 不要同时对同一个构建目录运行多次打包，以免等待 Cargo 文件锁或产生打包冲突。

### 内嵌 Agent（Apple Silicon）

随包 Agent 不入库，首次开发或构建前从同一提交的后端源码构建并导入：

```bash
pnpm agent:build
pnpm agent:check
pnpm tauri:build:mac:arm64
```

`agent:build` 会在 `server/agent_service` 和 `web/` 安装依赖并构建，只能在 Apple Silicon macOS 上运行。也可以用 `pnpm agent:import <artifact.zip>` 导入 GitHub Actions `agent-package` 工作流的产物。Agent 随应用启动、使用动态本地端口，并随应用退出。

目前只有一个环境（taiyi TEST），`pnpm tauri dev` 和打包出的安装包共用 `config/agent/taiyi-test.env`，导入时自动固化进随包 Agent。该配置使用真实 JWT 验签（`AITEAM_AGENT_JWKS_MODE=manager`，按租户从 Manager 拉取公钥），本地目录检索要求已验证的调用者，开发认证下一律返回 403。完整配置、环境切换及验证方式见 [本机 Agent 集成](docs/agent-sidecar.md)。

## 项目结构

```
src/              ← React 前端（所有业务 UI）
src-tauri/        ← Tauri Rust 层（窗口/菜单/通知/安全存储）
```

## 注意事项

1. **首次运行 `pnpm tauri dev` 会编译 Rust 依赖**，首次约需 3-5 分钟，后续增量编译很快
2. **前端开发可以只跑 `pnpm dev`**，在浏览器中调试 UI，无需等待 Rust 编译
3. **桌面 Agent 地址由宿主动态发现**；浏览器调试可通过 `VITE_AGENT_BASE_URL` 指定手工启动的 Agent
4. **Rust 层负责宿主能力**，包括 Agent 生命周期、文件操作和系统凭证存储
5. **离线不可用**，断网时显示全屏遮罩提示
6. **路径别名**：`@` 映射到 `src/` 目录

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面框架 | Tauri 2.x |
| 前端 | React 18 + TypeScript |
| 状态管理 | Zustand |
| 样式 | Tailwind CSS |
| HTTP | Fetch + Tauri HTTP 插件 |
| 路由 | React Router 6 |
| 构建 | Vite |

## 参与贡献

在 FredServer 单仓按根目录 `CONTRIBUTING.md` 的流程开分支、提 PR。桌面端改动只触发 `.github/workflows/desktop-ci.yml`，提交前在本目录运行 `pnpm typecheck`、`pnpm test`、`pnpm lint`。
