# 安装期内置 Git Bash（Windows）

桌面端 Agent 的 Windows `/readyz` 依赖 Pi 解析 `bash.exe`（`%ProgramFiles%\Git\bin\bash.exe`
或 PATH 上的 `bash.exe`）。为了让没装 Git for Windows 的用户也能直接使用，NSIS 安装器在
`POSTINSTALL` 阶段调用 `fetch-gitbash.ps1`：

```text
下载 MinGit（npmmirror 主源 / GitHub 备源，SHA-256 钉死）
  → 解压到 <install>\gitbash
  → usr\bin\sh.exe 复制为 bash.exe（MinGit 2.56 起不再自带 bash.exe，sh.exe 即 bash）
  → 写入 .mingit-version 版本标记
```

host 启动 Agent 时把 `<install>\gitbash\usr\bin`、`<install>\gitbash\cmd` 前置到子进程 PATH
（`src-tauri/src/agent.rs` 的 `bundled_bash_dirs` / `prepend_path_dirs`）。

## 行为边界

- **优先系统 Git**：若 `%ProgramFiles%\Git\bin\bash.exe` 或 `%ProgramFiles(x86)%\...` 存在，
  host 不再前置 MinGit，Agent 使用完整 Git for Windows 的工具集。
- **离线安装**：下载失败时安装器告警并继续；应用仍可启动，但只有系统已装 Git 时 Agent 才会
  ready。就绪超时后宿主会记录 `agent.bash_missing`，并在错误文案里提示联网重装。
- **升级**：重装/升级会以 `_?=<dir>` 就地运行旧卸载器，卸载钩子据此**保留** `gitbash`；
  只有真正卸载才删除。安装器每次都会运行脚本，但 `.mingit-version` 未变时立即退出。
- **工具集差异**：MinGit 的 `usr\bin` 是子集，没有 `sleep`、`chmod`、`tee`、`which`、`ln`、
  `tar`、`curl`、`less`、`python`；`curl.exe`/`tar.exe` 在 Windows System32 中可被找到。
  依赖这些命令的 Agent 场景应在装有完整 Git 的机器上验证。
- **PATH 遮盖**：前置目录只作用于 Agent 子进程，会遮住同名的 Windows 程序（如 `find.exe`、
  `sort.exe`）。这也是「系统已有完整 Git 时不前置」的原因之一。
- **macOS 包**：`resources/installer/` 会随所有平台打包（几 KB，不会执行）。

## 维护

升级 MinGit 时同时修改：

1. `fetch-gitbash.ps1` 的 `-Urls`（版本号）、`-Sha256`、`-Version`
2. `tests/installerScripts.test.ts` 中对 `$Version` 的断言

脚本必须保存为 **UTF-8 with BOM**；Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 ANSI
读取，中文字符串会导致语法错误、安装阶段静默跳过。

失败日志：`%TEMP%\aiteam-gitbash-install.log`（退出码 2 下载失败、3 哈希不符、4 解压/自检失败）。
