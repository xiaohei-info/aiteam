# B06 B08 Governance Closeout Design

## 目标

基于当前 `master` 真实代码，只补 `B06` 行业方案 Apply 策略语义和 `B08` 管理邀请正式命名空间这两个尚未闭环的点，不重做已经完成的 `B04/B05/B07/B09` 能力。

## 范围

- `B08`
  - 新增正式北向路径：
    - `GET /api/enterprise-admin/invites`
    - `POST /api/enterprise-admin/invites`
    - `DELETE /api/enterprise-admin/invites/{invite_id}`
  - 前端企业设置页主路径切到 `/api/enterprise-admin/invites`
  - 保留 `/api/team/settings/admin-invites` 兼容别名
- `B06`
  - `POST /api/team/solutions/{id}/apply` 的 `append|replace|reapply` 改成真实语义
  - 保持原子事务和幂等行为
  - 前端行业方案页继续复用现有三种模式按钮和确认预览

## 非目标

- 不扩成真实支付 provider
- 不重构现有 billing、connectors、memories 页面
- 不改动 system-admin 方案 CRUD 范围

## 设计

### B08 管理邀请

现有邀请创建/撤销逻辑已经在 `app/team_panel/api_team/router_team_settings_billing.py` 中可用，缺的只是正式北向挂载和独立列表接口。最小实现是：

1. 在 `router_team_settings_billing.py` 增加 `handle_get_admin_invites`。
2. 在 `router_enterprise_admin.py` 直接复用已有 invite 处理函数挂正式路径。
3. `admin-settings.js` 改为主调用 `/api/enterprise-admin/invites`，`GET /api/team/settings` 仍保留聚合 `admin_invites` 字段。
4. `/api/team/settings/admin-invites` 继续保留，保证旧调用和已有数据结构不破。

### B06 行业方案 Apply

当前 `replace/reapply` 被偷偷折算成 `append`，这会让前端展示的三种模式变成假语义。最小可验证收口如下：

1. `append`
   - 保持现状，新增一批 `solution_apply` 员工和知识库绑定。
2. `replace`
   - 在同一事务内找出该企业下由当前 `solution_id` 历史创建的员工，先逻辑归档并清理其知识库绑定，再创建新一批员工。
   - 返回结果中增加 `replaced_employee_ids`，便于验收证明“覆盖重建”不是假按钮。
3. `reapply`
   - 不归档旧员工，只新增一批员工，但返回 `reapplied_from_employee_ids`，明确这是基于历史应用再次生成。

为避免误伤别的来源员工，需要通过 `solution_apply_record` 中的 `created_employee_ids_json` 反查当前 `solution_id` 历史生成对象，而不是按模板全局扫描。

## 验证

- Layer0/Layer2：
  - enterprise-admin invites 的 GET/POST/DELETE 路由与兼容别名
  - solution apply 三种模式的真实效果与幂等
- Layer4：
  - `admin-settings.js` 使用 `/api/enterprise-admin/invites`
  - `admin-solutions.js` 仍保留三种模式和确认预览
- Layer5：
  - `replace` 确认旧员工被归档
  - `reapply` 确认旧员工保留且新增员工落地
