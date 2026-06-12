# 实施计划：数字员工落地 Hermes Profile + 企业级 LLM Provider 配置

## 目标

1. **企业后台可配置 LLM provider + model 列表**（DB 为真相），创建员工时从中选 model。
2. **创建员工即完整装配**：建独立 Hermes profile，写 SOUL（用户描述/模板人设），把选定 provider/model 物化进该 profile 的 config.yaml，seed 技能/知识/记忆绑定并写穿 profile。
3. 全程数据入库，详情接口可完整展示。

## 核心设计决策（已定）

- **真相方向**：DB 是 provider/model 配置的唯一真相；`config.yaml` 是**单向物化产物**（DB → config.yaml）。不做双向同步，避免两份真相冲突（Never break userspace / 消除特殊情况）。
- **provider 凭证**：`api_key` 存 DB（本功能用户明确要求 DB 为真相）。
- **员工 model 落地**：provision 时写入该员工 profile 的 `config.yaml` 顶层 `model` 段（default/provider），使执行时 profile 自带正确默认模型；同时保留 employee 表 model 字段作运行时传参（双保险，与现状兼容）。
- **边界**：新增能力落 `app/team-panel`（北向+service+repo）与 `app/agent-gateway`（profile 物化），前端只调 Team Panel；不改 Hermes 核心。

## 分阶段实施（每阶段独立可验证）

### 阶段 1：数据层 — provider/model 配置表
- 新建 `app/team_panel/migrations/008_enterprise_llm_provider.sql`：
  - `enterprise_llm_provider`(id, enterprise_id, provider_key, display_name, base_url, api_key, transport, enabled, created_at...)
  - `enterprise_llm_model`(id, enterprise_id, provider_id, model_id, label, context_length, enabled, is_default, created_at...)
- 实体 `entities.py`：`EnterpriseLlmProvider` / `EnterpriseLlmModel`
- repo：`enterprise_llm_provider_repo.py`（CRUD + list_by_enterprise）
- UoW 挂接
- **验证**：psql 应用 migration；repo 单测 CRUD round-trip。

### 阶段 2：Gateway — config.yaml 物化能力
- `profile_provisioner.py` 新增：
  - `materialize_root_providers(providers, models)`：把 DB provider/model 写入 root `config.yaml` 的 `providers:` 段（YAML 安全读改写，保留其他字段）。
  - `set_profile_model(profile_dir, provider_key, model_id)`：写 profile config.yaml 顶层 `model` 段。
- **验证**：单测 — 给定 provider 列表写 config.yaml，重读断言结构正确、不丢失既有字段。

### 阶段 3：北向 API — provider 配置 + 可用 model 列表
- `router_team.py` 路由分发区（~4567）挂接：
  - `GET/POST /api/team/llm-providers`、`PATCH/DELETE /api/team/llm-providers/{id}`
  - `POST /api/team/llm-providers/{id}/models`、`DELETE .../models/{mid}`
  - `GET /api/team/llm-models`（聚合 enabled model 供创建员工下拉）
- service：`llm_provider_service.py`（写 DB + 调阶段2物化 root config）
- **验证**：curl 创建 provider→加 model→GET 列表；确认 root config.yaml 出现该 provider。

### 阶段 4：创建即装配 — 复活 seed + provision
- 改 `_handle_recruitments_post`（router_team.py:1855）与 `_handle_solution_apply_post`：
  - 复用/内联 `recruit_employee` 的 seed（model/prompt/skill/KB/memory binding，用新 binding 格式辅助函数）
  - body 接收可选 `model_provider`/`model_name`（来自前端下拉），校验存在于该企业 enabled model；缺省回退模板 default_model
  - 建 Employee 后调 `_provision_profile`（ensure_profile + 写 SOUL）+ 阶段2 `set_profile_model`
  - 建 RuntimeBinding；保留现有 RecruitmentOrder + Conversation
  - skill 写穿、memory sync 复用现有 `_fire_*`
- **验证**：curl 招募一个带模板的员工→检查 .hermes/profiles/<name>/ 存在、SOUL.md 有内容、config.yaml model 段正确、DB binding 齐全。

### 阶段 5：详情接口补缺
- `_handle_employee_detail`：回填 `template_ref.name`、`conversation_bindings`；model 段补 provider/model 与契约路径对齐（保持向后兼容，新增不删旧）。
- **验证**：curl 详情，断言字段非空。

### 阶段 6：前端
- 新增 `admin-llm-providers.js`（仿 admin-connectors 列表+表单），page-shell 挂 4 处（导航/图标/pathToModule/handler）、api-client 加方法。
- 招募前端（app-marketplace.js / app-template-detail.js）加 model 下拉（拉 `/api/team/llm-models`），recruit payload 带 model。
- 员工详情 drawer 的 model input 改 select（数据源同上）。
- **验证**：页面渲染 + 招募走通 + 详情展示。

### 阶段 7：回归 + E2E 复核
- 跑 layer1-3 + 受影响 layer4 测试。
- 重启服务，真实招募一个员工，私聊执行确认 profile 生效（SOUL+model 真的被用）。
- 复核 5 个原演示场景未被破坏。

## 风险与约束
- profile_name 必须 ASCII slug（已有 `_slug_fragment`）。
- `ensure_profile` 不可传 `--home`（已踩坑）。
- migration 无 tracking 表，需手工确认应用（MEMORY 记录）。
- YAML 改写必须保留既有字段，不可整段覆盖（避免丢 provider 凭证）。
- MVP 单企业（enterprises[0]），provider 配置按 enterprise_id 存但当前只有一个。

## 完成标准
创建员工 → 自动建独立 profile + SOUL 填用户描述 + config.yaml 写入所选 model；企业后台能配 provider/model；员工详情完整展示；招募时可选 model；原 5 场景回归通过。
