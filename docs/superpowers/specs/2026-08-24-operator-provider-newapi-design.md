# Operator 统一 Provider / 模型 / 价格与内部 NewAPI Relay 设计

> 日期：2026-08-24
> 状态：用户已批准，作为实现口径
> 影响裁决：修订 D18；扩展 F03/F06/F10/F11/F13
> 红线：不得把上游或 NewAPI 管理密钥下发 Manager/Agent；Agent 只获得 tenant 级可撤销受限 Relay Token。

## 1. 目标

1. 内部 NewAPI 作为 AI Team 整体部署组件，与 PostgreSQL、LightRAG/Hindsight 同级，由平台管理。
2. AI Team 只对接部署内置的单一内部 NewAPI；Operator 服务启动后自动确保该内置 Provider 投影存在并刷新可用模型。
3. 新上游服务/渠道只在 NewAPI 管理面配置；Agent 只调用内部 NewAPI，Operator 页面不再提供 Provider 创建流程。
4. Manager 招募专家时继承模板固定的 Provider/模型并直接可用，无需再创建 Provider 或补模型。
5. Manager 可切换员工模型，但只能从 Operator 对该 tenant 发布的模型目录选择，不能自由输入 Provider/model/price。
6. Agent 从 Manager 获取同一模型、价格和 tenant 受限令牌；每次 Run 冻结版本并在本地计算 cost。计费始终按 AI Team 请求的快照模型和价格计算，忽略 Relay/上游响应中的实际模型名，不做二次映射或校正。
7. usage 自动完成 Agent→Manager→Operator 脱敏汇总闭环。

## 2. 非目标

- v1 不支持 Manager BYOK 或自建 Provider。
- 不向 Manager 前端、Agent 前端、专家模板或普通目录 API 返回任何密钥。
- 不让 Agent 直连 Operator；Agent 仍只主动访问 Manager。
- 不上传会话、prompt、工具输入输出或逐 token 明细到控制面。
- 不把 NewAPI 管理 UI 暴露为普通企业管理员入口。

## 3. D18 修订

旧 D18（Manager 持 Provider 凭据）替换为：

- Operator 持内置 NewAPI Provider 投影、模型目录、版本化价格、Relay 管理凭据和 tenant access 真相；Provider 本身不由用户创建。
- 内部 NewAPI 持真实上游 channel key；新渠道只在 NewAPI 管理面配置/轮换，不向下游分发。
- Manager 只持平台目录的 tenant 只读投影、employee 的平台模型选择，以及加密的 tenant 受限 Relay Token 投影；不创建 Provider、不编辑价格。
- Agent 只持授权后的只读执行快照和 tenant 受限 Relay Token，本地最小注入；不持上游 key 或管理 token。
- `RunSpec.provider_ref` 引用平台 Provider；每个 Run 冻结 `provider_version/model_version/pricing_version`。

## 4. 数据所有权

### 4.1 Operator

- `platform_provider`：固定内置 NewAPI Provider code/name、内部 Relay endpoint、API protocol、状态、版本、加密 NewAPI 管理凭据引用；旧 channel 映射字段仅作数据兼容保留。
- `platform_model`：provider 下已发现/已发布模型、能力、来源、状态、版本。
- `platform_model_rate`：按模型和生效时间版本化价格；Decimal 字符串或整数 micro-USD，禁止 float。
- `platform_provider_tenant_access`：tenant 对 provider 的 NewAPI token 引用、允许模型、配额、状态、版本；token 加密保存。
- `expert_template.platform_model_ref`：模板固定 provider/model，不固定金额。

### 4.2 Manager

- 删除 Provider/模型目录真相职责；旧 `provider_credential`、`llm_provider/llm_model` 不再参与新流程。
- employee 保存 `platform_provider_id/model_id` 当前选择和配置版本。
- 保存 Operator 发布目录的只读 projection（或请求时读穿 + 有界缓存），只允许从该目录选择。
- 保存 tenant access 的加密投影，仅 runtime-config 受保护通道可解密返回。
- 招募时解析当前有效 `pricing_version`；不允许编辑价格。

### 4.3 Agent

- 冻结 `EmployeeExecutionSnapshot`：provider/model/pricing 三版本 + Decimal rate card。
- runtime-config 只返回内部 Relay URL、tenant 受限 token、模型和版本。
- 本地按实际 input/output/cache token × 冻结 rate 计算费用。
- summary 带 `pricing_version`；未知价格显式 `pricing_status=unknown`，不得伪装为 0。

## 5. 内部 NewAPI

### 5.1 部署

- 官方镜像固定版本，不使用 `latest`。
- 独立 PostgreSQL 数据库和 Redis；仅 NewAPI 服务端口按部署需要暴露，DB/Redis 不暴露公网。
- `SESSION_SECRET`、`CRYPTO_SECRET`、DB/Redis 密码来自 `.env.*`，不得提交真实值。
- 健康检查使用 `/api/status`。
- test server 默认仅绑定 `127.0.0.1` 管理入口；Agent 推理入口如需公网，由受控端口/TLS 代理开放。

### 5.2 上游渠道

- 内部 NewAPI channel 指向现有 `https://newapi.xiaohei.tech/v1`。
- 上游 key 由 NewAPI 管理面写入；不落 AI Team 普通业务表明文、不进入日志。
- Operation 通过 NewAPI 管理面的模型目录发现可用模型；新渠道/模型由 NewAPI 管理面配置后自动进入目录，首次应发现 `minimax-m3`。

### 5.3 Tenant Token

- 每 tenant/provider 创建独立 token，模型白名单限定为 Operator 对该 tenant 发布模型。
- token 可撤销、轮换、限额；禁止复用一个全平台推理 token。
- Operator 调用 NewAPI token 管理 API；Manager 只取得当前 tenant 的 token 投影。

## 6. 价格规则

1. Operator 自动抓取公开定价/Provider 定价接口，结果先作为候选；v1 默认公开源为可配置的 `MODEL_PRICING_URL`（默认 `https://models.dev/api.json`）。
2. 人工覆盖优先于自动价格；自动刷新不得覆盖人工值。
3. 价格来源顺序：`manual > provider > public_reference > unknown`。
4. token 模型统一为 `input/output/cache_read/cache_write USD per 1M tokens`；按次模型为 `request_usd`。
5. 价格变更生成新 version/effective_from，不改历史。
6. 模板只固定模型；Manager 招募和 Agent Run 各自解析/冻结当时有效价格版本。
7. 跨端 `cost_total` 统一 USD Decimal（至少 6 位小数）；UI 未引入汇率前统一 `$`，禁止把 USD 标 `¥` 或重复除以 100。

## 7. 跨端流程

### 7.1 Operator 配置

1. Operation 启动后首次访问时自动确保内置 NewAPI Provider 投影，并从 NewAPI 模型目录刷新模型。
2. Operator 页面默认展示内部 NewAPI 和可用模型；新上游渠道在 NewAPI 管理面配置。
3. 同步公开价格或人工维护，发布模型/价格版本。
4. 注册专家模板时从已发布模型选择。

### 7.2 Manager 招募

1. 拉取模板固定版本及 `platform_model_ref`。
2. 校验 model 仍发布且 tenant 可见。
3. 幂等解析/签发 tenant NewAPI token；失败则招募失败，不创建待配置 draft。
4. 创建 employee，直接写 provider/model，生命周期满足其他条件时 active。
5. Manager 切换模型只接受 Operator 目录中的引用；保存后 employee version 自增。

### 7.3 Agent 执行

1. Agent sync 拉授权 employee 投影。
2. Run 前拉执行快照，冻结 provider/model/pricing versions。
3. runtime-config 返回内部 NewAPI URL + tenant token；Agent 最小注入 Pi。
4. 本地计算 usage/cost；计费只使用请求快照中的模型/价格，不读取或处理上游 responseModel；异步 flush；Manager 聚合后使用服务身份上报 Operator。

## 8. API 原则

- Manager 前端只调用 Manager；Operation/Manager 前端均只调用本端服务。
- Manager→Operator 使用 `shared.service_client + X-Service-Token`。
- 目录 API 永不含 secret；tenant runtime access 使用独立受保护服务接口与 `Cache-Control: no-store`。
- 写调用带 Idempotency-Key；模型/价格资源带 version/updated_at。
- Provider/model 下架不篡改已开始 Run；新快照 fail closed，已冻结离线 Run 按明确 TTL 继续。

## 9. 验收标准

1. taiyi 内部 NewAPI、Redis、DB 健康；管理端不公网暴露，推理入口可控。
2. 内部 NewAPI 渠道使用当前外部 Provider，`/v1/models` 至少返回 `minimax-m3`，真实 completion 成功。
3. Operator 可查看内部 NewAPI 模型、同步/人工改价并发布 model，模板 UI 只能选择已发布模型；不提供 Provider 创建。
4. 全新 tenant 招募模板后 employee 直接带 model/provider，不出现“待 Manager 配置”。
5. Manager 编辑员工模型时无法提交 Operator 未发布 model。
6. Agent 通过内部 NewAPI tenant token 完成真实对话；全局/管理 key 不出现在 Manager/Agent API、日志、前端或快照。
7. Agent 本地 token 和 cost 非零（有价格时），自动上报后 Manager/Operator 均显示相同聚合值与 pricing version。
8. 服务重启、价格更新、token 轮换、Manager 临时离线和模型下架的边界测试通过。
