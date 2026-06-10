# P05-P06 Closeout Audit

## 目标

基于主分支真实代码核对 `docs/实施计划/验收规格包/2026-06-06-AI-Team-P05-P06-对话与协作验收规格.md` 的完成情况，只对仍存在的真实缺口做最小修复。

## 真实代码结论

### P05

- `P05-F01`：已覆盖
  - 证据：私聊页已有历史区、引用上下文、员工摘要和分页入口。
  - 代码：`app/static/aiteam/pages/app-chat.js`
  - 测试：`app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py`、`app/tests/aiteam/layer5_flows/test_private_chat_flow.py`

- `P05-F02`：已覆盖
  - 证据：run 创建、timeline 事件消费、streaming/waiting_human/resolved/reconnecting 状态已接入。
  - 代码：`app/static/aiteam/pages/app-chat.js`
  - 测试：`app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py`、`app/tests/aiteam/layer2_team_panel/test_view_services.py`

- `P05-F03`：已覆盖
  - 证据：附件上传、引用块、tool_call 卡片渲染已接入。
  - 代码：`app/static/aiteam/pages/app-chat.js`
  - 测试：`app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py`

- `P05-F04`：已覆盖
  - 证据：retry / abort / reconnect 路径已接入 Team Panel run 路由。
  - 代码：`app/static/aiteam/pages/app-chat.js`
  - 测试：`app/tests/aiteam/layer5_flows/test_private_chat_flow.py`、`app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py`

### P06

- `P06-F01`：已覆盖
  - 证据：新建群聊、成员栏、群设置、2x2 群头像、成员增删、解散群聊已接入。
  - 代码：`app/static/aiteam/pages/app-group.js`、`app/team_panel/api_team/router_team.py`
  - 测试：`app/tests/aiteam/layer4_frontend_bff/test_group_page_rendering.py`、`app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py`

- `P06-F02`：本次补齐真实缺口
  - 旧问题：单条群消息走协作路径时，`candidate_employee_ids` 未限制上限，可能超过 PRD 中“最多 3 个员工回复”的约束。
  - 修复：在 `conversation_service` 中将实际协作候选成员列表限制为最多 3 人，并确保 planner 优先保留。
  - 说明：`target_employee_ids` 继续保持“路由命中的目标成员”语义，不被错误收缩；真正收口的是“实际协作候选/回复成员”列表。

- `P06-F03`：已覆盖
  - 证据：任务树、父子任务层级、task timeline、result_merged 已接入。
  - 代码：`app/static/aiteam/pages/app-group.js`
  - 测试：`app/tests/aiteam/layer5_flows/test_orchestration_task_tree_flow.py`、`app/tests/aiteam/layer4_frontend_bff/test_group_page_reconnect_recovery.py`

- `P06-F04`：已覆盖
  - 证据：cursor-based reconnect / catch-up 已接入，前端有恢复状态提示。
  - 代码：`app/static/aiteam/pages/app-group.js`
  - 测试：`app/tests/aiteam/layer4_frontend_bff/test_group_page_reconnect_recovery.py`

## 本次代码改动

- `app/team_panel/application/commands/conversation_service.py`
  - 对群聊协作路径下的 `candidate_employee_ids` 做 3 人上限裁决
  - 保持 planner 优先

- `app/tests/aiteam/layer2_team_panel/test_conversation_and_run_commands.py`
  - 新增 Layer2 用例，锁定协作候选成员上限

- `app/tests/aiteam/layer5_flows/test_group_conversation_flow.py`
  - 新增 Layer5 flow 用例，锁定北向 API 返回与 detail 视图中的协作候选成员上限

## 验证

- `pytest app/tests/aiteam/layer2_team_panel/test_conversation_and_run_commands.py -k 'group_message_mentions_drive_orchestration or caps_candidate_replies_at_three or group_message_sets_route_mode' -q`
- `pytest app/tests/aiteam/layer5_flows/test_group_conversation_flow.py -k 'group_message_flow_orchestration or caps_orchestration_candidates_at_three' -q`
- `pytest app/tests/aiteam/layer2_team_panel/test_team_api_contracts.py -k 'group_conversations or retry or abort' -q`
- `pytest app/tests/aiteam/layer4_frontend_bff/test_chat_page_rendering.py app/tests/aiteam/layer4_frontend_bff/test_group_page_rendering.py app/tests/aiteam/layer4_frontend_bff/test_group_page_reconnect_recovery.py -q`
- `pytest app/tests/aiteam/layer5_flows/test_private_chat_flow.py app/tests/aiteam/layer5_flows/test_group_conversation_flow.py app/tests/aiteam/layer5_flows/test_orchestration_task_tree_flow.py -q`
