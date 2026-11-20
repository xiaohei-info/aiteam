# 企业端技能 / MCP 新增（含模型帮装）与运营端 ClawHub 打通 · 需求与设计

日期：2026-11-20
状态：设计草案，**未写代码**；已决定项见 §1，待决策见 §9
配套可视化：`2026-11-20-企业端技能MCP新增与ClawHub打通-可视化.html`
参照：桌面端「能力」页（`clients/desktop/src/pages/Capabilities/*`）、`2026-11-19-ClawHub接入-设计v2.md`、`docs/superpowers/specs/2026-08-24-operator-clawhub-skill-market-design.md`

---

## 0. 需求原文

1. 企业端增加一个功能：新增 skill 和 MCP，方案同桌面端，要能自定义，也要能使用模型帮忙安装。
2. 运营端的 ClawHub 功能存在卡点，需要打通所有环节，参考桌面端的实现。
3. （2026-11-20 追加）桌面端的 MCP 增加企业 MCP 的列表，可以一键使用。

## 1. 已决定（用户 2026-11-20 拍板）

| # | 事项 | 决定 | 推翻 / 修订的既有口径 |
|---|---|---|---|
| A | 签名技能包契约 | 放宽为「任意安全相对路径的 UTF-8 文本」；二进制文件跳过并在预览列出；跳过 `hooks/<平台>/`；上限对齐桌面端：256 文件 / 总 10 MiB / 单文件 5 MiB。三端同改，需重打随包 Agent | 08-24 设计「v1 只支持 SKILL.md 与 references/*.md」 |
| B | 运营端 ClawHub 安全扫描 | 同桌面端：**显示但不拦**；导入 / 开放照常按「下载后自动开放」开关 | 08-24 设计「只允许 verify ok / pass / security.passed」 |
| C | Manager 直连外网 | 允许，仅用于管理员自定义导入（网址 / ClawHub）；限 https、SSRF 防护、大小 / 超时上限；平台市场分发链路不变 | 08-24 设计「Manager 不直连 ClawHub」 |
| D | 企业端「模型帮忙安装」 | Manager 用本企业可见的平台模型，经本企业 Relay 令牌跑**一次性有界工具循环**，只返回候选方案；管理员预览确认后走同一安装流程；不落会话、不自动安装 | **04 §6.7 / 00 D18「Manager 不调用 LLM/Relay」**（`server/manager_service/provider_credential_service.py:11`） |
| E | 模型帮装的用量 | 计入企业 owner（用量行 `member_id` = 企业 owner），进企业用量汇总并按既有链路上报 Operator；不记内容 | 新增口径 |
| F | 桌面端企业 MCP 列表 | 「添加 MCP」增加「从企业拿」列表（平台启用 + 企业自建），一键安装；与「添加技能 → 从企业拿」同构 | 新增（2026-11-20 追加需求） |

## 2. 现状核对

### 2.1 运营端 ClawHub 卡点（实测 + 代码）

实测（2026-11-20，真实 clawhub.ai）：浏览前 8 + `spreadsheet` + `self-improving-agent` + 搜 `pdf` 前 5，共 15 个技能，走现有运营端导入链路**只有 3 个成功**。

| # | 卡点 | 位置 | 实测表现 |
|---|---|---|---|
| B1 | 只收 `SKILL.md` + `references/*.md` | `server/operation_service/platform_skill_market.py:30-36`（`_valid_path`）、`:57`（目录只许 `references/`）；`server/operation_service/routes_skill_market.py:103-118`、`:110`；共享契约 `server/shared/contracts/skill.py:21-30` | `spreadsheet`（根目录 `csv.md`）、`self-improving-agent`（`assets/`、`scripts/`）、`tiktok-search-api`（`assets/*.json`）全被拒 |
| B2 | 安全强拦截 | `routes_skill_market.py:90-102`（`_verified_text_manifest`：`security.passed` 必须为真、`ok` 必须为真，`card.missing` 除外） | 5 个 `suspicious` 被拒；`pending`（未扫完）也被拒 |
| B3 | 上限过小 | `platform_skill_market.py:19-22`（zip 2 MiB / 64 文件 / 单文件 256 KiB / 总 1 MiB） | 多文件技能易超 |
| B4 | 平台钩子不跳过 | `platform_skill_market.py:60`（只跳 `_meta.json`、`skill-card.md`） | `hooks/openclaw/*` 一出现即整包失败 |
| B5 | 错误被吞成 503 | `routes_skill_market.py:236-239`：只放行 `ValidationProblem` / `NotFound`，`TooManyRequests`（429）等也变成「ClawHub skill download failed」 | 用户看不到真实原因 |
| B6 | 页面耦合 | `web/operation/src/features/skill-market/SkillMarketPage.tsx:32`、`PlatformSkillSelector.tsx:49`：内部目录与 ClawHub 用同一个 `Promise.all` | ClawHub 不通时内部市场也空白 |
| B7 | 无分页 / 无防抖 | `useSkillMarketApi.ts`（`listExternal` 丢弃 `next_cursor`）；`query` 每次按键都触发 `load` | 只见前 20 条；连续输入易触发 429 |
| B8 | 下载前无预览 | 页面只有「详情」外链 + 「下载」 | 看不到文件清单、安全结论、跳过项 |
| B9 | 搜索结果无版本 | `platform_skill_market.py:148-158`（`_from_search` 取 `item.version`，实测为 null） | 「已下载 / 可更新」判断永远失准 |
| B10 | 下游同样卡 | Manager 成员可装列表 `server/manager_service/capability_catalog_repository.py:120-127`（SQL 判 1–64 文件 / ≤1 MiB）；`custom_skill_package.py:15-18`；Agent 验签 `server/agent_service/src/skills.ts:73-79` | 放宽运营端后，企业装得进、成员装不了 |

### 2.2 企业端现有能力

| 能力 | 位置 | 现状 |
|---|---|---|
| 技能目录 CRUD | `server/manager_service/routes_capability.py:57-118`；`web/manager/src/features/capability/CapabilityPage.tsx:395-443` | 只能手填「JSON 文件数组」；提示「最多64文件/1MiB，仅Markdown文本」（`CapabilityPage.tsx:409`） |
| 平台技能市场 | `server/manager_service/platform_skill_service.py`；`web/manager/src/features/skill-market/SkillMarketPage.tsx` | 只能装 Operator 已开放的 |
| MCP 目录 | `server/manager_service/mcp_catalog.py`；表 `migrations/0055_mcp_catalog.sql:8-43`；页 `web/manager/src/features/mcp-market/McpMarketPage.tsx` | **只能启用平台 MCP**，没有企业自建入口；`enable`（`mcp_catalog.py:160-166`）每次回拉平台列表，非平台条目 NotFound |
| 模型调用 | — | 无；`provider_credential_service.py:11` 明写「Manager 不调用 LLM/Relay」 |
| 外网调用 | `connector_probe.py`（仅本地校验，docstring 明写不外呼） | 无 |

### 2.3 桌面端（参照实现）

| 能力 | 位置 |
|---|---|
| 添加技能：企业目录 / 自定义两 tab | `clients/desktop/src/pages/Capabilities/AddSkillDialog.tsx` |
| 自定义来源：文件夹 / zip / 单个 .md / 粘贴 / 网址 / ClawHub；先「检查」后「安装」；多技能包勾选；同名候选；安全提示；跳过的平台文件 | `CustomSkillImport.tsx`；后端 `server/agent_service/src/custom-skills.ts`（`normalizeSkillAtRoot` :129、`scanSkillRoots` :117、`fetchSkillFromUrl` :344、`fetchClawHubSkill` :519、`clawHubSecurity` :536、`isPlatformHookPath` :506、`unzipEntries` :592） |
| 添加 MCP：粘贴配置 / 地址 → 检查鉴权 → 登录或填令牌 | `McpAuthDialogs.tsx:121`；解析 `clients/desktop/src/lib/mcpConfigImport.ts`；Agent `mcp-auth.ts:146-172`（`probeMcpAuth`） |
| 让员工帮我装 | `AskEmployeeDialog.tsx`：新开会话，员工用搜索 / 安装工具（`custom-skills.ts:425` ClawHub 搜索、`:446` GitHub 搜索），成员批准后落库 |

**桌面端没有企业 MCP 列表**：`AddMcpDialog`（`McpAuthDialogs.tsx:121`）只有「粘贴配置 / 地址」一条路；Agent 只在员工对话安装时内部读取企业 MCP 目录（`connectors.ts:214-227` `InstallableMcpInfo` / `planInstall` :409-450），**没有对桌面开放的列表或按目录安装接口**（技能有：`GET /api/agent/capabilities/installable-skills`，`http/server.ts:1745`）。`installMcpDirectly`（`connectors.ts:622`）固定写 `source: "user_url"`，不能用于目录条目。

运营端已有更严格的 MCP 探测（Python）：`server/operation_service/mcp_probe.py`（SSRF 防护 `_blocked`/`public_addresses` :72-96、钉 IP 的 `_pinned_fetch` :98、OAuth 发现 `_discover_oauth` :190、列工具 `probe_mcp` :219），只依赖 `shared.contracts.platform_mcp` 与 httpcore，可整体移到 `server/shared/`。配置解析 `web/shared/src/contracts/mcp-config.ts:134`（`parseMcpConfig`）企业端前端可直接复用。

### 2.4 签名技能包链路（放宽要改的全部位置）

| 端 | 位置 | 现约束 |
|---|---|---|
| shared | `server/shared/contracts/skill.py:21-30`（`normalize_skill_file_path`）；`SkillFile` :41-49；`compute_content_hash` :63 | 路径只许 SKILL.md / references/*.md |
| Operation | `platform_skill_market.py:19-75`；`routes_skill_market.py:90-118`、`:196-239` | 见 §2.1 |
| Manager | `custom_skill_package.py:13-27`（1–64 文件 / 1 MiB）；`capability_catalog_repository.py:58-69,120-127`（`package_shaped` SQL）；`authorized_config_service.py:278`（`package_shaped` 决定成员可否自装）；`schemas.py:499`（字段描述） | 同上 |
| Agent | `server/agent_service/src/skills.ts:73-79`（`canonicalPath`）、`:217`；落盘 `:450-466`（`mkdirSync(..., 0o700)` + `writeFileSync(..., 0o600)`，已支持子目录，不加执行位） | 同上 |
| 测试 | `server/tests/manager/test_skill_signing.py`、`server/tests/manager/test_authorized_config.py`、`server/tests/operation/test_platform_skill_market.py`、`server/agent_service/src/skills.test.ts`、`custom-skills.test.ts` | 断言旧约束，需同步改 |
| 文案 | `CapabilityPage.tsx:409`；桌面 `AddSkillDialog.tsx:89`、`Capabilities/index.tsx:209`「技能只包含说明文档，不执行代码」 | 放宽后失实（见待决策 #6） |

### 2.5 用量链路（模型帮装要接入的位置）

- 表 `usage_rollup`：`migrations/0007_usage_audit_quota.sql:19-35` + `0044_usage_attribution_delivery.sql:13-35`（`member_id`、`input_tokens`/`output_tokens`、`pricing_status`/`pricing_version`/`cost_total` 可空）。
- 写入：`usage_audit_quota_service.py:93-139`（`ingest_upload` → `upsert_usage_with_delivery`，同事务写入向 Operator 的投递回执）。
- 模型选择：`routes_platform_model.py:23`（本企业可见平台模型）；Relay 解析 `operator_catalog.py:82/181`（`resolve_tenant_access`，有副作用：会让 Operator 预配本企业 Relay 访问，见 `recruit_service.py:76`）；协议 `shared/contracts/platform_provider.py:41`：`openai-completions | openai-responses | anthropic-messages`。

---

## 3. 目标与非目标

**目标**
1. 运营端：ClawHub 浏览 → 预览（文件 / 安全 / 跳过项）→ 导入 → 开放 → 专家模板引用 → Manager 安装 / 招募 → 成员 Agent 验签缓存，**全链路走通**，带脚本 / 资源的技能也能分发。
2. 企业端：管理员可新增技能（文件夹 / zip / 单个 md / 粘贴 / 网址 / ClawHub，同桌面端交互）与企业自建 MCP（粘贴配置或地址 → 检查 → 保存），成员像拿平台条目一样自行安装。
3. 企业端：「让模型帮我找」——写需求（可附链接 / JSON），模型给出候选，管理员点候选进入对应导入窗口确认安装。
4. 桌面端：「添加 MCP」里直接看到企业已开放的 MCP（平台启用 + 企业自建），一键安装；需要登录 / 令牌的，安装后接着登录或当场填令牌。

**非目标**
- 不做二进制技能文件分发（图片等跳过并提示）。
- 不在任何控制面执行技能脚本、不安装依赖。
- 不做 ClawHub 登录 / 发布。
- 不改成员本机「让员工帮我装」流程。
- 模型帮装不保存需求原文与模型输出，不做历史记录。

---

## 4. 方案

### 4.1 共享：技能包契约放宽（P0）

`normalize_skill_file_path`（Python）与 `canonicalPath`（Node）改为同一规则：

- 字符集保持 `[A-Za-z0-9._/-]`；不许 `\`、绝对路径、`./` 开头、`//`、空段、`.`、`..`；
- **新**：任一段不得以 `.` 开头（防止与 Agent 缓存的 `.aiteam-manifest.json` 等内部文件冲突，也排除 `.git`、`.env`）；
- 路径 ≤ 240 字符、深度 ≤ 8；
- 必须含根目录 `SKILL.md`；
- 上限：≤ 256 文件、单文件 ≤ 5 MiB、总 ≤ 10 MiB（按 UTF-8 字节）。

上限常量集中到 `server/shared/contracts/skill.py`（`MAX_SKILL_FILES` 等），Manager `custom_skill_package.py` 与 `capability_catalog_repository.py` 的 SQL 改用同一组常量（SQL 用参数，不再写死 64 / 1048576）。

导入侧（运营端 / 企业端共用，新 `server/shared/skill_import/`）的规范化：

| 情况 | 处理 |
|---|---|
| `hooks/<平台>/…` | 跳过，列入「已跳过（平台专用）」 |
| 非 UTF-8（二进制） | 跳过，列入「已跳过（二进制）」 |
| 路径不合规（空格、中文、点开头段） | 跳过，列入「已跳过（路径不支持）」 |
| `.git/`、`__MACOSX/`、`.DS_Store` | 静默丢弃（同桌面端 `custom-skills.ts:62-63`） |
| 跳过后无 `SKILL.md` | 整包失败 |

内容哈希算法不变（`[[path, content], …]` 排序后 sha256 前 16 位），只是允许的路径变多；**旧包哈希不变**，已安装技能不受影响。

### 4.2 运营端 ClawHub 打通（P1）

后端：
- `parse_skill_zip` 改用 `shared/skill_import` 的规范化，返回 `files + skipped`。
- `/verify` 仍调用，但只用作**完整性校验**（身份一致 + 保留文件的 sha256/size 与 verify 清单一致），不再看 `security.passed` / `ok`。verify 不可用时导入失败并说明原因（见待决策 #8）。
- 新增 `GET /api/operation/skill-market/external/{owner}/{slug}/preview`：返回详情、版本、文件清单、跳过项、安全结论（`/scan` 双扫描器并列）。不写库。
- `download` 响应附带 `skipped`、`security`；平台技能版本表已有 `security` jsonb，原样存。
- 浏览不再强制 `nonSuspiciousOnly=true`（见待决策 #5）。
- 错误：`AppError`（含 429）原样透出；ClawHub HTTP 404 → 404 「ClawHub 上找不到该技能」。
- 新增 `GET /api/operation/skill-market/external/resolve?url=`：贴 ClawHub 链接直接定位（无 owner 时返回候选，同桌面 §4）。

前端：
- 内部 / 外部分开加载，ClawHub 失败只影响外部 tab（带「重试」）。
- 搜索 400 ms 防抖；「加载更多」用 `next_cursor`。
- 「下载」改为「预览」→ 预览抽屉（文件 / 安全 / 跳过）→「导入」。安全结论显示规则同桌面 `CustomSkillImport.tsx` 的 `clawhub-security` 块，两个扫描器并列。
- 内部市场卡片显示导入时的安全结论徽标（如「扫描：可疑」）。
- `PlatformSkillSelector` 的「下载并选择」同样先预览。
- 支持贴 ClawHub 链接导入（输入框识别链接 → resolve）。

### 4.3 企业端自定义技能（P2）

后端（`manager_service/skill_import_service.py`，新）：

```
POST /api/manager/skills/import/preview      检查（不写库）
POST /api/manager/skills/import              安装（写 skill_catalog）
```

- 请求：`multipart/form-data`（`source=folder|zip|file` + 文件，文件夹以浏览器 `webkitdirectory` 上传、每个文件带相对路径）或 JSON（`source=text|url|clawhub` + `text`/`url`）；安装时带 `roots[]`（多技能包勾选）、`visibility` / `binding_policy` / `install_policy`。
- 响应与桌面端 `importCustomSkill` 同形：`preview` | `scan[]` | `clawhub{candidates, security, skipped}` | `results[]`；另加 `existing`（目录里已有同名：`same`（内容相同，已安装）/ `update`（内容不同，将升新版本））。
- `skill_id` = SKILL.md frontmatter `name`（规则同桌面 `custom-skills.ts:145-148`：小写字母数字连字符，≤64）；`version` = frontmatter `version`（合法段）否则 `hash[:12]`；同名已存在且内容不同 → 新版本（版本被占用则 `version-hash8`）。
- `config.source` ∈ `custom | url | clawhub`，附 `origin{kind,label,url}`、`skipped`、`security`（ClawHub）。
- 外网获取（`url` / `clawhub`）走 `shared/net_guard`（从 `mcp_probe.py` 抽出的 SSRF 防护 + 钉 IP + https + 不跟随跨主机重定向 + 20 s + 10 MiB）。GitHub 链接按桌面端规则走 codeload zip（`custom-skills.ts:559-585`）。
- 权限：owner / enterprise_admin；`BodyLimit` 12 MiB。
- 审计：`skill_catalog.imported`（actor、skill_id、version、source、文件数），不记内容。

前端（`web/manager/src/features/capability/`）：
- 技能目录区「添加技能」改为下拉：「导入技能」「手动编辑（高级）」。
- 「导入技能」对话框（Astryx `Dialog` > `Layout height="fill"`，header/content/footer 分开）：6 个来源 tab → 检查 → 预览 / 多技能勾选 / 同名候选（可点开 ClawHub 页面）/ 安全提示 / 跳过项 → 可见范围等 3 个策略 → 安装 → 结果分「成功 / 重复 / 失败」。
- 表格新增「来源」列（平台市场 / 自定义 / 网址 / ClawHub）。
- `CapabilityPage.tsx:409` 文案改为新上限与「可含脚本与资源，二进制跳过」。

### 4.4 企业端自建 MCP（P3）

数据：迁移 `0056_mcp_catalog_origin.sql`
```sql
ALTER TABLE mcp_catalog ADD COLUMN origin text NOT NULL DEFAULT 'platform'
  CHECK (origin IN ('platform','enterprise'));
```
企业条目 `server_id = 'ent-' || uuid`，`source_revision` 自增（从 1 起）。`(tenant_id, ref)` 唯一约束继续覆盖两类。

后端：
```
POST   /api/manager/mcp-market/probe              检查地址（鉴权方式 / 工具 / 是否支持动态注册）
POST   /api/manager/mcp-market/custom              新建企业 MCP
PUT    /api/manager/mcp-market/custom/{server_id}  修改（revision+1）
DELETE /api/manager/mcp-market/{server_id}         沿用（停用 / 删除）
```
- 输入模型复用 `PlatformMcpServerFields`（`shared/contracts/platform_mcp.py:149`），含可选 `oauth_client_id` / 只写 `oauth_client_secret`（Manager 密钥加密，规则同 `mcp_catalog.py:160-166`）。
- 探测：`operation_service/mcp_probe.py` 移到 `server/shared/mcp_probe.py`，运营端与企业端共用（运营端改 import）。
- `list_market`：`origin='enterprise'` 的条目单独成组，不再被标「平台已下架」（`mcp_catalog.py:148-156`）；`enable` 只处理平台条目。
- 成员侧：`InstallableMcpServer`（`shared/contracts/crosstier.py:220-236`）**新增 `origin: "platform" | "enterprise"`（默认 platform）**；`server_id` 字段说明改为「平台 MCP ID 或企业 MCP ID（`ent-` 前缀）」。

Agent：
- `manager-client.ts:337-357` 透传 `origin`；`connectors.ts:442` 按 `origin` 写 `source = enterprise_catalog | platform_catalog`（SQLite CHECK 已含 `enterprise_catalog`，`storage/sqlite.ts:696`，无需迁移）。
- 工具交集（`connectors.ts:580`）、重新登录取预登记应用（`connectors.ts:1041`）扩到 `enterprise_catalog`；自动安装资格（`connectors.ts:714`、`approval-service.ts:273/293`）**保持仅平台**（见待决策 #3）。
- 契约快照 `clients/desktop/docs/api.json` 同步；桌面来源文案对 MCP 的 `enterprise_catalog` 显示「企业」。

前端（`web/manager/src/features/mcp-market/`）：
- 页面分「平台 MCP」「企业自建」两组；「添加企业 MCP」对话框：粘贴配置或地址（`parseMcpConfig`）→「检查」（probe）→ 自动填鉴权方式 / 工具 / scopes → 名称、标识、说明、可选应用编号与密钥 → 保存。结构仿 `web/operation/.../McpServerDialog.tsx`。
- 企业自建条目可「编辑」「删除」。

### 4.4b 桌面端「从企业拿」MCP 列表（P3）

Agent（新北向路由，均需登录态，只读本成员可见条目）：
```
GET  /api/agent/capabilities/installable-mcp-servers
     → [{ server_id, ref, display_name, summary, url, tools, auth, origin, revision,
          state: "install" | "installed" | "update" | "conflict" }]
POST /api/agent/capabilities/mcp/catalog/:server_id/install
     { replace?: boolean, credential?: { token, header? } }
     → { capability } | { login }      // OAuth 返回待登录，登录完成即装好
```
- 列表经 Manager `GET /grants/mcp-servers` 读取，再与本机 `local_capability` 比对得出 `state`：未装 → `install`；同 `server_id` 且本地记录的目录修订号 = `revision` → `installed`；修订号更小 → `update`；本机已有同 `ref` 但来源不是该目录条目（如自己手加的）→ `conflict`（需确认替换）。
- 安装复用 `planInstall` 的目录分支（地址、工具、鉴权、预登记应用都以目录为准，不信任前端传值），`source = platform_catalog | enterprise_catalog`（按 `origin`），`sourceRef = server_id`。本机需记录目录修订号用于判断「有更新」——实现时核对 `local_capability` 现有字段能否承载（如 `version`），不能则加列。
- Manager 不可达 → 503，前端提示「暂时无法连接企业服务」，「自定义」tab 照常可用。
- 契约快照 `clients/desktop/docs/api.json` 同步。

桌面（`clients/desktop/src/pages/Capabilities/McpAuthDialogs.tsx` `AddMcpDialog`）：
- 顶部两个 tab：「从企业拿」（默认）/「自定义」（现有粘贴配置流程原样保留），与 `AddSkillDialog` 同构。
- 列表每行：名称、来源（平台 / 企业）、鉴权方式（无需登录 / 需要登录 / 需要令牌）、工具数、说明；按钮按状态：`安装` / `已安装` / `更新` / `替换`。
- 一键行为：无需登录 → 点一下即装好；需要登录 → 点一下后直接进入登录窗口（现有 `McpSignInPanel`），登录完成即装好；需要令牌 → 行内展开令牌输入框，填好点「安装」。
- 超过 6 条显示搜索框（同技能）；空列表提示「企业还没有开放 MCP，可联系管理员在 MCP 市场启用或添加」。
- 能力页 MCP 区的空状态文案同步提到「从企业拿」。

与 P3 其它部分的关系：平台启用的 MCP 现在就存在，本节不依赖企业自建 MCP 也能先交付；企业自建条目在 P3 完成后自动出现在同一列表。

### 4.4c P3 实施记录（2026-11-20）

与上文一致的部分不再重复，只记落地细节、偏差与实测中发现并修掉的问题。

落地细节：
- 迁移 `server/manager_service/migrations/0056_mcp_catalog_origin.sql:10` 另加约束 `chk_mcp_catalog_origin`：`origin='enterprise'` 必须配 `server_id LIKE 'ent-%'`，平台条目不得用该前缀。迁移可重复执行。
- 企业条目读写在 `server/manager_service/mcp_catalog.py:119`（`create_custom`）、`:136`（`update_custom`，修订号 +1、标识不可改；应用密钥可保留 / 替换 / 清除，改成非 OAuth 时自动清除）；列表分组用 `enterprise_entry`（`:298`）。审计动作 `mcp_catalog.custom_created / custom_updated / custom_deleted`。
- 顺带修复：`routes_mcp_market.py:45` 原先只读 `app.state._enterprise_audit_repository`，该属性从未赋值，MCP 市场审计（含已有的 OAuth 应用操作）一直静默丢弃；现回退到 `build_enterprise_audit_repository`。
- 登记时**不**对地址做外呼校验：地址由成员本机 Agent 连接，Manager 只在「读取工具」（probe）时外呼并走 `shared/net_guard`（待决策 #4）。
- 本机记录目录修订号用现有 `local_capability.version` 列（存字符串化的 `revision`），无需迁移。
- 列表与安装：`server/agent_service/src/connectors.ts:728`（`listCatalogMcps`）、`:749`（`installMcpFromCatalog`）；与「自定义」共用安装尾段 `installPlannedMcp`（`:666`）。
- 桌面：「从企业拿」面板 `clients/desktop/src/pages/Capabilities/CatalogMcpPanel.tsx`；企业端「企业自建」分组与对话框 `web/manager/src/features/mcp-market/{McpMarketPage,EnterpriseMcpDialog}.tsx`（对话框不能放 `@aiteam/shared`，`no-legacy-ui` 守卫禁止，故在 manager 内按运营端对话框改写）。

实测发现并已修复（均有回归测试）：
1. **目录声明的鉴权方式被探测结果覆盖**：`withMcpAuth` 原先无条件用探测结果替换鉴权方式。服务端同时支持令牌和 OAuth（如 GitHub MCP 同时接受 PAT 与 OAuth）时，管理员登记为「需要令牌」，成员填了令牌点安装却被带去 OAuth 注册登录，填的令牌被忽略。此问题在平台目录的模型安装路径上早已存在。现规则（`connectors.ts:484`）：目录条目声明了 `bearer` / `oauth` 时以目录为准，探测只补 OAuth 细节；声明为 `none` 的仍跟随探测（服务端确需鉴权时还能装）。测试：`mcp-auth.test.ts`「declared token auth wins over a probe that also finds OAuth」（撤掉修复时失败）。
2. **成员直接看到写给模型的话**：连接失败原因原为「请告诉用户联系企业管理员」「请让用户检查地址」，这些话本是给模型转述的，桌面「从企业拿」与「自定义」里由成员直接阅读。`connectForInstall` 增加 `forMember`（`connectors.ts:561`），桌面直装路径改为「请检查令牌后重试 / 请稍后再试，或联系企业管理员 / 请检查地址」；模型路径文字不变。
3. **装好后整张列表锁住数秒**：安装成功后等目录重新读取完才解除忙碌状态，企业目录慢时（实测运营端不可达时约 3 秒）行内一直显示「正在安装…」、其他行按钮不可点。现装好即把该行标为「已安装」，目录在后台刷新（`CatalogMcpPanel.tsx:71`）。

已接受的风险：旧版 Agent 不认识 `origin`，会把企业自建 MCP 当作平台条目（因而有自动安装资格）。按发布顺序先发 Agent 即可规避。

### 4.5 企业端模型帮装（P4）

```
POST /api/manager/capability-assist
{ requirement, link?, config_json?, model: { provider_id, model_id } }
→ { candidates: [{ kind: "skill"|"mcp", source: "clawhub"|"github"|"url"|"config",
                   title, summary, reason, url?, mcp_config?, security? }],
    notes, usage: { input_tokens, output_tokens, cost?, pricing_status } }
```

- 模型：管理员在对话框里从**本企业可见的平台模型**（`GET /api/manager/platform-models`）中选；`resolve_tenant_access` 取 Relay base_url / token / 协议。协议适配见待决策 #2。
- 工具（全部只读，服务端执行）：

| 工具 | 实现 |
|---|---|
| `search_clawhub(q)` | `/api/v1/search`（同 `custom-skills.ts:425`） |
| `search_github(q)` | `/search/repositories`（同 `custom-skills.ts:446`；匿名限速 10 次/分钟） |
| `inspect_link(url)` | §4.3 的预览逻辑（不写库）：技能返回名称 / 说明 / 文件数 / 安全；MCP 地址走 probe |
| `parse_mcp_config(json)` | 服务端同 `parseMcpConfig` 规则（丢弃令牌） |
| `propose(candidates)` | 结束循环，结构化输出 |

- 边界：最多 6 轮、12 次工具调用、总时限 90 s、单次模型输出 ≤ 4k tokens；超限返回已有结果并注明「未完成」。
- 系统提示词：只找能力、只返回候选、不得编造链接（候选链接必须来自工具结果，服务端校验：候选 URL 不在本次工具结果里的丢弃）。
- 不落库：需求原文、模型输出、工具结果都不写库、不进日志（日志只记 request_id、轮数、token 数、耗时）。
- 用量：每次调用写一条 `usage_rollup`：`summary_id = "manager-assist-<uuid>"`、`member_id = 企业 owner`、`employee_id = NULL`、`run_count = 1`、tokens、按冻结的平台价格算 `cost_total`（价格未知 → `pricing_status = unknown`、`cost_total = NULL`）；经 `upsert_usage_with_delivery` 同事务投递 Operator。另写企业审计 `capability_assist.invoked`（actor = 发起管理员、model、token 数）。
- 前端：MCP 市场页与技能目录区都有「让模型帮我找」入口 → 对话框（需求必填、链接 / JSON 可选、模型选择）→ 候选列表（来源、理由、安全）→ 点「用这个」打开 §4.3 导入对话框（预填 ClawHub / 网址）或 §4.4 MCP 对话框（预填配置），走正常检查 → 安装。

### 4.6 文档同步修订

- `docs/v1正式版本/技术设计/概要设计/04-数据架构与多租户隔离.md` §6.7：加一条「例外：Manager 管理员能力帮装可经本企业 Relay 令牌做有界模型调用；不落内容；用量计入企业 owner」。
- `00-架构总纲与裁决索引.md` D18 行同步。
- `server/manager_service/provider_credential_service.py:11`、`connector_probe.py` docstring 同步。
- 08-24 ClawHub 设计 spec 标注被本文 A/B/C 取代的条目。

---

## 5. 接口与契约变更汇总

| 变更 | 内容 | 影响面 | 风险 |
|---|---|---|---|
| `SkillFile.path` / Agent `canonicalPath` | 放宽路径规则 + 上限（§4.1） | shared / Operation / Manager / Agent / 桌面随包 Agent | **高** |
| `InstallableMcpServer.origin` | 新增可选字段 | Manager / Agent / `api.json` | 中 |
| Agent 北向（新） | `GET /api/agent/capabilities/installable-mcp-servers`、`POST /api/agent/capabilities/mcp/catalog/:server_id/install` | 桌面 / `api.json` | 中 |
| `mcp_catalog.origin` | 新列 + CHECK | Manager 库 | 中 |
| `local_capability.source` | 不变（复用已有 `enterprise_catalog`） | Agent | 低 |
| Operation 北向 | 新增 `external/{owner}/{slug}/preview`、`external/resolve`；`download` 响应加 `skipped`/`security` | web/operation | 中 |
| Manager 北向 | 新增 `skills/import/preview`、`skills/import`、`mcp-market/probe`、`mcp-market/custom`（POST/PUT）、`capability-assist` | web/manager | 中 |
| `usage_rollup` 新来源 | `summary_id` 前缀 `manager-assist-`、`employee_id NULL` | Manager 用量页 / Operator 汇总 | 中 |
| 概要设计 04 §6.7 / D18 | Manager 可调模型（限定用途） | 架构口径 | **高** |

**发布顺序（硬性）**：① shared 契约 + Agent 验签放宽，随包 Agent 重打并发版 → ② Manager（接受宽包、成员可装列表改上限、企业导入）→ ③ Operation（导入宽包）。若先发 Operation / Manager 导入宽包，**未升级的 Agent 会验签失败，成员装不上**（不影响已装技能）。

---

## 6. 风险

| 风险 | 处置 |
|---|---|
| 技能带脚本后，模型可能让员工运行 | 脚本以 0600 落盘、不加执行位；员工跑命令仍走现有审批策略；桌面文案更新（待决策 #6） |
| 旧 Agent 拒收宽包 | 严格按发布顺序；成员侧错误提示「请升级客户端」 |
| 旧 Agent 不认识 MCP 的 `origin`（P3） | 会把企业自建 MCP 当平台条目、有自动安装资格；严格按发布顺序先发 Agent |
| Manager 外呼 SSRF | 共用 `shared/net_guard`（拒私网 / 回环 / 链路本地 / 元数据地址，钉 IP，不跨主机重定向） |
| ClawHub / GitHub 限速 | 运营端 10 分钟缓存（已有）+ 前端防抖；企业端帮装受 GitHub 匿名 10 次/分钟限制，失败时候选里注明 |
| 模型编造链接 | 服务端只保留出现在本次工具结果里的 URL |
| 帮装费用不可见 | 用量计入 owner、企业用量页可见（新来源标「管理工具」） |
| 大包撑爆请求 | Manager 导入 `BodyLimit` 12 MiB；Operation zip 上限 10 MiB |
| 成员同步变重（P0 实施中发现） | `authorized-config` 每次同步都把成员所有专家的技能包**全量**带上（`server/manager_service/authorized_config_service.py:188-222`，不看 `known_versions`），Agent 端请求超时 10 s（`server/agent_service/src/manager-client.ts:13`）。上限从 1 MiB 升到 10 MiB 后，大技能会拖慢每次同步。实测 ClawHub 技能多为几十 KB，短期可接受；根治见待决策 #9 |

---

## 7. 阶段与验收

| 阶段 | 内容 | 依赖 | 验收（可测试） |
|---|---|---|---|
| P0 契约放宽 | §4.1：shared 契约、Agent 验签、Manager 上限常量与 `package_shaped` SQL、`shared/skill_import` 规范化 | — | Python/Node 同一组用例互验（含 `scripts/x.sh`、`assets/a.json`、`hooks/openclaw/h.js` 跳过、二进制跳过、`.env` 拒绝、257 文件拒绝）；旧包哈希不变；跨端签名—验签闭环测试通过 |
| P1 运营端打通 | §4.2 | P0 | 假 ClawHub 跑通「预览 → 导入 → 开放 → 模板引用 → Manager 安装 → 成员可装列表 → Agent 验签缓存」；真实 ClawHub 对 §2.1 的 15 个样本复测，除 verify 不可用的外全部可导入；ClawHub 断网时内部市场仍可用；截图（长列表 + 1440×640） |
| P2 企业端导入技能 | §4.3 | P0 | 6 种来源各一条集成用例；多技能包勾选；同名升版本；SSRF 负例（`https://127.0.0.1`、`169.254.169.254`、跳转到内网）；跨租户隔离；成员 Agent 能装上导入的技能；对话框截图 + 点得到主按钮 |
| P3 企业自建 MCP + 桌面企业 MCP 列表 | §4.4、§4.4b | 可与 P2 并行（§4.4b 可先于 §4.4 交付） | 企业 MCP 新建 / 编辑 / 删除；成员可装列表含 `origin=enterprise`；Agent 落 `enterprise_catalog` 并能登录（动态注册与预登记各一条）；桌面「从企业拿」三种鉴权各一键装通（无需登录直接装好、OAuth 登录后装好、令牌填后装好）、`installed`/`update`/`conflict` 状态正确、Manager 断开时提示且「自定义」可用；平台条目行为不回归；截图（长列表 + 1440×640，主按钮真实可点） |
| P4 模型帮装 | §4.5 + §4.6 | P2、P3 | 用假 Relay（脚本化工具调用）测：轮数 / 时限上限、编造链接被丢弃、用量行 `member_id = owner`、审计不含内容；真实平台模型冒烟一次；截图 |
| 验证收尾 | 全量测试、随包 Agent 重打、三端截图 | P1–P4 | 测试结果、截图清单；未验证项如实列出 |

---

## 8. 不能保证的事

- ClawHub 是第三方未签名内容；显示扫描结论 ≠ 内容安全。
- 二进制资源（图片等）不分发；依赖它们的技能可能不完整。
- 技能附带脚本只是文本；能否在成员机器上运行取决于本机环境（python / node / 依赖），不保证。
- 模型帮装给的是**建议**，可能不相关或不可用；受 ClawHub / GitHub 可用性与限速影响；需管理员逐条确认。
- 未升级客户端的成员装不了新格式技能。
- 「一键使用」只对无需登录的 MCP 是真正一次点击；需要登录的还要在浏览器里完成登录，需要令牌的要先填服务方发的令牌。

## 9. 待决策

| # | 事项 | 建议 | 卡住谁 |
|---|---|---|---|
| 1 | 企业有多个 owner 时，模型帮装用量记给谁 | 记给「最早创建且在职的 owner」；审计里另记实际发起的管理员 | P4 |
| 2 | 模型帮装支持哪些协议 | 三种都支持（`openai-completions` / `openai-responses` / `anthropic-messages`，各写一个小适配，统一成同一工具循环），模型选择器不必过滤 | P4 |
| 3 | 企业自建 MCP 能否进「自动安装授权」 | 不能，与桌面现有口径一致（「只对平台目录来源生效；企业自建技能与手动地址的 MCP 仍每次询问」，`clients/desktop/src/pages/Capabilities/index.tsx:185`） | P3 |
| 4 | Manager 对 MCP 地址做探测外呼 | 视为已决定 C 的延伸（同为管理员自定义导入），同样走 `net_guard` | P3 |
| 5 | 运营端 ClawHub 浏览是否继续强制 `nonSuspiciousOnly` | 不强制，与「显示但不拦」一致；列表不逐条拉扫描（避免 20 倍请求），扫描结论在预览里看 | P1 |
| 6 | 桌面端「技能只包含说明文档，不执行代码」两处文案 | 改为「技能可能附带脚本和资料；不会自动执行，员工运行命令仍按审批策略」 | P0 |
| 7 | 企业导入的版本号规则 | frontmatter `version` 合法则用，否则内容哈希前 12 位；同名内容变化在预览里明确提示「将升级为新版本」 | P2 |
| 8 | 运营端 verify 不可用 / 清单不一致时 | 拒绝导入并说明原因（这是完整性校验，不是安全拦截） | P1 |
| 9 | （P0 实施中新增）成员同步全量带技能包 | 先不改，本次只记风险；若要根治，另开一项：同步只带成员本机没有的版本（需改 Manager↔Agent 同步契约与清理语义，属共享口径变更） | 无（不卡当前阶段） |

**建议最先拍板**：#6（P0 就要改文案）、#2 与 #1（决定 P4 适配工作量与用量归属）。
