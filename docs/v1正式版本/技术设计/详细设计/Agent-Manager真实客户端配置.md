---
created: 2026-06-22
issue: #175
status: implemented
tags: [agent, manager, cross-tier, service-client, A4, A5]
---

# Agent→Manager 真实客户端配置与使用

> **实现状态**：已落地 #175 Wave3 track:A
> **对应概要设计**：05 §5（通信架构）、04 §6.5（治理摘要上报）、D4/D14 裁决

## 1. 功能概述

Agent→Manager 的 grants 拉取（A4）和 usage 上报（A5）真实客户端已实现，经 `shared.service_client` 跨端调用。

**默认行为**：
- 未配置 `MANAGER_URL` → 使用占位客户端（`UnconfiguredGrantsClient` / `UnconfiguredUsageClient`）
- 占位客户端安全拒绝（不静默成功），但 app 仍可启动（D14 离线降级）
- 配置 `MANAGER_URL` 后 → 自动装配真实客户端（`ServiceClientGrantsClient` / `ServiceClientUsageClient`）

**跨端通信特性**：
- 统一使用 `ServiceClient`，自动处理：
  - 超时与重试（只读调用幂等重试）
  - trace 透传（X-Request-ID / X-Trace-ID）
  - 服务身份签名（X-Service-Identity / X-Service-Token）
  - 错误模型解码（problem+json → AppError）
- grants sync 失败不阻塞本地（本地投影 + 已冻结快照继续可用）
- usage 上报失败留 pending 重试（不丢失计量数据）

## 2. 配置方式

### 2.1 环境变量配置

```bash
# Agent 端必需配置
export APP_TIER=agent
export MANAGER_URL=https://manager.example.com  # Manager 端地址

# 可选：服务间认证密钥（平面③ 代码层守卫，03 §9.1）
export SERVICE_TOKEN=your-service-token-here

# 可选：其他 Agent 配置
export AGENT_DB_PATH=/path/to/agent.db
export AGENT_RUNTIME=hermes
```

### 2.2 配置验证

启动 Agent 服务后，通过以下方式验证配置：

```bash
# 健康检查（不因 Manager 离线而 not-ready）
curl http://localhost:8000/api/agent/ping

# 尝试 grants sync（需先登录）
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/agent/grants/sync

# 查看 usage outbox 状态
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/agent/usage/outbox
```

## 3. 客户端行为说明

### 3.1 Grants Client（A4）

**功能**：
- `pull_authorized_config()`：拉取已授权专家/方案配置（F10）
- `pull_snapshot()`：拉取执行快照（F11）

**调用路径**：
- `/api/manager/grants/authorized-config` (POST)
- `/api/manager/snapshots` (POST)

**离线降级**：
- Manager 不可达 → 抛出 AppError
- GrantsService 捕获后返回 `{"ok": false}` 而非 5xx
- 本地投影与已冻结快照继续可用
- 不影响 app 健康检查（不致 not-ready）

### 3.2 Usage Client（A5）

**功能**：
- `upload(payload, idempotency_key=...)`：上报脱敏 usage/audit 摘要（F13）

**调用路径**：
- `/api/manager/usage/summary` (POST)

**幂等与重试**：
- 写调用带 `Idempotency-Key` HTTP header（05 §5.1）
- 上报失败留 pending 状态，不自动重试（由 reporter.drain() 周期驱动）
- `summary_id` 幂等去重（同 ID 不产生重复条目）
- 已 sent 的条目不重复上报

**隐私保护**：
- payload 只含脱敏计量/审计摘要（04 §6.5）
- 不包含会话内容、文件、工具输入输出明细

## 4. 代码示例

### 4.1 手动构造客户端（测试用）

```python
import httpx
from agent_service.grants.client import ServiceClientGrantsClient
from agent_service.usage.client import ServiceClientUsageClient
from shared.service_client import ServiceClient

# 构造真实客户端
manager_url = "http://manager.local:8001"
service_client = ServiceClient(
    manager_url,
    service_identity="agent-service",
    service_token="test-token",
)

grants_client = ServiceClientGrantsClient(service_client)
usage_client = ServiceClientUsageClient(service_client)

# 或使用 mock transport 进行测试
mock_transport = httpx.MockTransport(your_mock_handler)
test_client = ServiceClient(manager_url, transport=mock_transport)
```

### 4.2 使用占位客户端（默认行为）

```python
from agent_service.grants.client import UnconfiguredGrantsClient
from agent_service.usage.client import UnconfiguredUsageClient

# 未配置 MANAGER_URL 时的默认行为
grants_client = UnconfiguredGrantsClient()
usage_client = UnconfiguredUsageClient()

# 调用时抛出明确错误（不静默失败）
try:
    grants_client.pull_authorized_config(request)
except AppError as e:
    # "manager grants client 未配置（A4 骨架）..."
    pass
```

### 4.3 App 自动装配（生产用）

```python
from agent_service.app import build_app

# app.py 自动装配逻辑：
# 1. 读取 settings.manager_url
# 2. 如果配置了 MANAGER_URL → 自动创建 ServiceClient*Client
# 3. 未配置 → 使用占位客户端（安全拒绝）

app = build_app()  # 会根据环境变量自动装配
```

## 5. 测试覆盖

### 5.1 单元测试

- `tests/agent/grants/test_client.py`：ServiceClientGrantsClient 契约形状
- `tests/agent/usage/test_outbox_reporter.py`：outbox 幂等与 reporter 重试

### 5.2 集成测试

- `tests/agent/test_manager_client_wiring.py`：
  - 配置后自动装配真实客户端
  - 未配置时占位客户端安全拒绝
  - trace 头透传（X-Request-ID / X-Trace-ID / X-Service-Identity）
  - Idempotency-Key 传递

### 5.3 运行测试

```bash
cd server
python -m pytest tests/agent/grants/ tests/agent/usage/ tests/agent/test_manager_client_wiring.py -v
```

## 6. 故障排查

### 6.1 常见问题

**Q1: grants sync 返回 `{"ok": false}`**
- 检查 `MANAGER_URL` 是否配置
- 检查 Manager 服务是否可达
- 查看 Agent 日志确认错误详情
- 离线降级正常，不影响已装载的专家/快照

**Q2: usage 上报失败，pending 条目堆积**
- 检查 Manager `/api/manager/usage/summary` 端点是否正常
- 查看 outbox 状态：`GET /api/agent/usage/outbox`
- pending 条目会保留并自动重试（不丢失数据）
- 手动触发重试：`POST /api/agent/usage/flush`

**Q3: 服务身份认证失败（403）**
- 检查 `SERVICE_TOKEN` 是否配置且匹配
- Manager 端需配置相同的 `SERVICE_TOKEN`
- 未配置 token → fail-open（dev 友好），配置后 → fail-closed

### 6.2 日志查看

```bash
# 查看 Agent 日志中的跨端调用
grep "X-Request-ID" agent.log

# 查看 grants sync 日志
grep "grants" agent.log | grep -E "(sync|pull)"

# 查看 usage 上报日志
grep "usage" agent.log | grep -E "(upload|drain)"
```

## 7. 后续演进

### 7.1 已实现（#175）
- ✅ ServiceClientGrantsClient 经 shared.service_client 真实调用
- ✅ ServiceClientUsageClient 经 shared.service_client 真实调用
- ✅ app.py 自动装配（MANAGER_URL 配置感知）
- ✅ 离线降级（D14）：sync/上报失败不致 not-ready
- ✅ trace 透传与服务身份签名
- ✅ 集成测试覆盖

### 7.2 待详设/后续 Wave
- Manager 端接收端点实现（M7/#41 grants、M8/#42 usage）
- 完整 mTLS 服务间认证（部署层，当前为代码层守卫）
- usage reporter 周期 drain 调度策略
- grants sync 触发时机（登录后/周期/手动）
- 跨端接口完整 OpenAPI 契约（02 §10.3）

## 8. 参考文档

- [00 架构总纲](../概要设计/00-架构总纲与裁决索引.md)（D4/D14 裁决）
- [05 通信架构](../概要设计/05-通信架构与跨端契约.md)（§5 跨系统通信、F10/F11/F13）
- [04 数据架构](../概要设计/04-数据架构与多租户隔离.md)（§6.5 治理摘要上报）
- [02 北向 API](../概要设计/02-北向API与接口契约规范.md)（§10.3 envelope、§11.2 错误模型）
- [03 认证](../概要设计/03-认证与身份设计.md)（§9.1 服务身份平面③）
