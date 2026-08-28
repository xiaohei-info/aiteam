# Operator Provider / 内部 NewAPI / 三端计费闭环实施计划

> 设计：`docs/superpowers/specs/2026-08-24-operator-provider-newapi-design.md`
> 原则：串行里程碑、单写者；每个里程碑测试与独立复核后再进入下一步。

## 目标与边界

- 完成批准设计的生产形态，不保留 Manager 与 Operator 两套 Provider 真相。
- 先部署/验证内部 NewAPI，再接 Operator，再贯穿 Manager/Agent。
- 不修改冻结 `app/` 与外部 Hermes 核心；不上传会话内容；不泄露任何管理/上游密钥。

## M0：规格和基线

涉及：
- v1 概要设计 `00/04/05/06/11`
- 本规格与计划

步骤：
1. 修订 D18、数据所有权表、F03/F06/F10/F11/F13。
2. 记录当前基线：后端/三前端测试、构建、taiyi 健康与 usage 数据。

完成标准：文档没有“Manager Provider 真相”残留冲突；现有基线可重复。

## M1：内部 NewAPI 部署与真实上游

涉及：
- `deploy/docker/docker-compose.yml`
- `.env.*.example` / `deploy/docker/README.md`
- `scripts/ctl.sh`（仅在需要把 newapi 作为正式组件启停时）
- 部署 SOP

步骤：
1. 增加固定版本 NewAPI、专用 PostgreSQL、Redis、持久卷与健康检查。
2. 所有 secret 仅环境变量注入；DB/Redis 仅容器网络；管理端默认 loopback。
3. taiyi 初始化 root 管理身份。
4. 用现有外部 `newapi.xiaohei.tech/v1` endpoint/key 创建内部 NewAPI channel。
5. 发现模型、创建模型受限测试 token，验证 `minimax-m3` completion。

完成标准：容器重启后数据保留；真实模型可用；管理/上游 key 不在日志或仓库。

## M2：Operator Provider / 模型 / 价格真相

涉及：
- `server/operation_service/migrations/`
- 新 Provider repository/service/routes/schemas/NewAPI client
- `server/shared/contracts/`
- `web/operation/`

步骤：
1. 新建 platform_provider/platform_model/platform_model_rate/tenant_access 表和仓储。
2. Provider secret 加密；所有读取 schema 剥离明文/密文。
3. 实现 NewAPI channel/model/pricing/token 管理客户端，超时、SSRF/响应限制、no-store、脱敏日志。
4. 实现 Operator 管理 API 与 Manager 服务拉取 API（服务身份）。
5. 实现 Provider 页面：创建/编辑、同步模型、价格候选、人工覆盖、发布/下架。
6. 金额使用 Decimal 字符串，价格版本不可变。

测试：schema extra=forbid、角色/服务鉴权、秘密不回显、发现差异、人工覆盖优先、幂等 tenant token、RDB 持久化。

## M3：专家模板绑定平台模型

涉及：
- Operation catalog schema/service/repository/migration
- shared ExpertTemplateDetail
- Operation 注册/详情 UI

步骤：
1. 用 PlatformModelRef 替代自由文本 default_model 作为新真相。
2. 注册/编辑表单只显示已发布 Provider→model；展示有效价格来源。
3. 发布前校验模型/Provider 可用。
4. 跨端模板详情携带固定 provider/model 版本，不携带 secret。

测试：无模型不可发布；下架模型不可新选；旧自由文本不进入新招募链。

## M4：Manager 只读目录、招募继承与模型切换

涉及：
- Operator catalog client / RecruitService
- Manager employee schema/repository/migrations
- Manager provider/model UI
- runtime-config service

步骤：
1. 新建 Operator 平台模型目录 client 和有界只读 cache/projection。
2. 招募前解析模板引用并幂等取得 tenant access；任一步失败均不创建 draft employee。
3. employee 保存平台 provider/model 引用；招募完成直接可激活。
4. Manager Provider 页面改只读平台目录；移除新流程中的 Provider CRUD。
5. 员工模型选择器仅接受平台发布模型；后端再次验证，禁止手写绕过。
6. runtime-config 从 tenant access 投影返回内部 NewAPI URL/token，no-store。

测试：正常招募即 runnable、未发布/不可见/无 access 均 fail closed、跨 tenant/RLS、模型切换版本递增、旧 Provider CRUD 不再是运行真相。

## M5：Agent 价格快照与本地计费

涉及：
- shared snapshot/grant/summary contracts
- Manager SnapshotService
- Agent manager-client/model-runtime/usage/store/UI

步骤：
1. 快照增加 provider/model/pricing versions 和 Decimal rate card。
2. Agent 本地冻结并校验版本；runtime 只获得 tenant token。
3. 按 input/output/cache token 本地精确计费；未知价格显式 unknown。
4. cost_total 保留至少 6 位 USD，不再按分舍入；三端 UI 统一 `$`。
5. usage summary 带 pricing_version/status。

测试：金额公式、微额不归零、价格更新不改历史 Run、未知价格、缓存 token、秘密不进入快照公开面。

## M6：usage 自动闭环

步骤：
1. SessionHost 记录 summary 后异步 best-effort flush；失败保留 outbox，不阻塞 prompt/定时任务。
2. Manager ingest 后用服务身份异步/幂等上报 Operator。
3. Operator rollup 写入口接受服务身份，读入口仍要求平台角色。
4. Manager 持久化 F01 enterprise_id 映射用于上报。

测试：Agent→Manager→Operator 非零一致；离线失败/重试/并发 claim/幂等；不含内容字段。

## M7：全量验证、复核、部署

自动验证：
- server focused + full pytest
- Agent Node focused + full tests
- Operation/Manager/Agent frontend full tests and builds
- OpenAPI/schema/compile/diff check
- Docker compose config + health + restart persistence

独立复核：
- correctness/data ownership
- secret/SSRF/multi-tenant security
- pricing precision/version semantics
- deployment/rollback
- UI workflow

真实 taiyi E2E：
1. Operator 内部 NewAPI Provider 同步并发布 `minimax-m3` + 人工价格。
2. Operator 创建绑定该模型的专家模板。
3. taiyi1 Manager 招募后直接 active/runnable，模型选择列表受限。
4. Agent sync 后真实 prompt 通过内部 NewAPI完成。
5. 验证 Agent summary、Manager billing、Operation board token/cost 一致。
6. 验证日志/API/前端不含 NewAPI root token、上游 key。

交付：备份路径、部署 commit、回滚命令、残余风险和后续运维说明。
