# 工作台：AI Agent 做出的项目

> 分支：`feat/workbench-projects`
> 入口：左侧栏「工作台」（⌘6）
> 设计与计划：[`plans/2026-11-03-workbench-projects-plan.md`](plans/2026-11-03-workbench-projects-plan.md)（取代已作废的 `plans/2026-10-29-product-design-proposals/08-workbench-solutions.md`）

## 1. 目标

工作台汇总 **AI Agent 在本机做出的 vibecoding 项目**。可以查看项目文件，也可以一键运行。工作台不是「解决方案」汇总，也不展示聊天记录。

- 只收 Agent 自己新建的目录。用户自己的代码仓库不算，因为大多数用户不会开发。
- 项目内容不离开本机，不读 `.env`、私钥等凭据文件。
- 不会自动启动，也不会自动安装依赖。代码项目第一次运行前，必须由用户确认要执行的命令。

## 2. 来源与项目判定

| 来源 | 读取位置 | 什么算一个项目 |
|---|---|---|
| Fred | 本机 Agent 接口 `GET /api/agent/workspaces` 返回会话的 `workspace_key`，宿主按 key 列出 `<agent-data>/workspaces/conversation-*` | 一个会话的工作目录算一个项目。群聊中每个员工的目录是一个子文件夹，已移出群聊的成员的目录也保留 |
| Codex | `$CODEX_HOME`（默认 `~/.codex`）下的 `sessions/`、`archived_sessions/` | 见下方「Codex / Claude 规则」 |
| Claude Code | `$CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下的 `projects/` | 同上 |
| Claude 桌面版 | Code 标签页沿用 Claude Code 的会话记录；Cowork 读 `local-agent-mode-sessions/`（可用 `COWORK_SESSIONS_DIR` 覆盖） | Code 标签页同上；Cowork 会话的 `outputs/` 直接算 |
| WorkBuddy | `~/.workbuddy/projects/` 会话记录；`~/WorkBuddy/<时间戳>/` 任务目录 | 每个任务目录算一个项目 |
| DeepSeek | 不是独立来源 | 作为筛选项，筛出由 DeepSeek 模型做出的项目 |

**Codex / Claude 规则**：项目根是会话开始后才创建的最外层目录（创建时间不早于会话开始前 2 分钟），且会话往里写过文件。以下情况不算：上级目录中有早于会话的 `.git`、`package.json` 或 `pyproject.toml`（说明是已有项目）；目录是家目录、`/tmp` 或 `/private/tmp`。如果文件系统记录不了目录创建时间，会跳过这些会话，并在来源状态里提示 `creation_time_unavailable`。

**项目内的文件**：以磁盘上现存的文件为准，不从会话记录还原内容。扫描时跳过以下内容：
- 隐藏路径、`node_modules`、`__pycache__`、`venv`，以及 `package.json` 旁边的 `dist/`
- 文件名像凭据的文件，以及 `.pem`、`.key`、`.p12`、`.pfx`、`.jks`、`.keystore`、`.ppk`
- 符号链接

单个项目最多列 2000 个文件，扫描最多 20000 个条目、12 层深。页面内预览的文件不超过 2 MB，更大的文件用系统默认应用打开。

**标识**：普通项目和文件的 id 是路径的 FNV-1a 哈希（16 位十六进制），Fred 项目的 id 是 `workspace_key`。前端只传 id，路径一律由宿主重新解析，不接受前端传来的路径。

## 3. 运行

### 3.1 运行方式识别

如果项目根目录本身就是一个应用，整个项目只有一个运行单元。否则逐个识别下一层子文件夹，每个应用一个单元，最多 50 个。散落的 HTML 文件另成一个单元，已经归入子文件夹应用的页面不重复计入。

| 类型 | 条件 | 运行方式 |
|---|---|---|
| Node 网页 | `package.json` 的 `scripts` 里有 `dev`、`start` 或 `preview` | 随包 Node + 随包 npm：先 `npm install`，再 `npm run <script>`，带 `PORT` 和 `HOST=127.0.0.1` |
| Python | 有 `requirements.txt` 或 `pyproject.toml`，加上 `app.py`、`main.py` 或 `streamlit_app.py` 之一 | 系统 `python3`：在应用数据目录建 venv 并用 pip 安装依赖，再 `python <入口>`；入口导入了 streamlit 时改用 `streamlit run` |
| 纯网页 | 根目录、`dist/`、`build/` 或 `public/` 下有 `index.html` | 宿主内置的静态服务器 |
| 单个 HTML | 只有 HTML 文件，没有 `index.html` | 静态服务器打开所选的文件 |
| 其他 | — | 不能运行，只提供「在文件夹中显示」 |

项目运行后在**系统浏览器**中打开。Tauri 的 CSP `frame-src` 只允许 `'self' blob:`，所以不在应用内嵌入。只允许打开 `http://127.0.0.1:` 或 `http://localhost:` 开头的地址。

### 3.2 静态服务器

- 只监听 `127.0.0.1` 的随机端口，只接受 Host 为 `127.0.0.1:端口` 或 `localhost:端口` 的请求，其他 Host 返回 421。
- 只处理 GET 和 HEAD 请求，响应头带 `Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。
- 拒绝路径穿越、隐藏路径、符号链接和凭据类文件。

### 3.3 进程与环境

- 子进程先清空所有环境变量，只保留白名单中的变量：`HOME`、`USER`、`LOGNAME`、`LANG`、`TMPDIR`。Windows 上另外保留 `USERPROFILE`、`TEMP`、`TMP`、`SYSTEMROOT`、`COMSPEC`、`PATHEXT`、`APPDATA`、`LOCALAPPDATA`。同时设置 `PYTHONUNBUFFERED=1` 和 `BROWSER=none`。`AITEAM_*` 和各种凭据都不会传给子进程。
- 进程状态分为 `preparing`、`starting`、`running`、`exited`、`failed`、`stopped`。访问地址从进程输出中识别：输出里第一个 loopback 地址就是访问地址，30 秒内没有识别到就提示用户查看日志。日志最多保留 500 行。
- 停止时，macOS 和 Linux 先向进程组发 SIGTERM，3 秒后仍未退出就发 SIGKILL；Windows 用 `taskkill /PID <pid> /T /F` 结束整个进程树。正常退出应用时会停止所有运行中的项目。
- 应用被强制结束（强制退出、崩溃、开发时重新编译）时来不及停止项目。为此，每个步骤运行期间会在运行目录写一个 `process.json`，记下进程号和该进程的启动时间，步骤结束或停止后删除。下次启动时，桌面端先拿到单实例锁，再在后台检查这些记录：进程号还在、启动时间也一致，就结束整个进程组；否则（进程已退出，或进程号已被其他程序占用）只删除记录。仅 macOS 生效；在那之前，遗留的进程会一直占用端口。
- 运行状态放在 `<应用数据目录>/workbench-runs/<来源>-<项目 id>[-<子文件夹 id>]/`，包括 `venv/`、`dependencies.sha256`、`run.log` 和 `process.json`。Node 的 `node_modules` 装在项目目录里。

### 3.4 首次运行确认

- `start_project` 第一次被调用时返回 `needs_consent`，内容包括要执行的命令、工作目录和指纹。前端弹窗把这些展示给用户，用户确认后，前端带上指纹再调用一次，宿主才会执行。
- 指纹由项目 key、子文件夹、命令（含下载源）、依赖文件名及其内容共同算出。其中任何一项变化，都要重新确认。确认记录保存在 `workbench-run-consent.json`。
- Node 以 `package.json`、Python 以 `requirements.txt` 或 `pyproject.toml` 判断依赖是否变化。依赖安装成功后才写入标记；标记匹配，且 `node_modules` 或 venv 还在，才会跳过安装。

### 3.5 依赖下载

- 安装时自动重试：npm 带 `--fetch-retries=5 --fetch-timeout=120000`，pip 带 `--timeout=60 --retries=5 --disable-pip-version-check`。
- 下载源在工作台右上角「下载源」中设置，保存在 `workbench-dependency-source.json`：
  - **国内镜像**（默认）：Python 用 `https://pypi.tuna.tsinghua.edu.cn/simple`，Node 用 `https://registry.npmmirror.com`。
  - **跟随系统配置**：不传下载源参数，使用本机 `pip.conf` 和 `.npmrc` 中的设置。
  - **自定义**：Python 和 Node 的地址分别填写，留空的一项跟随系统配置。地址必须是 http 或 https，不能包含空白字符或账号密码，宿主和前端都会校验。
- 下载源会写进安装命令，所以更换下载源后，每个代码项目都要重新确认一次。已经装好的依赖不会重新下载。
- 代理：终端里设置的代理环境变量（如 `https_proxy`）不会传给子进程。需要走代理时，可以开启系统级或 TUN 代理，在 `pip.conf` 或 `.npmrc` 中配置代理，或者在「自定义」里填写内网镜像地址。

## 4. 接口

### 4.1 本机 Agent

`GET /api/agent/workspaces`：返回当前用户拥有的、磁盘上有项目文件的会话工作目录，只返回 `workspace_key` 和会话信息，不返回路径。契约见 `docs/api.json`，前端白名单见 `src/api/agent/contract.ts`。

### 4.2 桌面宿主命令

| 命令 | 作用 |
|---|---|
| `list_agent_projects` | 扫描 Codex、Claude、Claude 桌面版、WorkBuddy 的项目，并返回各来源的状态 |
| `list_fred_workspace_files { workspaceKeys }` | 按 Agent 接口返回的 key 列出 Fred 工作目录中的文件，最多 1000 个 key |
| `read_project_file` / `open_project_file { reveal }` | 预览文件，或用系统应用打开、在文件夹中显示 |
| `detect_project_runner` | 返回项目的运行单元列表 |
| `start_project { source, projectId, dir, fileId, consent }` | 运行一个单元；`dir` 只接受宿主自己识别出的子文件夹 |
| `stop_project` / `project_run_status` | 停止运行，或查询状态和日志 |
| `get_dependency_source` / `set_dependency_source` | 读取或保存依赖下载源 |

常见错误码及前端提示见 `src/pages/Workbench/projects.ts` 中的 `ERROR_MESSAGES`。

## 5. 代码位置

| 部分 | 文件 |
|---|---|
| 宿主扫描 | `src-tauri/src/agent_projects.rs` |
| 宿主运行 | `src-tauri/src/project_runner/`：`detect.rs`（识别）、`static_server.rs`、`process.rs`、`plan.rs`（命令、确认、下载源、环境变量）、`mod.rs`（命令入口） |
| 随包 npm | `scripts/build-agent-package.mjs`，解压到随包 Agent 的 `runtime/npm/` |
| 页面 | `src/pages/Workbench/`：`index.tsx`、`api.ts`、`projects.ts`、`preview.ts` |
| Agent 接口 | `server/agent_service/src/services/conversation-workspaces.ts`、`http/conversation-workspace-schemas.ts` |
| 测试 | `tests/workbenchProjects.test.ts`，以及上述 Rust 模块内的单元测试 |

## 6. 风险与已知限制

- 运行的是 Agent 生成的代码，权限和当前用户相同，没有沙箱，只靠首次运行确认兜底。`npm install` 会联网，也可能执行依赖包的安装脚本。
- 访问地址靠进程输出识别；不打印地址的项目只能让用户看日志。
- 完全通过 shell 命令写出来的项目，Codex 和 Claude 的规则识别不到，因为判断依据是会话记录里的文件写入。
- Python 依赖系统的 `python3`。Windows，或者没装 Xcode 命令行工具的 Mac，可能没有 python3。后续可以考虑随包带 `uv`；uv 不读 `pip.conf`，到时需要重新设计「跟随系统配置」和代理的处理方式。
- 本机没有 Claude 桌面版 Cowork 的数据，这部分按公开资料实现，还没有在真实数据上验证。
