# ClawHub API 清单与接入设计

日期：2026-11-19
来源：`https://clawhub.ai/api/v1/openapi.json`（OpenAPI 3.1.0，标题 `ClawHub API 1.0.0`，server `https://clawhub.ai`）
说明：以下端点与参数均来自该 spec，并已对关键端点做实测。

---

## 1. 端点全表

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/skills` | 技能列表（可排序、游标分页） |
| POST | `/api/v1/skills` | 发布技能版本（multipart，需登录） |
| GET | `/api/v1/skills/{slug}` | 单个技能元信息 |
| DELETE | `/api/v1/skills/{slug}` | 软删除（需登录） |
| POST | `/api/v1/skills/{slug}/undelete` | 恢复（需登录） |
| GET | `/api/v1/skills/{slug}/versions` | 版本列表 |
| GET | `/api/v1/skills/{slug}/versions/{version}` | 版本详情（**含完整文件清单**） |
| GET | `/api/v1/skills/{slug}/file` | 单个原始文件 |
| GET | `/api/v1/skills/{slug}/scan` | 安全扫描详情 |
| GET | `/api/v1/skills/{slug}/moderation` | 审核详情 |
| GET | `/api/v1/search` | **搜索技能** |
| GET | `/api/v1/download` | **直接下载技能 ZIP** |
| GET | `/api/v1/resolve` | 按 hash 解析版本 |
| GET | `/api/v1/whoami` | 当前用户（**需 token，匿名 401**） |
| GET | `/api/v1/packages` / `packages/search` / `packages/{name}` / `.../download` / `.../file` / `.../versions` / `.../readiness` / `.../security` | 统一包目录（插件/模板等） |
| GET | `/api/v1/plugins` / `plugins/search` / `code-plugins` / `bundle-plugins` | 插件目录 |
| GET | `/api/v1/sdk-usage` / `sdk-usage/coverage` / `sdk-usage/plugin` | SDK 引用统计 |
| GET | `/api/v1/feeds/templates`（另有 `/v1/feeds/templates`） | 官方模板 feed（实验性） |

---

## 2. 与「技能导入」直接相关的端点

### 2.1 下载整包（最重要）

```
GET /api/v1/download?slug={slug}&ownerHandle={handle}[&version={ver}]
```

- 返回 `application/zip`，**一个 ZIP 就是完整技能包**（含 `SKILL.md`、`assets/`、`references/`、`hooks/`…）。
- 实测：`/api/v1/download?slug=self-improving-agent&ownerHandle=pskoett` → HTTP 200，66,340 B，17 个条目。
- **没有整包端点时才有必要逐文件拉**（`versions/{ver}` 拿清单 + `file?path=` 逐个取）。有了它，接入只需一次下载 + 走现有 zip 导入链路。

### 2.2 定位技能（URL → slug + ownerHandle）

```
GET /api/v1/skills/{slug}?ownerHandle={handle}
```

- 返回 `skill{slug,displayName,summary,tags,stats{downloads,installs,stars,versions,comments},createdAt,updatedAt}` + `latestVersion{version,license,changelog}` + `owner{handle,displayName,userId,image}`。
- **必须带 `ownerHandle`**：同 slug 多作者时返回 **409 `AMBIGUOUS_SKILL_SLUG`**，并在 `matches[]` 里给出候选（含 `ref="@owner/slug"` 与页面 URL）。

### 2.3 搜索

```
GET /api/v1/search?q={query}&limit={n}&highlightedOnly={bool}&nonSuspiciousOnly={bool}
```

- 返回 `{results:[…]}`；实测 `q=spreadsheet` 返回真实命中（含 owner handle、summary）。
- `nonSuspiciousOnly=true` 可过滤掉被标可疑的技能。

### 2.4 列表与排序

```
GET /api/v1/skills?limit=&cursor=&sort=&nonSuspiciousOnly=
```

`sort` 枚举（spec 原文）：

| 值 | 含义 |
|---|---|
| `recommended` | **推荐排序**（见 §3） |
| `default` | 默认 |
| `updated` / `createdAt` / `newest` | 时间 |
| `downloads` / `installs` | 热度 |
| `stars` / `rating` | 评价 |
| `trending` | 趋势 |

返回 `{items:[…], nextCursor}`。

### 2.5 安全扫描

```
GET /api/v1/skills/{slug}/scan?ownerHandle={handle}[&version=]
```

- 返回 `security.status`（clean / suspicious …）、`hasWarnings`、`scanners.{skillspector,llm}`。
- 实测该技能：`skillspector` = `suspicious / severity CRITICAL / recommendation DO_NOT_INSTALL / issueCount 18`，而 `llm` = `clean / benign / high confidence`。
- **两个扫描器结论会冲突**，UI 不能只显示一个词。

### 2.6 逐文件（备用）

```
GET /api/v1/skills/{slug}/versions/{ver}?ownerHandle={handle}   → version.files[{path,size,sha256,contentType}]
GET /api/v1/skills/{slug}/file?path={path}&ownerHandle={handle} → 原始内容
```

---

## 3. 「能不能搜索 / AI 推荐」——直接回答

| 能力 | 结论 |
|---|---|
| **搜索** | ✅ 有。`/api/v1/search?q=`，另有 `nonSuspiciousOnly`、`highlightedOnly`、`limit`。 |
| **列表/排行榜** | ✅ 有。`/api/v1/skills?sort=`，支持 `downloads`/`stars`/`trending`/`rating` 等 10 种排序。 |
| **推荐** | ⚠️ **只有一个 `sort=recommended` 排序值**，没有独立的「推荐」端点，也没有「根据我的项目/历史推荐」的接口。实测未登录（匿名）也返回结果，说明它是**全局推荐**、非个性化。 |
| **AI 推荐** | ❌ 没有。spec 里没有任何 `ai`/`recommend`/`suggest` 语义的端点（`/api/v1/ai/*` 全 404）。 |
| **自然语言找技能** | ❌ 没有。搜索是关键词匹配，不是语义/AI 检索。 |
| **个性化** | ❌ 做不到。`/api/v1/whoami` 需要 token，匿名 401；没有登录态就没有「按我的使用推荐」。 |
| **安全结论** | ✅ 有，`/scan`，但见 §2.5 的双扫描器冲突。 |

**结论**：ClawHub 提供**搜索 + 榜单 + 一个全局 recommended 排序**，**不提供 AI 推荐、语义检索或个性化推荐**。要做「AI 推荐」得我们自己在其搜索之上加一层（那是另一个话题，且需要模型调用）。

---

## 4. 本期接入设计（只做 ClawHub）

### 4.1 目标

桌面端「添加技能 → 自定义 → 网址」输入 ClawHub 页面地址（`https://clawhub.ai/{owner}/skills/{slug}`），
能预览并安装该技能；来源标记为 ClawHub。

### 4.2 URL 识别

新增一类来源（不复用 `url` 的 GitHub 分支）：

```
https://clawhub.ai/{owner}/skills/{slug}
```

→ `{ ownerHandle: owner, slug }`

**必须同时解析出 owner 和 slug**：只有 slug 时 ClawHub 返回 409 `AMBIGUOUS_SKILL_SLUG`。
若用户贴的是不带 owner 的地址（`https://clawhub.ai/skills/{slug}`），先调 `GET /api/v1/skills/{slug}` 拿 409 的 `matches[]`，
若唯一则直接用，多个则提示用户选（或要求带 owner 的地址）。

### 4.3 下载链路

```
GET /api/v1/download?slug={slug}&ownerHandle={owner}   → application/zip
  → unzipEntries(zip)  →  现有 normalizeSkillAtRoot / scanSkillRoots 链路
```

即：**复用现有 zip 导入链路**，只是把「下载」这一步换成 ClawHub 的 `/download`。

### 4.4 元信息用于预览

- `GET /api/v1/skills/{slug}?ownerHandle={owner}` 拿 `displayName` / `summary` / `latestVersion.version` / `owner.displayName`。
- 预览显示：`displayName`（+ `slug`）、`summary`、版本、作者、来源「ClawHub」。
- 安全：装之前显示 `security.status` / `skillspector.recommendation`，两个扫描器结论冲突时如实并列（如「ClawHub 扫描：可疑 / 不建议安装；模型复核：无异常」）。

### 4.5 文件过滤

ClawHub 的包可能含 OpenClaw 专用文件（`hooks/openclaw/handler.js`、`scripts/extract-skill.sh`）。
这些对 Pi 无意义。**建议保留 `SKILL.md` 与 `assets/` `references/`，跳过 `hooks/` `scripts/`**，
并在预览里说明「已跳过 N 个平台专用文件」。

> 待你确认：是否跳过 `hooks/`、`scripts/`；`CHANGELOG.md`、`skill-card.md` 这类要不要保留。

### 4.6 边界与安全

- 只允许 `https://clawhub.ai`（精确主机名，不用正则宽松匹配）。
- 复用现有 `download` 的大小/超时上限（10 MiB / 20 s）与 zip 解压上限（条目数、解压大小）。
- 下载的是**第三方未签名内容**，与现有自定义技能同属「成员自己导入、本机生效、不上传」范畴；
  但来源是可被他人发布的市场，需在 UI 明确「来自 ClawHub，未经企业签名」。

### 4.7 不做（本期外）

- 不做 ClawHub 搜索 UI（能搜到但本期只接「贴链接导入」）。
- 不做 AI 推荐（平台没有该能力，见 §3）。
- 不做发布/登录（`POST /api/v1/skills`、`whoami` 需 token，与「本机导入」无关）。
- 不修 GitHub 单文件 `raw.githubusercontent.com` 链路（你说本期只做 ClawHub）。

---

## 5. 需要你拍板

1. **ClawHub 包里的平台专用文件**：按 §4.5 跳过 `hooks/`、`scripts/` 可以吗？`CHANGELOG.md` / `skill-card.md` 保留还是跳过？
2. **安全提示**：装之前是否强制显示 ClawHub 的扫描结论（含「可疑 / 不建议安装」）？还是只记录、不拦？
3. **来源标识**：能力页来源显示「ClawHub」就够，还是要带作者和版本（如 `ClawHub · pskoett · 4.0.5`）？
4. **不带 owner 的链接**：直接要求用户贴带 owner 的完整地址，还是允许我们调 API 消歧（可能弹多候选）？
