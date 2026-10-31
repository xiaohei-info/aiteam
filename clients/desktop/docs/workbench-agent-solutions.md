# 工作台：汇总 AI 员工生成的方案文件

> 分支：`feat/workbench-agent-solutions`
> 入口：左侧栏「工作台」（人才市场与组织架构之间，⌘6；组织架构改为 ⌘7，办公室改为 ⌘8）

## 1. 目标

工作台不展示聊天记录，只展示**对话中生成的方案类文件**，并且每份文件只展示**最终版本**。没有生成方案文件的对话不会出现。

来源分两类：

| 来源 | 读取方式 | 归属 |
|---|---|---|
| Fred | 本机 Agent API：会话产物（artifact） | 私聊归入口员工，群聊归协调员工 |
| Claude Code、Claude 桌面版、Codex、TRAE CLI、Qoder CLI、WorkBuddy | 桌面宿主（Rust）只读解析本机会话记录 | 显示为平台名，暂未映射到具体 AI 员工 |
| DeepSeek | 不是客户端，按模型汇总：任一平台上由 DeepSeek 模型写出的方案 | 与原来源重复计数 |

## 2. 什么算方案文件

只按文件类型和路径判断，不分析内容和意图：

- 扩展名：`md / markdown / txt / html / htm / csv / svg`，以及 `docx / doc / pptx / ppt / xlsx / xls / pdf`（后者只能用系统应用打开，不在页面内预览）。
- 排除：
  - 代码文件。
  - 隐藏路径、`node_modules`。唯一例外是 Claude Code 计划模式保存的 `~/.claude/plans/<name>.md`。
  - 说明类文件：readme、agents、claude、gemini、changelog、license、contributing、code_of_conduct、security、skill。
  - 文件名像凭据的文件（password、token、apikey、accesskey 等）。
- 新建和修改的文档都算；会话结束时至少还有一份可展示的文件，这个会话才算方案。

## 3. 最终内容

1. 文件还在磁盘上：直接读磁盘。
2. 文件已删除或移动：按会话记录重放所有写入和修改，得到最终内容，页面标注「根据会话记录还原」。
3. 无法还原（例如修改了一份会话从未完整看到的旧文件）：不展示。

## 4. 各平台的解析方式（`src-tauri/src/agent_solutions.rs`）

| 来源 | 记录位置 | 格式 | 文件变更从哪里来 | 本机实测 |
|---|---|---|---|---|
| Codex | `${CODEX_HOME:-~/.codex}/sessions`、`archived_sessions` 下的 `rollout-*.jsonl` | Codex rollout | 完成状态的 `FileChange`：`add` 带全文，`update` 带 unified diff，支持 `move_path` 和删除；需求按 `turn_id` 对应 | 13 个会话 |
| TRAE CLI 2.0 | `${TRAECLI_HOME:-${TRAE_HOME:-~/.trae}/cli}/sessions`、`archived_sessions` | Codex rollout（codex-rs 分支） | 优先 `FileChange`；没有时回退到执行成功的 `apply_patch` 调用（`custom_tool_call`、`function_call`、shell argv 三种形式），`history_mutation` 中重复的调用按 `call_id` 只算一次 | 本机未安装，按公开格式实现 |
| Claude Code | `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<slug>/<id>.jsonl`（不含 subagents） | Claude Code JSONL | `Write / Edit / MultiEdit` 的 `tool_use`，只在对应 `tool_result` 没有出错时重放；优先使用 `toolUseResult` 里的 `originalFile` 和 `structuredPatch`，没有时回退到调用参数 | 6 个会话；3 份仍在磁盘上的文件还原结果与磁盘完全一致 |
| Claude 桌面版 | Code 标签页：`<app>/claude-code-sessions/<account>/<org>/local_<id>.json` 指向 `~/.claude/projects` 中的转录；Cowork：`<app>/local-agent-mode-sessions/<org>/<account>/[agent/]local_<id>/.claude/projects/...` | 同 Claude Code | 同 Claude Code；Cowork 额外把 `outputs/` 里的文件算作交付物，忽略 VM 沙箱 `/sessions/...` 路径和 `uploads/` | 本机未安装，按公开格式实现 |
| Qoder CLI | `${QODER_CONFIG_DIR:-~/.qoder}/projects`、`~/.qoder-cn/projects` | Claude Code 风格 JSONL | 同 Claude Code；没有 `toolUseResult` 时按调用参数重放；工作目录取 `workspace-directories` 记录 | 本机只有残留数据，没有会话 |
| WorkBuddy | `~/.workbuddy/projects`，任务目录 `~/WorkBuddy/<时间戳>/` | WorkBuddy JSONL | `Write / Edit / MultiEdit` 调用，加上任务目录（深度 ≤ 2）中保存的文档 | 0 个会话（本机会话没有写过文档） |

`<app>` 在 macOS 是 `~/Library/Application Support/Claude`，Windows 是 `%APPDATA%\Claude`，Linux 是 `~/.config/Claude`；Cowork 目录可用 `COWORK_SESSIONS_DIR` 覆盖。被桌面版列出的 Claude Code 会话归到「Claude 桌面版」，不再出现在「Claude Code」下。

会话标题优先级：
- Claude 系：桌面版记录标题 > `/rename` 设置的 `custom-title` > `ai-title` > 旧版 `summary` > 第一条需求。
- Codex / TRAE：`session_index.jsonl` 中的线程名 > 第一条需求。

需求（task）的过滤：去掉 `<system-reminder>`；斜杠命令取 `<command-args>`；跳过命令输出、shell 模式输入、中断提示、`isMeta`、`isSidechain`（子代理）、`isCompactSummary`（压缩摘要）。

### 接口（Tauri 命令）

- `list_agent_solutions` → 各来源状态（是否存在、方案数、是否截断）和方案列表；每个文件带 `model`，每个方案带 `models`。
- `read_agent_solution_file(source, id, fileId)` → 最终内容，以及内容来自磁盘还是会话记录。
- `open_agent_solution_file(source, id, fileId, reveal)` → 用系统应用打开，或在 Finder / 资源管理器中显示。

### 性能与上限

- 列表只缓存元数据，不缓存文件正文；会话文件的修改时间和大小不变时直接复用解析结果。
- 本机实测：冷启动扫描约 2.2–2.8 秒，之后约 5 毫秒。
- 上限：每个来源最近 300 个会话；单行 4 MB；单个文档 2 MB；每个会话最多 100 个文件；桌面版记录文件 4 MB。

## 5. 安全

- WebView 不传任何路径，只传来源、会话 id 和 16 位十六进制的文件 id（路径的 FNV-1a 哈希）；宿主侧重新解析会话后按 id 找文件。
- 会话 id 只允许字母、数字、`-`、`_`。
- 不新增 capability 或插件，`check:tauri-security` 通过。
- 不跟随符号链接。
- HTML 预览：`<iframe sandbox="">` 加 CSP meta，只允许内联样式和 `data:` 图片、字体，不访问外部地址。
- SVG 预览：以 `data:` 图片渲染，不执行脚本。
- Markdown 预览：只放行 http(s) 链接，不加载图片。

## 6. 前端（`src/pages/Workbench/`）

- `solutions.ts`：纯函数，包括来源定义、DeepSeek 判断（任一模型名包含 `deepseek`，不区分大小写）、筛选、排序、员工选项、CSV 解析、HTML/SVG 预览处理。
- `api.ts`：Fred 产物读取（并发 6），以及本机来源的 Tauri 调用。浏览器开发模式下，本机来源显示「仅桌面端可读取」。
- `index.tsx`：
  - 顶部来源卡片：全部、7 个来源、DeepSeek，紧凑网格自动换行。
  - 筛选：搜索、员工。
  - 左侧方案列表：卡片显示文件、模型、工作目录。
  - 右侧详情：文件标签、预览/源码切换、复制、打开、在文件夹中显示；Fred 方案可以打开会话。
- 布局：顶部固定，列表与详情**各自独立滚动**；最小窗口 900×600 时仍保持两栏。

## 7. 验证

| 检查 | 结果 |
|---|---|
| `cargo test --lib agent_solutions` | 19 通过 |
| `cargo clippy --all-targets` | 只有改动前就存在的 `secure_session.rs:665` 警告 |
| `rustfmt --check src/agent_solutions.rs` | 通过 |
| Workbench 相关 node 测试 | 14 通过 |
| `tsc -b` | 通过 |
| 改动文件 eslint `--max-warnings 0` | 通过 |
| `check:tauri-security` | 通过 |
| 全量 `npm test` | 586 个，580 通过，6 失败；6 个均为改动前就有的基线失败（全量运行超时后，被取消的 35 个文件逐个重跑补齐） |
| 本机真实数据 | Codex 13、Claude Code 6；Claude 系还原结果与磁盘一致 3/3 |

## 8. 已知局限

- 未在桌面端实际点击验收，包括独立滚动和新来源卡片。
- TRAE CLI、Qoder CLI、Claude 桌面版按公开资料实现，本机没有对应数据，未经真实数据验证。
- TRAE 的 `apply_patch` 回退只认直接调用。本机 Codex 记录里很多补丁是包在 `exec` 工具的脚本里执行的，回退抓不到；Codex 自身靠 `FileChange` 不受影响，TRAE 若同样只有这种记录，会漏文件。
- Trae IDE 聊天记录是加密的，Qoder IDE 聊天记录不保存在本机，claude.ai 网页对话只在云端，三者都无法读取。
- 通过 shell 命令（`cat >`、脚本等）写出的文件不会被识别，WorkBuddy 任务目录和 Cowork `outputs/` 除外。
- 修改一份会话从未完整看到的旧文件，且原文件已不在磁盘上时，无法还原，不展示。
- 每个来源只扫描最近 300 个会话。
- 判定只看文件类型和路径，有误报：本机 13 个 Codex 会话里，测试用 SVG、`/tmp` 下的提交说明草稿、`docs/todo.md` 更新等也被算作方案。
- 本机平台的会话没有映射到具体 AI 员工，只显示平台名。
- Fred 产物没有记录需求（task）和写入模型，DeepSeek 筛选对 Fred 只看员工配置的模型。

## 9. 未来需要做的

1. **桌面端验收**：在 900×600 和 1280×800 下点一遍所有来源、筛选、文件预览、打开和显示操作。
2. **收紧方案判定**（需确认规则），建议先做前两条：
   - 排除 `/tmp`、`/private/tmp` 下的文件；
   - 要求文件在该轮最终回复中被提到；
   - 可选：只算新建文件；只算 `docs/`、`plans/` 等约定目录。
3. **真实数据验证**：在装有 TRAE CLI、Qoder CLI、Claude 桌面版的机器上跑一次，核对字段名和路径；尤其是 Qoder 的 `Edit` 参数名、TRAE 的 `history_mutation` 结构、Cowork 记录的目录层级。
4. **TRAE `exec` 包裹的补丁**：确认 TRAE 是否也用 `exec` 执行补丁；如果是，从脚本里提取 `*** Begin Patch` 文本并按输出判断成败。
5. **员工映射**：把本机平台的会话关联到人才市场里的 AI 数字员工（例如按工作目录、模型或人工绑定）。
6. **扫描性能**：冷启动 2–3 秒，会话变多后考虑增量扫描、后台预热，或把 300 个会话的上限做成可配置。
7. **Fred 补充需求和模型**：从会话消息里取生成产物那一轮的用户需求和实际模型。
8. **更多来源**：Gemini CLI、Cursor CLI 等有本机记录的工具，可按同样的解析方式接入。
9. **Windows / Linux**：路径和「在文件夹中显示」已按平台实现，但只在 macOS 上验证过。
