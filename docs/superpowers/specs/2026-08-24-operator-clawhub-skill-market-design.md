# Operator ClawHub 技能市场与三端分发设计

日期：2026-08-24
状态：用户确认，进入实施

## 目标

- Operator 通过后端接入 ClawHub 公共技能目录，提供外部市场卡片、搜索、详情、下载和更新状态。
- 外部技能必须下载为 Operator 内部不可变版本后才能被专家模板引用。
- Operator 创建专家时可从内部市场或 ClawHub 外部市场选择技能；选择外部技能会先导入内部市场。
- Manager 只浏览 Operator 已开放的内部技能市场，不直接访问 ClawHub；安装后写入本 tenant `skill_catalog`。
- Manager 招募专家时自动安装模板固定引用的技能，之后可从企业已安装技能中追加配置。
- Agent 保持现有 Manager Ed25519 签名技能包、验签、本地缓存和执行链路。

## 已确认裁决

1. v1 只支持纯文本技能：`SKILL.md` 与 `references/*.md`；含脚本、模板或其他文件的 ClawHub 技能标记为不兼容，不导入。
2. Operator 提供“下载后自动开放”开关，默认开启。关闭时下载为 `draft`，需人工开放；安全校验与文本文件限制不可关闭。
3. 固定版本，不静默升级。ClawHub 更新产生新的 Operator 内部版本；已发布模板、Manager 已安装技能和 Agent 快照不自动变化。
4. 前端不跨端直调：Operation Web 只调 Operation Service；Manager Web 只调 Manager Service；Manager Service 经 `shared.service_client` 主动拉 Operator。

## 所有权与流向

```text
ClawHub
  -> Operator clawhub client
  -> Operator platform_skill/platform_skill_version（平台分发真相）
  -> Manager service_client pull
  -> Manager tenant skill_catalog（企业安装真相）
  -> Manager signed skill package
  -> Agent local SkillCache（执行投影）
```

Operator 不写 Manager 库；Manager 不直连 ClawHub；Agent 不访问 Operator/ClawHub。

## ClawHub 接口

- `GET /api/v1/skills`：游标浏览。
- `GET /api/v1/search`：搜索，强制 `nonSuspiciousOnly=true`。
- `GET /api/v1/skills/{slug}?ownerHandle=...`：详情。
- `GET /api/v1/skills/{slug}/verify?ownerHandle=...&version=...`：固定版本安全判断；只允许 `ok=true`、`decision=pass`、`security.passed=true`。
- `GET /api/v1/download?slug=...&ownerHandle=...&version=...`：固定版本 ZIP。

缓存公共读结果 10 分钟；尊重 `429` 与 `Retry-After`。

## Operator 数据

### platform_skill

- `id` UUID
- `source` (`clawhub`)
- `external_owner`
- `external_slug`
- `display_name`
- `summary`
- `latest_internal_version`
- `latest_external_version`
- `status` (`draft|published|unpublished|blocked`)
- `created_at/updated_at`
- unique `(source, external_owner, external_slug)`

### platform_skill_version

- `id` UUID
- `skill_id` FK
- `version`
- `content_hash`
- `files` JSONB（仅 `SKILL.md`、`references/*.md`）
- `security` JSONB
- `source_url`
- `created_at`
- unique `(skill_id, version)`

### platform_skill_setting

- singleton `auto_publish_downloads boolean default true`

## 结构化引用

专家模板保存固定引用，不保存浮动 ClawHub URL：

```json
{
  "skill_refs": [
    {
      "skill_id": "<operator platform_skill UUID>",
      "version": "1.2.3",
      "content_hash": "<sha256-prefix>"
    }
  ]
}
```

共享契约新增 `PlatformSkillRef`。旧 `skill_ids` 只作兼容读，新的注册/编辑 UI 不再写入。

## Operator API

平台用户：

- `GET /api/operation/skill-market/external`
- `GET /api/operation/skill-market/external/{owner}/{slug}`
- `POST /api/operation/skill-market/external/{owner}/{slug}/download`
- `GET /api/operation/skill-market/internal`
- `GET /api/operation/skill-market/internal/{skill_id}`
- `POST /api/operation/skill-market/internal/{skill_id}/publish`
- `POST /api/operation/skill-market/internal/{skill_id}/unpublish`
- `GET /api/operation/skill-market/settings`
- `PUT /api/operation/skill-market/settings`

Manager 服务身份：

- `GET /api/operation/skill-market/pull/skills`
- `GET /api/operation/skill-market/pull/skills/{skill_id}/versions/{version}`

服务间列表只返回 `published` 技能；包响应使用已有 `SkillPackage`。

## Manager API/行为

- `GET /api/manager/skill-market`：经 Operator client 列平台已开放技能，并合并本 tenant 安装状态。
- `POST /api/manager/skill-market/{skill_id}/install`：拉固定版本包并 upsert 到本 tenant `skill_catalog`。
- 招募时解析 `PlatformSkillRef`，幂等安装固定版本/hash，再写 `employee.skills`。
- 专家编辑页从 `GET /api/manager/skills` 多选，保存到 `EmployeeConfig.skills`。

## UI

### Operator 技能市场

- 内部市场/ClawHub 两个 Tab。
- 卡片：名称、作者、摘要、版本、下载量、状态；操作：详情、下载/已下载/可更新。
- 设置开关：下载后自动开放，默认开。

### Operator 创建专家

- 基础字段：名称、分类、头像可选、系统提示词、默认模型、岗位描述。
- 删除标签、预置记忆、排序与手工 skill ID。
- 技能区域：内部市场/ClawHub 两个 Tab；外部选择先下载，再将内部固定引用加入表单。

### Manager

- 技能管理页：平台市场/企业已安装。
- 已招募专家配置：企业已安装技能多选；为空时引导先安装。

## 安全

- ClawHub 为不可信输入；安全开关不能绕过 verify。
- ZIP 拒绝绝对路径、`..`、反斜线、符号链接、重复路径。
- 最大压缩包 2 MiB、最大解压文本 1 MiB、最多 64 文件、单文件 256 KiB。
- 仅 UTF-8 `SKILL.md`、`references/*.md`，必须存在 `SKILL.md`。
- 用现有 `SkillPackage` 计算/验证内容 hash。
- 不运行下载内容，不安装依赖，不执行脚本。
- 错误体不返回技能完整内容。

## 实施顺序与验证

1. Operation 迁移、ClawHub client、ZIP validator、内部仓储/服务/路由及单测。
2. 共享 `PlatformSkillRef` 与专家模板 schema/service 兼容。
3. Operation 技能市场页与专家双 Tab，前端测试/构建。
4. Manager Operator client、安装服务/路由、招募自动安装及租户隔离测试。
5. Manager 平台市场与专家技能多选，前端测试/构建。
6. 跨端 E2E：ClawHub fake -> Operator 导入 -> 模板 -> Manager 招募 -> skill_catalog -> authorized config -> Agent 验签缓存。
7. 太乙备份、部署、健康与真实 API 验收。
