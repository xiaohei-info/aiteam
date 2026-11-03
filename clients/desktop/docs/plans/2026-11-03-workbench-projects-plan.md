# 工作台改版：AI Agent 做出的项目（实施计划）

> 状态：待评审，未开始编码
> 分支：`feat/workbench-projects`（从 `main` b323d2d6 切出）
> 取代：`2026-10-29-product-design-proposals/08-workbench-solutions.md`（「解决方案确认」已作废）、`docs/workbench-agent-solutions.md` 的判定口径

## 1. 目标与边界

工作台展示 **AI Agent 自己做出来的项目**（vibecoding 产物），用户可以看文件、看详情，并**一键运行**。

| 已确认口径 | 内容 |
|---|---|
| 单位 | 一个项目 = 一个目录 |
| 来源 | Fred、WorkBuddy、Codex、Claude（Claude Code + Claude 桌面版）；DeepSeek 是按模型的筛选项，不是来源 |
| 只抓 Agent 的目录 | 用户自己的代码仓库不算（用户大多不会开发） |
| Fred | 会话工作目录 `agent-data/workspaces/conversation-<哈希>/`；**群聊合成一个项目**，每个员工的目录是一个子文件夹 |
| 运行 | 纯网页直接打开；Node 项目用随包 Node + 随包 npm；Python 项目用系统 python3；**首次运行前弹窗显示命令，用户确认后执行** |
| Fred 读取方式 | 新增本机 Agent 只读接口，替代「给产物加相对路径」（产物库有 32 个文件 / 50MB / 扩展名白名单 / 跳过疑似密钥等限制，存不全项目） |

### 非目标

- 不自动启动、不自动装依赖；不在后台常驻项目进程。
- 不随包带 Python；不为项目提供沙箱（见 §8 风险）。
- 不在工作台里编辑文件；不上传任何项目内容。
- 去掉 TRAE、Qoder 来源和 `~/.claude/plans`；去掉「只按文档判定方案」的逻辑。
- 不改会话产物（artifact）的现有接口与行为。

## 2. 各来源的项目判定

| 来源 | 项目根 | 判定 |
|---|---|---|
| Fred 私聊 | 该会话唯一员工的工作目录 | 目录内有非空文件 |
| Fred 群聊 | 会话本身；子文件夹 = 各员工工作目录（含已移出成员，保留历史产出） | 任一子目录有非空文件 |
| WorkBuddy | `~/WorkBuddy/<时间戳>/` 每个任务目录 | 目录内有非空文件 |
| Claude 桌面版 Cowork | 每个会话的 `outputs/` | 目录内有非空文件 |
| Codex、Claude Code、Claude 桌面版 Code 标签页 | 从会话写入的文件向上找：**会话开始后才创建**（创建时间 ≥ 会话开始 − 2 分钟）的最外层目录 | 该目录及其上级都不在已有项目里（上级没有早于会话的 `.git`、`package.json`、`pyproject.toml`）；排除家目录、`/tmp`、`/private/tmp` |

- 本机试跑（2026-11-03）：Codex、Claude 按上表规则 0 个项目；旧规则会误抓 AITeam 里新建的 `src/api`、`src/scene/office`，新规则已排除。
- Fred 试跑：15 个会话目录中 3 个有文件；`trending_*.html` 中 7 个 0 字节文件需过滤。
- 无法取得目录创建时间的文件系统（极少见）：该会话不出项目，并在来源状态里说明。

### 项目内的文件

- 全部文件都算，包括代码。
- 排除：隐藏文件和目录（`.git`、`.env` 等）、`node_modules`、`__pycache__`、`venv`/`.venv`、0 字节文件、文件名像凭据的文件（沿用现有规则）；不跟随符号链接。
- 上限：每个项目 2000 个文件；单文件预览 2MB；超出时列表标注「已截断」。

### 项目信息

- 名称：`package.json` 的 `name` / `pyproject.toml` 的 `name` → 会话标题 → 目录名。
- 简介：README 首段 → 首条需求。
- 员工：Fred 取入口员工（私聊）或协调员工（群聊）；其他来源显示平台名。
- 模型：Codex、Claude 取写入该目录的模型；Fred 取员工配置的模型；用于 DeepSeek 筛选。
- 运行方式：见 §4.1。

## 3. 本机 Agent 接口（北向 API 变更，已确认）

### 3.1 契约

`GET /api/agent/workspaces` —— 列出当前成员所有会话的工作目录（一次返回，避免逐个会话请求）。

```json
{
  "data": [{
    "conversation_id": "…",
    "kind": "chat | group",
    "title": "…",
    "entry_employee_id": "…",
    "coordinator_employee_id": null,
    "updated_at": "2026-11-03T01:25:00Z",
    "workspaces": [{
      "employee_id": "employee-1",
      "role": "entry | coordinator | member",
      "removed": false,
      "workspace_key": "conversation-96acab21cdd5bd30977900a5",
      "has_files": true
    }]
  }],
  "page": { "next_cursor": null, "has_more": false }
}
```

- **不返回本机绝对路径**，只返回目录名 `workspace_key`（与现有 participants 接口「不返回本机路径」的约定一致）。桌面宿主自己知道 `agent-data` 在哪，按 key 拼路径。
- 鉴权：默认 authenticated；只返回 `tenant_id`、`member_id` 与 caller 一致的会话（与 `requireOwnedConversation` 同口径）。
- `has_files`：Agent 侧只做一次浅层判断（目录里有任一非隐藏、非空文件），不返回文件列表、不读文件内容。
- 不返回空目录之外的任何内容；会话正文、文件内容都不经过该接口。

### 3.2 实现

| 文件 | 改动 |
|---|---|
| `server/agent_service/src/storage/sqlite.ts` | 新增 `listOwnedConversationWorkspaces(tenantId, memberId)`：`conversation` 联 `conversation_participant_session`（含 `removed_at` 不为空的成员） |
| `server/agent_service/src/http/server.ts`（或新拆 `http/workspaces.ts`，与 `local-directories.ts` 同样的拆法） | 注册路由、TypeBox schema（`ConversationWorkspace`、`ConversationWorkspaceListEnvelope`）加入 OpenAPI |
| 路径校验 | 对每个 workspace 做 `assertManagedPath(…, cwdRoot)`，不在 `cwdRoot` 下的直接跳过；`workspace_key` 取 `basename` 并校验 `^conversation-[0-9a-f]{24}$` |
| 契约文件 | 重新导出 Agent OpenAPI；更新 `clients/desktop/docs/api.json` 与 `clients/desktop/src/api/agent/types.ts` |

## 4. 运行（桌面宿主）

### 4.1 运行方式识别

| 类型 | 识别条件（按顺序） | 运行 |
|---|---|---|
| Node 网页 | 根目录有 `package.json`，且 `scripts` 里有 `dev`、`start` 或 `preview` 之一 | 首次：`npm install --no-audit --no-fund`；然后 `npm run <dev\|start\|preview>`，环境变量带 `PORT`、`HOST=127.0.0.1` |
| Python | 有 `requirements.txt` 或 `pyproject.toml`，且有 `app.py`、`main.py`、`streamlit_app.py` 之一 | 首次：在应用数据目录建 venv 并 `pip install -r requirements.txt`；然后 `python <入口>`（导入了 streamlit 时用 `streamlit run`） |
| 纯网页 | 根目录或 `dist/`、`build/`、`public/` 下有 `index.html` | 宿主起本地静态服务器 |
| 单个 HTML | 只有 HTML 文件、没有 `index.html` | 选中哪个文件就用静态服务器打开哪个 |
| 其他 | — | 不能运行，只提供「在文件夹中显示」 |

- Fred 群聊：按子文件夹分别识别，每个可运行的子文件夹一个运行按钮。
- 打开方式：**系统浏览器**（与办公室编辑器的做法一致，不需要放宽 WebView CSP、不新增 capability）。
- 地址：静态服务器端口由宿主分配；Node/Python 从进程输出里识别第一条 `http://127.0.0.1:<端口>` / `http://localhost:<端口>`，识别到后自动打开，30 秒没识别到就提示看日志。

### 4.2 静态服务器（新 `src-tauri/src/project_runner/static_server.rs`）

- 绑定 `127.0.0.1:0`，每个项目一个，根目录固定为项目根。
- 路径解码后 canonicalize，必须仍在项目根内；拒绝符号链接、隐藏路径。
- 只处理 GET/HEAD；`Content-Type` 按扩展名；`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- 参考 `office_editor.rs` 已有的 HTTP 写法，但单独成模块，不改办公室编辑器。

### 4.3 进程管理（新 `src-tauri/src/project_runner/process.rs`）

- 一个项目同时只跑一个进程；工作台显示「运行中 / 停止 / 打开」和最近 500 行日志。
- 应用退出时结束所有子进程（含进程组 / Windows Job Object）。
- 子进程环境：只保留 `PATH`（前置随包 runtime 目录）、`HOME`/`USERPROFILE`、`LANG`、`TMPDIR`/`TEMP`、`PORT`、`HOST`；**不继承** `AITEAM_*` 等 Agent 环境变量和凭据。
- 工作目录 = 项目根（原目录，不复制）；Python venv、日志放应用数据目录 `workbench-runs/<项目 id>/`，不写进项目。
- 项目路径一律由宿主重新解析：WebView 只传来源 + 项目 id（与现有工作台一致），Fred 项目额外校验目录是 `<agent-data>/workspaces/` 的直接子目录。

### 4.4 首次运行确认

- 弹窗列出将要执行的全部命令、工作目录，以及「项目代码会以你的用户权限运行，可能访问网络和本机文件」。
- 确认记录在 `workbench-run-consent.json`，键为「项目 id + 命令 + `package.json`/`requirements.txt` 的哈希」；依赖文件或命令变了就重新确认。
- 纯网页（静态服务器）不执行项目代码，不需要确认。

### 4.5 随包 npm（`scripts/build-agent-package.mjs`）

- 下载 Node 归档时，同时把归档里的 npm（macOS `lib/node_modules/npm`，Windows `node_modules/npm`）解出到 `runtime/npm/`，写入 `manifest.json` 完整性清单。
- 使用 `--node-runtime <本地二进制>` 时，要求同时给 `--npm-dir`，或从二进制旁的 `../lib/node_modules/npm` 推导；都没有就报错。
- 宿主调用方式：`runtime/node runtime/npm/bin/npm-cli.js …`。
- `clients/desktop/scripts/check-agent-package.mjs`、`check-agent.mjs` 增加 `runtime/npm/bin/npm-cli.js` 检查。
- 预计包体 +10MB 左右（以实际构建为准）。

## 5. 桌面宿主扫描（`src-tauri/src/agent_solutions.rs` → `agent_projects.rs`）

1. `AgentSource` 改为 `Codex`、`Claude`、`ClaudeDesktop`、`Workbuddy`；删除 TRAE、Qoder 解析及其测试。
2. Codex / Claude 系：沿用现有会话解析拿到「写入过的文件 + 会话开始时间 + 模型」，再按 §2 求项目根；不再重放文件内容（项目只看磁盘上现存的目录）。
3. WorkBuddy：只扫任务目录；Cowork：只扫 `outputs/`。
4. Fred：新命令 `list_fred_workspace_files(workspace_keys)`，由前端把接口拿到的 key 交给宿主列文件；宿主校验 key 格式并确认目录在 `agent-data/workspaces/` 下。
5. 对外命令：`list_agent_projects`、`read_project_file`、`open_project_file`（含在文件夹中显示）、`detect_project_runner`、`start_project`、`stop_project`、`project_run_status`（含日志）。
6. 缓存：沿用「会话文件 mtime + size 不变则复用」；项目目录的文件列表按目录 mtime 失效。

## 6. 工作台页面（`src/pages/Workbench/`）

保留「顶部来源卡片 + 左列表 + 右详情」布局，单位从「文档」改成「项目」。

- 来源卡片：全部、Fred、WorkBuddy、Codex、Claude、DeepSeek（按模型）。
- 列表卡片：项目名、来源 / 员工、文件数、运行方式徽标（网页 / Node / Python / 不可运行）、最近修改时间。
- 详情：
  - 顶部：项目名、简介、**运行按钮**（未运行 → 运行；运行中 → 打开 / 停止）、在文件夹中显示、回到会话（Fred）。
  - 左：文件树（群聊第一层是员工名）；右：选中文件的预览 / 源码（沿用现有 Markdown、HTML、SVG、CSV 预览与安全规则）。
  - 运行中时可展开日志。
- 代码重命名：`solutions.ts` → `projects.ts`，`SolutionSummary` → `ProjectSummary`；`api.ts` 改为调用新接口与新命令。
- 浏览器开发模式：本机来源和运行按钮显示「仅桌面端可用」。

## 7. 实施顺序与验证

每一步单独提交，测试同步写。

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | Agent 接口 `GET /api/agent/workspaces` | agent_service 单测：只返回本人会话（跨成员不可见）、响应不含绝对路径、群聊返回全部成员（含已移出）、非受管路径被跳过、`has_files` 忽略 0 字节和隐藏文件；OpenAPI 导出；`check:api-contract`（注意 HEAD 上已有 approvals 两条基线失败） |
| 2 | 随包 npm | `pnpm --dir clients/desktop agent:build` 后 `check:agent-package` 通过；用随包 node 执行 `npm-cli.js --version` |
| 3 | 宿主扫描改写 | `cargo test --lib agent_projects`：项目根判定（新建目录、老仓库内新建子目录被排除、家目录 / tmp 排除）、Fred key 校验与路径逃逸、文件过滤；`cargo clippy`、`rustfmt --check` |
| 4 | 运行：静态服务器、进程管理、确认 | Rust 单测：路径穿越（`..`、编码后的 `%2e%2e`、符号链接）、运行方式识别、命令拼装、子进程环境不含 `AITEAM_*`；`check:tauri-security` |
| 5 | 工作台页面 | `tests/workbench*.test.ts`（纯函数：筛选、排序、文件树、运行状态）；`tsc -b`；改动文件 eslint `--max-warnings 0`（全仓已有 97 条基线警告） |
| 6 | 端到端 | 让 Fred 员工分别做一个多文件 HTML 小游戏、一个 Vite 项目、一个 Streamlit 小应用，在桌面端点运行；本机 WorkBuddy / Codex / Claude 真实数据跑一遍；900×600 和 1280×800 下点一遍 |

完成后更新 `clients/desktop/docs/workbench-agent-solutions.md`（改名为 `workbench-projects.md`）和 `clients/desktop/docs/README.md` 索引。

## 8. 风险与已知限制

- **运行的是 Agent 生成的代码，权限等同当前用户。** 只靠首次确认弹窗兜底，没有沙箱；`npm install` 会访问网络并可能执行依赖的安装脚本。
- 端口识别靠进程输出，个别框架输出格式不同会识别不到，需要用户看日志手动打开。
- Python 依赖系统 python3；未安装时提示安装，Windows 上可能是 `py`。
- Codex / Claude 规则依赖目录创建时间；Agent 用 shell 命令建的目录只要有被记录的写入就能识别，完全靠 shell 写出的项目识别不到。
- Fred 群聊里已移出成员的目录仍算在项目里（保留历史产出）。
- TRAE、Qoder 去掉后，这两个平台的数据不再出现在工作台。
