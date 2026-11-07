# 运营端「模型配置」tab 实施计划（2026-11-07）

## 目标

运营端「大模型服务」页拆成两个 tab：

- **模型配置**：直接管理 LLM 网关（内部 NewAPI）上的全部上游渠道，并编辑每个模型的运行能力。
- **价格**：保留现有的价格维护与发布。

参考 CC Switch（一个上游 = 名称 + 协议 + 地址 + Key + 模型）与 pi `models.json`（contextWindow / maxTokens / reasoning / thinkingLevelMap / input）。

## 用户已确认的口径

| 问题 | 结论 |
|---|---|
| 上游 URL / Key 放哪 | 写进网关渠道；Key 只写不读，不进运营端数据库，不下发 Manager/Agent（04 §6.7 / D18） |
| 管理哪些渠道 | 网关上的全部渠道 |
| 模型列表来源 | 所有启用渠道的模型并集（不再写死 1 号渠道） |
| 删除渠道 | 允许，二次确认 |
| 思考强度 | 每个模型配置支持的档位 + 每档发给上游的值 |
| 请求头 / 兼容参数 | 放在网关渠道层（`header_override` / `param_override`），不改 Manager/Agent 契约 |
| 第一版附加项 | 测试连接、上游模型名映射、图片输入开关、自定义请求头/参数覆盖 |

## 非目标

- 不改 Manager / Agent / 快照契约；pi `compat` / `headers` 不下发。
- 不新增运营端数据库表或迁移。
- 不读取网关上已保存的 Key（NewAPI 的 Key 查看接口需要 2FA，本功能不用）。

## 后端（`server/operation_service/`）

1. `newapi_client.py`：渠道 `list_channels`（分页）、`get_channel`、`create_channel`（新建接口不返回 id，按唯一名称回查）、`update_channel`（Key 留空=保留）、`delete_channel`、`set_channel_status`、`test_channel`、`fetch_channel_upstream_models`（已保存渠道 GET / 未保存 POST 预览）。
2. `platform_provider_service.py`：
   - 模型发现改为所有启用渠道 `models` 的并集。
   - 渠道 CRUD 编排：校验地址（http/https，无 userinfo/query/fragment）、JSON 对象字段校验、敏感请求头值回显为掩码，保存时掩码值沿用原值；写操作后重新同步模型。
   - `update_model_capabilities`：写 context_window / max_tokens / reasoning / thinking_mode / thinking_levels / thinking_level_map / input；写入后自动同步不再覆盖（现有 `update_model_metadata` 只补缺失 thinking 字段）。
3. 路由（`/api/operation/providers/{provider_id}/...`，system_admin / system_operator）：
   - `GET|POST channels`、`PUT|DELETE channels/{channel_id}`、`POST channels/{channel_id}/status`、`POST channels/{channel_id}/test`、`POST channels/fetch-models`
   - `PUT models/{model_id}/capabilities`
4. 错误：网关失败统一 409 `Conflict`，消息经 `_redact_error_detail`，不带 Key。

## 前端（`web/operation/src/features/providers/`）

- `PlatformProvidersPage` 加 `TabList`：模型配置 / 价格（现有内容原样搬入价格 tab）。
- 模型配置 tab：渠道卡片列表（名称、协议、地址、模型数、状态、优先级、上次测试耗时）+ 新增/编辑弹窗 + 测试连接 + 启停 + 删除（AlertDialog）；下方模型能力列表 + 编辑弹窗。
- 界面文案只说「LLM 网关」，不出现 NewAPI。

## 验证

- pytest：client 请求形状（MockTransport）、service 并集发现/掩码合并/校验、路由权限与无 Key 回显。
- vitest：tab 切换、渠道表单提交 body（Key 留空不发送）、删除需确认、能力表单提交。
- `tsc -b`、`vite build`、契约检查（如适用）、运营端全量 pytest。
- 真实网关联调需要用户同意（本机无 docker；测试服务器部署需授权）。
