---
created: 2026-06-15
updated: 2026-06-18
status: frozen-baseline
canonical: true
part_of: v1 概要设计（拆分集）
tags: [project, aiteam, technical-design, api, openapi, contract]
---

# AI Team v1 概要设计 · 02 北向 API 与接口契约规范

> **本篇定位**：所有写 HTTP API 的 Agent 的契约基准——北向路径收口、API 文档/格式规范（schema first、统一 envelope、分页/幂等/版本）、以及**统一错误模型（problem+json）的单一事实源**。
> **对应落点**：三端各自 `*_service/`、跨系统契约、`server/shared`（错误模型/service_client 解码）。
> **配套阅读**：[00 总纲](00-架构总纲与裁决索引.md)、仓库根 `CLAUDE.md`/`AGENTS.md`（通用工程约束：技术选型/横切关注点）、[05 通信架构](05-通信架构与跨端契约.md)（跨端契约面）。
> 本篇为 v1 地基级裁决口径，与其它篇冲突时以 [00 §20 裁决表](00-架构总纲与裁决索引.md) 为最终仲裁。

---

## 10. 北向 API 与路径收口

### 10.1 路径裁决（D2）

采纳生产统一命名，**弃用旧 `/api/team/*`、`/api/system/*`、`/api/enterprise/*`，不留 alias、不做兼容**。每端在**自己的 origin** 下暴露自己的前缀（不再有中心 Edge 统一 origin）：

| 端 origin | 新前缀 | 取代 |
|---|---|---|
| 运营端 | `/api/operation/*`、`/api/auth/*`（系统账号 + 负责人凭据/重置） | 旧 `/api/system/*` |
| 企业端 | `/api/manager/*`、`/api/auth/*`（成员认证 + 负责人本地登录） | 旧 `/api/enterprise/*` + `/api/team/*` 配置态 |
| 用户端 | `/api/agent/*`、`/api/auth/*`（本地登录/登出） | 旧 `/api/team/*` 执行态 |

达成**三处同名对齐**：后端模块 `agent_service` ↔ 前端 `web/agent/` ↔ 接口 `/api/agent/*`，三端同构。`/api/auth/*` 语义沿用，但按端实现各自的认证职责（[03 §9](03-认证与身份设计.md)）。

### 10.2 API 规范

- 各端服务用 FastAPI `APIRouter` 按业务模块拆分，Pydantic schema 作 API 边界，自动产出 OpenAPI / Swagger UI / ReDoc。
- **每端各自发布自己的 OpenAPI 文档入口**（不做跨端聚合——三端不在同一 origin、且互不信任彼此内部接口）。跨系统服务调用与 Agent 主动访问接口单独成一份"跨端契约"文档。
- 统一错误模型（见 §11.2），统一 numeric cursor 分页，禁止对外暴露 `{timestamp}-{sequence}` 内部游标。

### 10.3 API 文档与接口格式规范（地基裁决）

后端接口不是"实现完再补文档"。v1 三端所有 HTTP API 必须由 schema 驱动并自动产出现代化 API 文档，文档本身进入验收口径：

1. **文档入口固定**：每端服务必须提供 `/openapi.json`、`/docs`（Swagger UI）、`/redoc`（ReDoc）三类入口；`/docs` 与 `/redoc` 是否在生产公网公开由部署配置控制，但 `/openapi.json` 必须能在 CI 与受控运维环境中获取。
2. **OpenAPI 按端发布**：Operation、Manager、Agent 各自发布本端 OpenAPI，不做中心聚合；跨系统契约（Operator↔Manager、Agent→Manager）必须从对应服务的 Pydantic schema 生成或校验，单独导出为 `openapi.cross-system.json` / 契约文档，不能只靠自然语言表格。
3. **schema first**：所有 public endpoint 必须声明 request model、response model、错误响应、鉴权需求、tags、summary 与 operation_id；禁止裸 `dict` / `Any` 作为对外响应边界，内部临时结构必须先收敛为 Pydantic schema。
4. **成功响应统一 envelope**：
   - 单对象：`{ "data": <object>, "meta": { ... }? }`
   - 列表：`{ "data": [ ... ], "page": { "next_cursor": "...", "has_more": true }, "meta": { ... }? }`
   - 空成功：`204 No Content`，或在需要 request trace 时返回 `{ "data": null, "meta": { ... }? }`，不得每个接口自造 `{ ok: true }` / `{ success: true }`。
5. **入参规范**：path 参数只放资源身份，query 参数只放过滤/分页/排序，复杂写入放 JSON body；时间统一 ISO 8601 UTC；ID 统一 UUID 字符串；枚举统一 snake_case；金额、成本、token 用整数最小单位或 decimal string，禁止 float；写接口需要幂等时统一 `Idempotency-Key` header。
6. **出参规范**：字段命名统一 snake_case；nullable 与 optional 必须在 schema 中明确；对外只返回业务必要字段，禁止返回 password hash、provider key、内部 RLS 字段、runtime raw payload、未脱敏内容；版本化资源必须返回 `version` / `etag` / `updated_at` 中至少一种可用于增量同步或并发控制的字段。
7. **分页与排序**：统一 numeric cursor / opaque cursor 语义，对外字段为 `next_cursor` 与 `has_more`；禁止暴露内部 `{timestamp}-{sequence}` 游标；排序字段必须白名单化，默认排序在 OpenAPI description 中声明。
8. **HTTP 语义**：认证失败 401，鉴权失败 403，资源不存在 404，冲突 409，幂等重放按原结果返回，入参校验失败 422，限流 429；所有错误使用 §11.2 的统一 problem+json 模型。
9. **OpenAPI 质量门禁**：CI 必须能生成三端 OpenAPI 与跨系统契约，执行 schema 校验、operation_id 唯一性校验、无裸 `Any`/空 schema 检查、错误响应覆盖检查；接口变更必须能产出 OpenAPI diff，破坏性变更需要显式评审。
10. **版本策略**：v1 首版路径不加 `/v1` 前缀，版本归 OpenAPI 文档版本与资源 schema version 管理；若未来出现外部第三方稳定 API，再单独引入 `/api/public/v1/*`，不污染三端内部产品 API。

---

## 11.2 统一错误模型（单一事实源）

所有端服务返回 `application/problem+json` 风格错误，结构统一为：

```json
{
  "type": "https://docs.aiteam.local/problems/validation_error",
  "title": "Validation error",
  "status": 422,
  "code": "validation_error",
  "detail": "Request body is invalid.",
  "instance": "/api/manager/employees",
  "request_id": "req_...",
  "errors": [
    { "loc": ["body", "display_name"], "message": "Field required", "type": "missing" }
  ]
}
```

- `type/title/status/code/detail/instance/request_id` 为标准字段；`errors` 用于字段级校验错误；`meta` 可用于非敏感诊断信息。
- `message` 不再作为顶层标准字段，避免与 RFC 7807 的 `detail` 并行；前端统一展示 `detail`，调试看 `request_id`。
- 各端入口中间件、FastAPI exception handler 与共享 `service_client` 统一生成/解码该结构，不让各端自定义错误形态。
- 错误响应不得包含密码、token、provider key、会话内容、runtime raw event、工具输入输出明细等敏感信息；详细堆栈只进入受控日志。
