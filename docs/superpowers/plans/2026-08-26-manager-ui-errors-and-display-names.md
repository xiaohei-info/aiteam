# Manager 页面错误与显示名称收敛计划

## 目标与边界
- 移除 Manager「平台模型」独立页面、导航和可访问路由；保留专家配置内部读取 Operator 模型目录所需的受控 API，不在 Manager 暴露平台模型管理页面。
- 修复人才市场、连接器、设置页当前真实 500：Operator 旧目录空模型引用、连接器路由顺序冲突、设置 JSONB 入参未序列化。
- 全局审查 Manager 用户可见文本，资源展示使用名称/显示名称，不把 UUID/内部 ID 作为列表、表格、卡片内容；技术路由参数、React key、测试标识不属于展示面。

## 涉及模块
- 后端：`server/operation_service/catalog_service.py`、`server/manager_service/app.py`、`server/manager_service/settings_repository.py` 及对应路由/仓储测试。
- Manager 前端：`App.tsx`、`shell/config.ts`、授权、方案、知识库、治理、概览、账单、专家、能力目录及其他命名映射相关页面/测试。
- E2E/单测：新增真实路由冲突、旧目录数据、JSONB 设置、授权名称与页面不显示内部 ID 的回归断言。

## 关键约束与非目标
- 不删除 Manager 专家配置内部所需的模型目录读取契约；只删除独立平台模型页面/导航/路由。
- 不改跨端所有权、不把会话内容上传控制面、不绕 TenantContext/RLS。
- 不用前端放宽断言掩盖后端 500；先修真实根因。
- ID 只保留在请求、路由、键、测试属性和确有必要的创建输入；用户可见资源名称优先，缺失名称显示有界的「未命名/已删除对象」，不回退 UUID。

## 实施顺序
1. 复现并修复三类 500，补后端回归测试：路由顺序、JSONB 序列化、Operator 已发布旧模板缺失模型引用的 fail-closed 列表处理。
2. 删除 Manager 平台模型独立页面/导航/路由，清理只属于该页面的测试与文案；保留内部模型目录 hook。
3. 修复成员级授权资源名称映射，并把方案实例/应用历史、知识绑定、治理/概览/账单、能力目录、专家/部门/方案等用户可见 ID 回退改为名称或有界占位。
4. 增加/更新页面单测与路由测试，运行 Manager 全量测试、TypeScript、构建及 focused E2E/API smoke。
5. 部署到 taiyi，逐页验证 marketplace/connectors/settings/grants 与 Manager health/OpenAPI；确认工作树和提交状态。

## 完成标准
- 三个页面 API 不再返回意外 500，页面显示正常数据/明确空态或业务错误。
- Manager 侧栏和路由不再出现平台模型页面；专家配置仍能读取受控模型目录。
- 成员授权及全局审计范围内用户可见资源均显示名称，不显示 UUID/内部 ID。
- Python focused/full non-integration、Manager 前端测试/typecheck/build、真实 taiyi API/UI smoke 有可复现结果。
