# 本地自动化任务

`/tasks` 管理任务，旧聊天调度和办公页入口仍可用。五种频率：单次、固定间隔、每日、每周、每月。日历规则使用 IANA 时区；每月缺失日期跳过，夏令时不存在时刻跳过、重复时刻取较早一次。

## 执行与数据

- ScheduleService 是唯一调度器，configuration 仍在 Conversation.schedule。automation_task 仅保存管理信息及关联；automation_binding 保存当前/历史会话关联。
- 每次执行复用原 Pi Session 上下文。换员工建立新会话，原会话保留；运行中不能改执行配置。Task 不是新的执行状态机。
- 暂停/删除只停止后续触发，不取消当前执行；取消通过原会话入口。任务软删除保留历史，显式删除会话会删除其内容并失效关联任务。
- 任务只属于 token 中的 tenant/member。任务、指令、结果不上传控制面。
- Agent 必须运行并具备当前成员的有效登录身份。停机期间不积压补跑；运行中跨过多个计划点仅处理最近一个。授权恢复沿用现有未执行重试，unknown 不重放。
- 一次运行记录来自 schedule_occurrence、执行收据、work_record 与 Pi 历史；旧会话没有精确关联的记录不伪造归属。

## API

在本地 `/docs` 搜索 automation-tasks。成功响应沿用 data/page；错误使用 application/problem+json。

- `GET/POST /api/agent/automation-tasks`
- `GET/PATCH/DELETE /api/agent/automation-tasks/{task_id}`
- `POST /api/agent/automation-tasks/{task_id}/actions/enable|pause`
- `GET /api/agent/automation-tasks/{task_id}/runs`
- `GET /api/agent/connectors?employee_id=...&status=enabled`

创建要求 Idempotency-Key，同一 tenant/member 下不同 body 不可复用 key；初始化失败可用同 key 重试，初始化完成前不会启用调度。创建收据持久保存，不依赖进程内缓存。PATCH/action/delete 使用详情 etag（也在 ETag 响应头）作为 If-Match，过期返回 409。列表仅返回 prompt_summary，详情才返回完整 prompt。分页游标绑定成员和筛选条件。删除后的运行历史可由同一所有者使用 `include_deleted=true` 查看。

任务状态 active/paused/completed 与运行结果分开。运行结果含 unknown；没有通用自动失败重试。once 消费后不能直接 enable，需设置新的计划时刻。

## 安装受控 MCP 连接器

Manager 员工配置中的 connector_refs 是授权上限。Agent 另需显式安装本地连接配置，不自动发现 `.mcp.json`、不接受网页传入任意服务器/启动命令。此次实现使用已安装的 MCP SDK Streamable HTTP transport，不新建 Manager 凭据分发 API。

设置 `AITEAM_CONNECTORS_FILE` 指向用户自行管理的本地 JSON 文件（Unix 权限必须为 0600，文件最大 256 KB）。格式如下，全部值为示例：

```json
[
  {
    "tenantId": "当前企业 UUID",
    "memberId": "当前成员 UUID",
    "connector_id": "notion",
    "display_name": "Notion",
    "url": "https://approved-mcp.example/mcp",
    "tools": ["search", "fetch"],
    "token_env": "AITEAM_CONNECTOR_NOTION_TOKEN"
  }
]
```

真实 token 放在用户端进程环境中的对应变量，绝不提交仓库。HTTPS 端点或明确的本机 HTTP loopback 可用；不允许 URL 内凭据、查询参数、片段和跳转。`token_env` 可省略用于无认证本地服务；其名称只允许 `AITEAM_CONNECTOR_` 前缀。

只有“本地配置存在 + 当前员工有效快照包含对应 connector_ref + 所需凭据存在”的连接器才显示 enabled；这表示配置就绪，不表示外部网络永远可达。空选择不装配连接器类工具。服务器端对每次工具调用再次检查授权/配置；工具名必须位于本地明确 allowlist。每次外部调用经过现有 ApprovalService，超时或结果不确定不自动重试。调用结束关闭 transport；token 不进入模型参数或普通日志，回显凭据会被移除。

未配置本地连接器时返回真实空列表，用户仍可创建无连接器任务。支持能力的交付不等于已经替用户开通外部账号；外部实例与凭据需要其合法持有者配置。

## 验证与发布

运行 Agent 的类型检查、测试，以及 Agent 前端类型检查、测试、构建；OpenAPI 用真实应用导出并经过 `scripts/check_openapi.py`。新增 SQLite 表和工作记录来源字段采用增量初始化，旧数据保留。正式发布仍经 PR CI 全绿及既有 taiyi TEST 部署流水线；不手工直写服务器库。
