# 工作台：继续对话与交给员工继续做

## 目标

Fred 自己的项目在工作台只提供「继续对话」，回到原会话。其他工具（Codex、Claude、Claude 桌面版、WorkBuddy）做出的项目可以「交给员工继续做」：选择员工并确认对话名（默认项目名）后，开启新对话。对话的工作目录就是项目目录。同一员工的不同对话，上下文和记忆互相隔离。

## 已确认的决定（2026-11-08）

| 问题 | 决定 |
| --- | --- |
| 记忆 | 员工有一份共同记忆，每个项目对话另有独立记忆，二者互不读写 |
| 文件权限 | 默认 `workspace-write`，写入限制在项目目录内 |
| 同时运行 | 允许多个对话同时操作同一目录，系统提示词提醒文件可能被改动 |
| 来源 | Fred 以外的全部来源，第一版只支持 macOS；Fred 项目回到原会话（2026-11-08 用户修订） |
| 名称 | 按钮叫「交给员工继续做」，Fred 项目的按钮叫「继续对话」，不用「二次开发」 |
| 工作目录（2026-11-09 用户补充） | 权限面板要显示项目目录，并且可以更换，因为项目以后可能搬家 |

## 非目标

- 群聊项目对话：只支持选一个员工的私聊。
- 文件隔离：多个对话共用项目目录，互相可见改动。
- 把项目对话的记忆展示到企业端记忆管理页面。
- 删除对话时删除 Hindsight bank：仓库内没有可核实的删 bank 接口，见「已知限制」。

## 设计

### 记忆隔离（Manager + Agent）

- `derive_hindsight_bank_id` 增加可选 `memory_scope`。带 scope 时派生独立 bank，派生内容包含企业、员工、成员和 scope；不带时结果与现状完全一致。
- scope 是 Agent 算出的 32 位十六进制摘要（`sha256("project-conversation-v1:" + conversation_id)`）。Manager 看不到对话 ID、项目名或路径，会话内容不上传的边界不变。
- `POST /api/manager/hindsight/memory-runtime-config` 增加可选 `memory_scope`，返回的 `base_url` 变为 `.../employees/{id}/scopes/{scope}`。旧的租约接口 `/runtime-config` 不接受 scope。
- 权限校验、记忆策略和保留期沿用现有 `MemoryService`，只有 bank 不同。保留任务本来就按 `bank_id` 记账，策略变更按 `employee_id` 更新，因此对独立 bank 同样生效。
- Agent 的 Hindsight 本地状态目录按 scope 区分，否则指向同一目录的对话会共用队列。
- 取不到带 scope 的配置时不回退到员工共同 bank：旧 Manager 返回 422 时，本次会话不启用记忆。

### 借用目录（Agent）

- `conversation` 表新增 `project_source`，`workspace` 存规范化路径。该字段一经写入不可更改，防止后续保存把标记清掉，导致用户的项目被当作受管目录删除。
- `POST /api/agent/conversations` 增加 `project: { name, ticket }`。Agent 通过私有通道向宿主兑换路径，前端不传路径；其他字段（如 `workspace_key`、`path`）一律拒绝。
- 带标记的对话与受管目录的差异：
  - 删除对话时不删目录，只删会话文件和本地记忆状态。
  - 不 `chmod`，不抓取产物。
  - 不出现在工作台的 Fred 项目列表。
  - 不参与旧目录布局迁移。
  - 目录失效时，发送消息返回 `409 project_workspace_unavailable`。
  - 会话详情返回 `project.path`（本机路径，只经本机 Agent 给本机界面）。
  - `PUT /api/agent/conversations/{id}/project-folder { ticket }` 更换工作目录：只收来源为 `folder` 的宿主票据，员工回复中返回 `409 conversation_busy`，非项目对话返回 `422 invalid_project`，都在消耗票据前检查。成功后改写 `workspace` 和 `project_id`，同步参与者行，丢弃缓存的 Pi 会话；下一轮用同一会话文件、新目录作 cwd。记忆范围按对话 ID 派生，不受影响。
- 宿主和 Agent 都拒绝 Fred 数据目录，项目对话不会和 Fred 会话共用目录，因此删除 Fred 会话不需要额外保护。

### 外部项目票据（桌面宿主）

1. 前端调用现有 `POST /api/agent/local-directories/challenges`，得到绑定当前成员的挑战。
2. 前端调用新命令 `authorize_project_workspace(challenge, source, project_id)`。宿主重新解析项目目录，拒绝根目录、用户主目录和运行时目录，返回一次性票据（30 秒有效）。
3. 前端创建对话时带上票据。Agent 用新操作 `consume_project` 兑换路径。

项目票据和知识目录票据互不通用。

更换目录用新命令 `select_project_folder(challenge, default_path)`：宿主弹出文件夹选择框（不写入知识库的文件访问授权），对所选目录做同样的拒绝检查，`project_id` 按工作台同一算法（路径 FNV-1a）计算，票据来源固定为 `folder`。

### 前端

- Fred 项目详情页只有「继续对话」，回到原会话。
- 其他来源的项目详情页有「交给员工继续做」按钮和弹窗：选员工、改对话名（默认项目名）。
- 非 macOS 上，这个按钮不可用并说明原因。
- 已交给员工的外部项目归到 Fred（按 `project.id` 匹配），按钮变成「继续对话」。`project_id` 与其他项目字段一样只写一次。
- 来源卡片只显示扫描出项目的平台。
- 对话元数据新增 `project: { source, name, id?, path }`，对话页显示项目名。
- 权限面板：项目对话显示工作目录和「更换目录」按钮；权限改为三档（只读 / 工作区可写 / 完全访问），按钮汇总文字按实际档位显示。
- 「和某员工对话」不再落到项目对话上。

## 实施步骤

1. Manager：bank 派生、接口、协议适配器、测试，修订概要设计 04 §6.6 和 D17 说明。
2. Agent：存储字段、创建接口、会话运行、删除保护、记忆 scope、测试。
3. 宿主：`authorize_project_workspace`、`consume_project`、测试。
4. 前端：API、弹窗、对话页标识、测试，更新 `workbench-projects.md`。
5. 验证：Manager/Agent/Rust/前端测试和类型检查，用真实 HTTP 与文件系统验证隔离和删除保护。

## 完成标准

- 同一员工的项目对话与普通对话、两个项目对话之间，recall 和 retain 落在不同 bank。
- 普通对话的 bank 与改动前一致，已有记忆不受影响。
- 删除项目对话后，项目目录和文件完好。
- 前端无法通过接口让 Agent 使用任意路径。

## 已知限制

- 删除项目对话后，Hindsight 中的独立 bank 不会被删除。它不再有入口可访问，有限保留期仍会清理其中的记忆；无限保留时会一直留存。目前员工 bank 同样没有删除逻辑。
- 项目对话的记忆不进入企业端记忆管理页面，管理员无法查看或单独删除。
- 只支持 macOS，因为宿主私有通道目前只有 macOS 实现。
