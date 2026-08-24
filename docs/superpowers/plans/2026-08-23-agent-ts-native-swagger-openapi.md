# Agent TypeScript 原生 OpenAPI/Swagger 集成计划

## 目标

将 Agent Service 从手写 `OPENAPI` 常量和自定义文档 HTML 改为 TypeScript HTTP 框架原生路由注册与 OpenAPI 生成，达到 Manager/FastAPI 类似的使用体验：

- 路由、请求 schema、响应 schema 与运行时路由同源；
- `/openapi.json` 由服务启动时根据路由注册自动生成；
- `/docs` 使用本地打包的 Swagger UI；
- `/redoc` 使用本地/固定版本 ReDoc；
- 不再手工维护大段 OpenAPI JSON，也不做独立文档转换脚本。

## 技术选型

采用 Fastify + `@fastify/swagger` + `@fastify/swagger-ui`，请求/响应边界使用现有 TypeBox schema。Fastify 是 Node/TypeScript 生产级 HTTP 框架，支持 SSE/raw response hijack、route schema 和原生 OpenAPI generation。

## 边界与非目标

- 不改变 Agent API 路径、认证、错误模型、SSE payload、Pi Session、SQLite 或业务所有权。
- 不把 SSE 事件内容伪装成 REST schema；在 OpenAPI 中明确标注 event-stream 响应和 Pi event envelope。
- 不保留第二套运行时路由作为生产路径；旧 custom matcher 只在迁移过程中暂存，完成后删除。
- 不依赖 unpkg/jsdelivr 运行时加载 Swagger/ReDoc 资源；使用固定 npm 包/静态资源。

## 实施步骤

1. **依赖与 Fastify 装配**
   - 添加固定版本 `fastify`、`@fastify/swagger`、`@fastify/swagger-ui`（必要时 `@fastify/static`）。
   - 建立 Fastify 实例、request-id、统一 `HttpProblem` error handler、auth pre-handler、SPA fallback 和 shutdown 生命周期。

2. **路由迁移**
   - 将健康、认证、平台投影、conversation、files、prompt、events 等现有路径注册为 Fastify routes。
   - 继续复用现有业务 handler/service，raw response 路径使用 `reply.hijack()`；SSE、下载和 JSON envelope 行为保持不变。
   - 用 TypeBox 定义当前 body/query/params/response schema，并由 Fastify route schema 生成 OpenAPI；不复制旧 `OPENAPI` 对象。

3. **文档与静态资源**
   - `@fastify/swagger` 生成 `/openapi.json`。
   - `@fastify/swagger-ui` 提供 `/docs`；ReDoc 由固定本地资源或固定包入口提供 `/redoc`。
   - 生产无外网时 `/docs` 仍可打开。

4. **删除旧文档/路由重复实现**
   - 删除手写 `OPENAPI` 常量、Swagger/ReDoc CDN HTML、custom route matcher 及重复的文档测试。
   - 保留必要的 API contract tests，确保 OpenAPI paths 与实际 route registration 同步。

5. **验证**
   - Agent TypeScript check、全量 Node tests。
   - 验证 `/openapi.json` paths/methods/schema、`/docs`/`/redoc` 200 和页面资源为本地依赖。
   - SSE、下载、认证、SPA fallback、prompt/entries 回归测试。
   - 三端 web build 和 taiyi Agent health/smoke。

## 完成标准

- Agent OpenAPI 中不再存在手写完整 `OPENAPI` 常量。
- 新增 Fastify route/schema 后，重启服务即可自动出现在 OpenAPI/Swagger UI；不需要额外转换步骤。
- `/docs` 在断网环境也可加载 Swagger UI shell。
- 既有 Agent API、SSE、认证和前端 smoke 不回归。
