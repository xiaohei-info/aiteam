# 附件改为按路径引用、Agent 按需读取（方案）

状态：待确认 · 分支 `feat/attachment-by-path`（基于 PR #232 `f2ddcaf5`）

## 1. 目标与已拍板的决定（2026-11-27）

- 桌面端发消息时附件**只传文件路径**，不再把字节经 WebView 转 base64 上传给本机 Agent。
- **放开附件大小限制**（不再有 5 MiB 上传上限）。
- Agent **按需读取**：提示词只写文件名、类型、大小和路径；模型需要时调用工具去读。
- **所有员工**都有附件读取工具，与员工有没有编程 / 本机目录能力无关；工具只能读本会话用户附上的文件。
- 引用的是原文件：用户事后移动或删除，历史附件读不到（接受）。

## 2. 现状（根因）

| 位置 | 现状 |
|---|---|
| `server/agent_service/src/pi/attachment-tool.ts:15` | 附件只认本地库 ID，注释明确 "never accepts a filesystem path" |
| `server/agent_service/src/http/server.ts:3071-3105` | 发消息时预先处理：文档抽文字整段拼进提示词（单文件 64k 字、合计 200k 字）；图片转 base64 作为图片输入 |
| `local-files.ts:4`、`storage/sqlite.ts:475/648/1235`、`http/server.ts:3422` | 单文件 5 MiB：常量、建表 CHECK、HTTP 上传校验 |
| `clients/desktop/src/components/Chat/ChatInputBar.tsx:265` | 附件先 `cache_file` 复制到会话目录，再 `readCachedFileBlob` → base64 → `uploadFile`，拿到 ID 才能发（转圈即此步） |
| `pi/sandbox.ts` / `session-host.ts:1265-1310` | 读文件工具只在会话工作目录和授权文件夹内，且只给带编程能力的员工 |

## 3. 设计

### 3.1 接口（北向契约变更，需确认）
`POST /api/agent/conversations/{id}/prompt` 新增字段：

```jsonc
"attachment_paths": [
  { "path": "/Users/me/报告.pdf", "name": "报告.pdf" }   // 绝对路径；name 仅展示
]
```
- 与现有 `attachment_ids` 并存：`web/agent` 浏览器端拿不到路径，继续走上传（保留 5 MiB）。桌面端只用 `attachment_paths`。
- 校验：绝对路径、存在、是普通文件（不是文件夹 / 符号链接逃逸后再判断）、每条消息最多 N 个（沿用 8，可调）。大小不限。
- 幂等指纹加入 `attachment_paths`。

### 3.2 Agent 存储
新表 `local_file_ref`（或 `local_file` 加 `source_path` 列 + 放开 `byte_size` CHECK，二选一，倾向新表，避免改动既有 5 MiB 上传语义）：
`id, conversation_id, tenant_id, member_id, entry/message key, path, name, mime_type, byte_size(发送时), mtime(发送时), created_at`。
- 只记元数据，不存字节。
- 记录发送时的大小和修改时间，读取时发现文件变了要在工具结果里说明。

### 3.3 提示词
发送时不再抽全文。拼在消息后：
```
[用户附件，可用 attachment_read 工具按需读取]
- 报告.pdf（PDF，12.3 MB）
- 截图.png（图片，1.1 MB）
```
不把绝对路径写给模型（模型用附件编号调用工具，路径只在 Agent 内部映射，避免把用户目录结构带进模型上下文）。

### 3.4 `attachment_read` 工具（所有员工）
- 在 SessionHost 装配员工工具时**无条件**加入（不依赖 coding tools / sandbox）。
- 参数：`attachment`（编号或文件名）、`offset` / `limit`（分段，按字符或页）。
- 只能读本会话 `local_file_ref` 里登记的文件；不接受任意路径。
- 文本 / PDF / DOCX：复用 `document-extractor`，改为流式 / 分段读取，去掉整文件读入内存与 50 页上限（分段时按页读）。
- 图片：读出来作为图片内容返回给模型（模型要"看"图只能拿字节）；单张过大时先缩放到模型可接受尺寸。
- 其他二进制（视频、压缩包等）：返回元数据和"不支持读取内容"。
- 工具调用照常进时间线与审计。

### 3.5 桌面端
- 拖入 / 「+ 导入」：直接拿原文件路径，**不再 `cache_file` 复制**，不再上传，附件立即可发（不转圈）。
- 粘贴截图 / 粘贴文件（没有路径）：仍 `cache_file_bytes` 写进会话目录，用缓存文件的路径（粘贴的 64 MB 限制保留，来自 IPC 传输）。
- 删除 `ChatInputBar` 的上传状态机（`handleUploadFile` / `beginAttachmentUpload` / 取消后删除远端附件）在桌面端的使用；`singleChatPrompt.ts` / `groupPrompt.ts` 改发 `attachment_paths`。
- 历史消息里的附件 chip：显示名称；点击用路径打开，文件不在了显示"文件已移动或删除"。

### 3.6 群聊
`services/group-message-delivery.ts` 把附件转交给被 @ 的员工：改为转交 `local_file_ref` 编号，各员工会话可读同一组引用。

## 4. 涉及文件（预估）

- Agent：`http/server.ts`（prompt 校验与拼提示、OpenAPI schema）、`storage/sqlite.ts`（新表与迁移）、`pi/attachment-tool.ts`（按引用读、分段）、`pi/document-extractor.ts`（分段）、`pi/session-host.ts`（无条件装配工具）、`services/group-message-delivery.ts`。
- 桌面：`ChatInputBar.tsx`、`fileCache.ts`、`lib/singleChatPrompt.ts`、`lib/groupPrompt.ts`、`pages/Chat/index.tsx`、`pages/GroupChat/index.tsx`、`api/agent/types.ts`、`docs/api.json` 契约快照。
- 文档：v1 概要设计 06（Pi Resource / 附件装配）与 02（北向 API）对应段落。

## 5. 实施顺序

1. Agent：新表 + `attachment_paths` 校验与落库 + 提示词附件清单（测试：路径校验、幂等、文件夹 / 不存在拒绝）。
2. Agent：`attachment_read` 分段读取 + 无条件装配（测试：只能读登记文件、越权编号拒绝、大 PDF 分段、文件被改 / 删除提示、图片返回）。
3. Agent：群聊转交。
4. 桌面：发 `attachment_paths`，去掉桌面端上传；粘贴走缓存路径；历史 chip。
5. 契约快照与概要设计文档同步。
6. 验证：Agent 全量测试、桌面全量测试 + 冒烟；真机发 200 MB PDF / 大图 / 视频各一次，单聊与群聊。

## 6. 需要确认的点

1. 新接口字段 `attachment_paths` 与新表（属于北向 API 与本地库表变更）。
2. 提示词里不写绝对路径，模型只看到附件编号和文件名 —— 是否同意。
3. `web/agent` 浏览器端保持上传与 5 MiB 不变 —— 是否同意。
4. 每条消息附件数上限：沿用 8，还是放宽。

## 7. 非目标

- 不改企业知识库上传（走 Manager，另有限制）。
- 不改 `web/agent` 的上传流程。
- 不做附件内容跨端上传（本地优先不变）。

## 8. 实施记录（2026-11-27）

§6 四点按建议拍板：新增 `attachment_paths` 字段 + `local_file_ref` 表；模型只看到附件编号与文件名，不看到绝对路径；web/agent 继续走 5 MiB 上传；单条消息附件（上传 + 路径合计）最多 8 个。

已实现：

| 项 | 落点 |
| --- | --- |
| 请求字段 `attachment_paths: [{ path, name? }]`，缺失 / 文件夹 / 相对路径 → 422（`attachment_not_found` / `attachment_not_a_file` / `invalid_attachment_paths`），与 `attachment_ids` 合计超 8 个 → 422 `too_many_attachments` | `server/agent_service/src/http/server.ts`、`src/pi/attachment-refs.ts` |
| `local_file_ref` 表（按会话 + 成员隔离，同一会话同一路径复用编号 `ref-…`；删除会话时一并删除） | `src/storage/sqlite.ts` |
| 消息末尾追加「用户附件」清单（编号、文件名、类型、大小），不含路径 | `attachmentManifest` |
| 5 MiB 以内的图片仍随消息作为图片输入（与原来一致）；更大的图片不缩放，`attachment_read` 返回「超过 5 MiB 无法查看」 | `loadInlineImage` |
| `attachment_read(attachment, offset, limit)` 给所有员工、免审批（只读）；文本 / PDF / Word 整体提取后按字分段（默认 2 万字，最多 6.4 万字）；PDF 不再限 50 页；超过 256 MiB 的纯文本按字节窗口读取；视频、音频、压缩包等只给文件名和大小；文件被移动 / 删除 / 修改都会如实告诉员工 | `src/pi/attachment-refs.ts`、`src/pi/session-host.ts`、`src/approval-service.ts` |
| 桌面端拖入、「+ 导入」只记录原文件位置（新命令 `describe_local_file`，不复制、不上传），粘贴仍写入会话缓存后按缓存路径引用；历史消息里点按路径引用的附件直接打开本机文件 | `clients/desktop/src-tauri/src/files.rs`、`src/lib/fileCache.ts`、`src/lib/chatAttachmentUpload.ts`、`ChatInputBar.tsx`、`AttachmentBar.tsx`、单聊 / 群聊页面 |
| 契约快照 `docs/api.json` 的 `PromptRequest` 增加 `attachment_paths` | `clients/desktop/docs/api.json` |

已知边界：历史消息里的附件点开依赖系统授权范围（拖入 / 选择后本次启动内可打开；重启后可能提示需要重新授权或文件已移动）；Agent 只在员工调用工具时读取文件，所以发送后再改动文件，员工读到的是改动后的内容（工具结果会注明「发送后被修改过」）。

### 8.1 实机验证后的补充（2026-11-27）

- 历史消息：Agent 追加的「用户附件」清单不再显示在气泡正文里，改为附件卡片（`src/lib/attachmentManifest.ts` 的 `splitAttachmentManifest`，在 `piConverters` 里只处理用户消息）。
- 历史消息里点开按路径引用的附件：发送时按「会话 + 文件名」把本机位置记在本地（localStorage，最多 500 条），点开时找回；找不到时提示到原文件夹打开。
- 同一个文件再拖入 / 再选择不重复添加；同一条消息里重复的路径 Agent 只列一次。

实机结果（macOS，本分支 `pnpm tauri dev`，Agent 由 `agent:build` 打包）：

| 场景 | 结果 |
| --- | --- |
| 单聊从访达拖入 12 MiB 文本 | 立即出现附件卡片、无转圈；员工调用 `attachment_read` 分段读到开头和结尾标记 |
| 拖入文件夹 | 提示「“a-folder”是文件夹，不能作为附件；请拖入文件」 |
| 「+ 导入」选择 small.md + 粘贴 12 MiB 文件，同一条消息 | 两张卡片；员工答出口令与结尾标记；库里导入 / 拖入记原路径，粘贴记会话缓存路径 |
| 历史消息点开附件 | 用系统默认应用打开原文件 |
| 群聊拖入 + @成员 | 被 @ 的员工读到附件并回答 |
| 同一文件拖入两次 | 只出现一张卡片 |
