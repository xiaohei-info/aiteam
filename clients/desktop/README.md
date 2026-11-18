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

### 快速打包：签名 + 公证的正式安装包（默认路径）

```bash
# Release：Developer ID 签名 + Apple 公证（推荐、对外分发用）
pnpm tauri:build:mac:installer

# 只签名，不公证（本地验收 / 临时分发）
pnpm tauri:build:mac:installer --skip-notarize

# Debug：开发自测，不公证
pnpm tauri:build:mac:installer --debug
```

默认输出目录为 `src-tauri/target-fresh.noindex/release/bundle/dmg/`（Debug 为 `.../debug/bundle/dmg/`）。签名成功时产物名为 **`AIFred_0.1.0_aarch64_release.dmg`**，内含与 Apple 公证过的 `AIFred.app`、Applications 快捷方式和 `安装说明.txt`；用户拖入 Applications 后双击即可打开，不需要放行脚本，也不需要管理员权限。

签名身份解析顺序：`APPLE_SIGNING_IDENTITY` → 钥匙串里第一个 `Developer ID Application` 证书。公证凭据读取 notarytool 钥匙串条目，默认 `AIFred-notary`，可用 `APPLE_NOTARY_PROFILE` 覆盖。找不到证书时自动降级为未签名构建（见下一节），不会中断构建。

签名流程：内嵌可执行文件（`Contents/Resources/agent/runtime/node`、各 `*.node`、esbuild 等）先逐个以 Hardened Runtime + 时间戳签名（Node 用 `src-tauri/Entitlements.agent.plist`），再重签应用本体（`src-tauri/Entitlements.plist`）并校验 `codesign --deep --strict`；随后把 `.app` 打 zip 提交公证并 stapling（保证拖出 DMG 后的应用离线首次启动也不弹窗），再打包 DMG、给 DMG 本体签名、提交公证并 stapling，最后用 `spctl` 验收。每次发版因此有两次公证上传（`.app` zip 与 DMG）。公证提交失败会自动重试 3 次（上传偶发中断时不必重新构建）。

**随包 Node 的权限说明**（`src-tauri/Entitlements.agent.plist`，只作用于 `Contents/Resources/agent/runtime/node`，主程序只有 `allow-jit`）：

| 权限 | 用途 |
| --- | --- |
| `allow-jit` | V8 即时编译 |
| `allow-unsigned-executable-memory` | V8 需要的可执行内存 |
| `disable-library-validation` | Node 要加载 `*.node` 原生扩展，它们来自不同上游、由本团队重新签名 |

三项都不要随意去掉：不放开时，随包 Node 会因 Agent 包的签名问题反复弹出 Node 权限允许弹窗（实际观察到的现象，未做根因分析）。要收紧权限，请在签名版安装包上逐项去掉，确认内嵌 Agent 能拉起且不再弹窗后再改。

### 首次配置证书与公证凭据

1. 在 [Apple Developer](https://developer.apple.com/account/resources/certificates/add) 创建 **Developer ID Application** 证书：生成 CSR（`openssl req -new -newkey rsa:2048 -nodes -keyout developerID.key -out developerID.csr -subj "/CN=AIFred Distribution"`）、上传、下载 `.cer`。
2. 导入钥匙串（须用 OpenSSL 的 legacy 算法导出，否则 macOS 报 `MAC verification failed`）：

```bash
openssl pkcs12 -export -legacy -inkey developerID.key -in developerID.crt.pem \
  -name "Developer ID Application: <团队名> (<TEAMID>)" -out developerID.p12
security import developerID.p12 -k ~/Library/Keychains/login.keychain-db -P <口令> \
  -T /usr/bin/codesign -T /usr/bin/security
security find-identity -v -p codesigning   # 应出现 Developer ID Application: ...
```

3. 在 App Store Connect → 用户和访问 → 集成 → App Store Connect API 创建 **团队密钥**（访问权限「开发者」即可），下载一次性的 `.p8`，然后保存公证凭据：

```bash
xcrun notarytool store-credentials "AIFred-notary" \
  --key AuthKey_XXXXXXXXXX.p8 --key-id XXXXXXXXXX --issuer <Issuer ID>
xcrun notarytool history --keychain-profile "AIFred-notary"   # 无报错即凭据可用
```

私钥、`.p8` 与口令不要入库；本机放在仓库外的目录（例如 `~/.apple-signing/devid`），权限 600。

### 未签名降级构建（无证书机器）

找不到 Developer ID 证书时，脚本仍会产出以前那种**未签名测试包**：文件名带 **`_with-helper`** 后缀，盘内额外包含 `修复应用无法打开.command` 和未签名版 `安装说明.txt`。这种包不等同于 Developer ID 签名或 Apple 公证，只用于可信内测。

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
CARGO_TARGET_DIR="$PWD/src-tauri/target-fresh.noindex" pnpm tauri build --bundles dmg

# Debug
CARGO_TARGET_DIR="$PWD/src-tauri/target-fresh.noindex" pnpm tauri build --debug --bundles dmg
```

`CARGO_TARGET_DIR=...` 必须与 `pnpm` 命令在同一行，只对该次命令生效。对应产物分别位于：

```text
src-tauri/target-fresh.noindex/release/bundle/dmg/
src-tauri/target-fresh.noindex/release/bundle/macos/
src-tauri/target-fresh.noindex/debug/bundle/dmg/
src-tauri/target-fresh.noindex/debug/bundle/macos/
```

`src-tauri/target-fresh.noindex/` 已加入项目 `.gitignore`，避免大量编译文件显示为未跟踪文件。若另选缓存目录，也需添加对应忽略规则。如果再次移动项目，新的缓存目录也可能需要清理。

**方式二：清理默认目录的旧 Debug 缓存，再使用默认命令。**

```bash
cargo clean --manifest-path src-tauri/Cargo.toml \
  --target-dir "$PWD/src-tauri/target" --profile dev

pnpm tauri build --debug --bundles dmg
```

这里 Cargo 的 `dev` profile 对应 Debug 构建。清理只删除指定目录的构建缓存，不删除源码，也不影响 `target-fresh.noindex/` 中的产物。若需清理默认目录的 Release 缓存，将 `--profile dev` 改为 `--profile release`。

### 带安装说明和临时放行工具的 DMG

如需让用户在安装时直接看到临时放行脚本，使用以下专用命令（普通 `pnpm tauri build` 不会添加这些顶层文件）：

```bash
# Release
pnpm tauri:build:mac:installer

# Debug
pnpm tauri:build:mac:installer --debug
```

命令先通过 `pnpm tauri build --bundles app` 构建应用，再用 macOS `hdiutil` 生成并校验 DMG。默认使用 `src-tauri/target-fresh.noindex/`，也可通过 `CARGO_TARGET_DIR` 指定目录。仅支持本机架构，不接受 `--target` 或自定义 Tauri 配置参数。

默认产物路径（Apple Silicon，当前版本）：

```text
src-tauri/target-fresh.noindex/release/bundle/dmg/AIFred_0.1.0_aarch64_release_with-helper.dmg
src-tauri/target-fresh.noindex/debug/bundle/dmg/AIFred_0.1.0_aarch64_debug_with-helper.dmg
```

打开 DMG 后，顶层包含：

```text
AIFred.app
Applications → /Applications
修复应用无法打开.command
安装说明.txt
```

用户先将应用拖入 Applications。如遇下载隔离检查拦截，再双击脚本，选择已安装的应用并确认操作。脚本和说明源文件位于 `installer/macos/`；构建 DMG 时不会修改 `.app` 内部内容，用户运行修复脚本时会替换所选应用的现有签名。自定义 DMG 使用系统默认 Finder 布局，不沿用 Tauri DMG 的图标位置或背景配置。该脚本只出现在**未签名降级包**（文件名带 `_with-helper`）里，签名并公证过的正式包不含该脚本，因为重新签名会破坏公证票据。

**此脚本删除所选应用的 `com.apple.quarantine` 属性，执行 `codesign --force --deep --sign -` 进行本地临时签名，再以 `codesign --verify --deep --strict --verbose=2` 验证。只有验证通过后才提示打开应用；签名或验证失败会以非零状态退出。它会替换应用及内嵌代码的现有签名，不会完成 Developer ID 签名、Apple 公证、修复损坏文件或关闭 Gatekeeper。** 仅用于可信测试版本；如系统提示包含恶意软件，请停止，不要绕过。脚本本身也可能被 macOS 拦截，无法保证首次双击即可运行；安装说明包含确认可信后通过 `/bin/bash` 显式执行的备用方式。正式发布前应替换为签名、公证流程；本命令不会对最终 DMG 额外签名或公证。

### 架构与分发注意

- 默认构建当前机器架构；Apple Silicon Mac 上默认为 ARM64，不是 Intel 或 Universal 版本。内嵌 Agent 也必须与目标架构匹配。
- 普通 `pnpm tauri build`（不带 installer 脚本）只做打包，不补签内嵌 Node、不做公证；正式对外分发请用 `pnpm tauri:build:mac:installer`。
- 签名需要联网向 Apple 时间戳服务取时间戳；公证需要可达 `appstoreconnect.apple.com`。
- **本机开了系统代理（Clash / 127.0.0.1:7897）时必须先关掉再跑公证**：实测直连上传 4.26 MB/s，走代理只有 110 KB/s，notarytool 会在上传中途报 `abortedUpload(... deadlineExceeded)`。`notarytool` 只认系统代理，设 `HTTPS_PROXY` 环境变量无效。关代理：`sudo networksetup -setwebproxystate "Wi-Fi" off; sudo networksetup -setsecurewebproxystate "Wi-Fi" off; sudo networksetup -setsocksfirewallproxystate "Wi-Fi" off`，所有 `on` 即恢复。
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
