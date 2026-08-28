# Operator 专家模型修复与发布错误计划

## 目标
- 修复缺少 `platform_model_ref` 的专家下架后再次发布时返回 generic 500；改为明确、可操作的业务错误。
- Operator 专家详情编辑页支持从当前已发布 Provider/模型/价格目录重新选择模型，并保存完整引用，使历史专家可修复后重新发布。
- 增加服务层/前端回归验证，覆盖 null 模型引用、发布错误和编辑模型提交。

## 边界
- 不降低 Manager/Agent 的可执行专家契约：发布成功的专家必须绑定已发布 Provider、模型和价格版本。
- 不复制 API key 或运行时凭据到 Operator；只保存 provider/model/version 引用。
- 复用现有 `usePlatformProvidersApi` 和 Operator 发布模型目录，不新增中转层。

## 顺序
1. 服务层把无效模型引用转换为 4xx `ValidationProblem`/明确错误码，禁止 Pydantic ValidationError 泄漏为 500。
2. 详情编辑页加载已发布、有价格模型，显示模型选择器；保存时提交 `platform_model_ref`。
3. 补服务层、路由和前端组件测试；运行 Operation 全量测试、typecheck/build。
4. 部署 taiyi，验证系统测试员详情编辑/发布和 Manager 人才市场可见性。
