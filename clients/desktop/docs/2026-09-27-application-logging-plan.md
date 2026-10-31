# 全应用日志实施计划

## 需求与边界
用户要求整个应用的生产日志；后续明确：**以后端已有日志为主，前端保持简单，只补后端不可见的故障信息**。范围收缩为桌面 React/Tauri、Node Agent、Python Manager/Operation；撤回共享Web三端日志面板及独立前端日志扩展。不添加消息菜单报告问题。不自动上传日志、不默认记录正文、请求/响应 body、query、凭据、环境变量或原始 runtime 事件。不新增服务器日志下载 API，不改变业务 schema、数据所有权、认证和连接目标。

## 审查结果
- clients/desktop/src/api/requestLogging.ts：开发期 Console + 登录例外；会输出裁剪 body；无生产持久记录。
- clients/desktop/src-tauri/src/agent.rs：stdout/stderr 直写 agent.log，启动时 previous.log，运行无大小轮转。
- FredServer/server/agent_service/src/http/server.ts：Fastify logger=false；原始异常 console/error；缺乏统一结构化日志。
- FredServer/server/shared/observability.py：已有请求/trace上下文、脱敏格式、metrics；复用，不另造追踪框架。

## 实施顺序
1. 建立安全结构化日志模块及测试。固定事件标识、分级、UTC时间、实例/请求/trace ID、耗时、状态、固定路由、有限关联ID；不接收任意自由文本。限定内存/文件容量，失败不影响业务。
2. Agent HTTP/上游/执行生命周期接入：验证外部 request ID、透传 trace、记录安全失败原因和完成状态；JSONL按实例落盘及轮转。Python保留现有控制台格式、脱敏与metrics，只补可选私有JSONL轮转文件，避免多进程竞争、重复handler。
3. 桌面补盲：界面异常、启动/认证、请求失败/取消/慢请求、SSE断线重连、实际连接地址及关联ID；正常成功HTTP请求只由后端记录，前端不重复保存。宿主受控日志入口、子进程输出安全收集、落盘与轮转；设置页保留简单查看/筛选/刷新、本地导出，明确哪些服务未包含。不改共享Web。
4. 测试与文档：敏感字段/正文哨兵、日志伪造/非法ID、截断/轮转/写入失败、请求关联、导出边界；TS/Python/Rust检查和相关回归；操作手册说明位置、保留、清理及服务端日志获取。

## 验证完成标准
- 后端拥有请求主日志；前端补请求未到达/被取消/界面异常等盲区，正常成功响应不重复记录。原始内容不会因debug或登录例外泄漏。
- 同一个请求可按request_id跨前后端关联；异步工作有独立work标识而非逐token日志。
- 客户从设置页查看/导出本机有界日志，无需Console；控制面日志需运维权限。
- 本地测试通过；没有证据不宣称已打包/部署/升级客户进程。

---

## 生产故障排查与运维指南

### 1. 各服务日志位置与格式
- **桌面端（Tauri + React）**：
  - 本地路径：`~/Library/Application Support/com.aiteam.desktop/logs/`
  - 前端环形内存缓冲：最近 1000 条结构化事件（仅含网络失败/取消、SSE重连、UI崩溃、实际连接目标）。
  - 设置页入口：设置 -> 调试与日志 -> 导出诊断包（保存为 ZIP，包含前端关键诊断事件与本地 Agent 日志）。
- **Node Agent 服务**：
  - 本地路径：`AITEAM_LOG_DIR` 或 Agent 数据目录下 `logs/agent-<instance_id>.jsonl`
  - 格式：每行一条 JSON，包含 `timestamp`, `level`, `event`, `request_id`, `trace_id`, `work_id`, `route`, `status`, `duration_ms`。
  - 限制：单文件最大 2MB，最多保留 3 个历史备份，总容量超过 32MB 自动清理。
- **Python Manager / Operation 服务**：
  - 默认输出：标准输出（stdout），符合 journald/Loki 采集规范。
  - 文件输出（如配置 `AITEAM_LOG_DIR`）：`service-<instance_id>.jsonl`，按进程隔离写入，防止多进程竞争。

### 2. 跨端调用链串联（Traceability）
- 客户端在发起 HTTP 请求或建立 SSE 连接时，自动生成：
  - `X-Request-ID`: 标准 UUID v4，唯一标识一次网络交互。
  - `traceparent`: W3C 标准 `00-<trace_id>-<span_id>-01`。
- 服务端（Agent / Manager / Operation）收到后原样继承并回填在响应头中，日志中以 `request_id` 和 `trace_id` 建立端到端索引。

### 3. 典型场景排查流程：以“群聊同一角色重复发话”为例
1. **获取客户端诊断包**：客户在设置页点击“导出诊断包”，获取 ZIP 文件。
2. **确认实际连接目标**：查看诊断包中 `connection.target_observed` 事件，确认客户端连接的是本地 Agent 还是远程测试环境（避免环境误判）。
3. **定位会话与请求**：通过会话 ID（`conversation_id`）过滤 Agent 日志中的 `session.message_streamed` 或 `http.completed` 事件。
4. **分析消息产生逻辑**：
   - 检查 `work_id` 与执行动作：若是协调员工调用 `mention_employee` 派发任务，查看是否在同一轮对话中向不同成员发起了文本相同的多次委派。
   - 检查消息 ID：查看两次回复对应的 `logical_message_id` 是否不同。若 ID 不同，说明底层是两条独立委派记录，属于展示层缺少受派人标签导致的视觉重复，而非数据库插入重复。
