# 对话时间、知识库与人才工作入口

## 对话时间

本地 Agent 会话响应新增 `last_message_at`（ISO 8601 或 null），来源与 `last_preview` 相同：持久化历史中的最后一条可见 user/assistant 消息。思考、工具结果、修改标题和标记已读不影响消息时间。空会话/旧消息无有效时间返回 null。

随包 Agent 由 `pnpm agent:build` 从同一提交的 `server/agent_service` 构建，前后端改动随提交一起生效。连接旧版 Agent 缺这个字段时，前端显示“时间未提供”，不将 `updated_at` 冒充消息时间。

## 群聊委派目标（适配 Server main `21684254`）

当前 Agent 历史条目不再返回 `participant_employee_display_name`。前端根据 `participant_employee_id` 查找本机员工目录的展示名；目录尚未加载、撤权成员不在目录或展示名为空时，显示真实员工 ID，避免委派目标徽标消失。不会把 `source_employee_display_name`（发送者）当成目标姓名，也不按名字猜员工身份。旧缓存中的已撤销姓名字段不再参与解析。

人类输入、员工自身条目以及没有目标 ID 的条目仍不显示委派徽标。历史加载、发送后重载与 SSE reconciliation 共用此转换逻辑。此适配不新增成员查询或改变授权行为；目录未命中时以 ID 展示，重新加载消息后按最新目录解析。

已有 `X-Request-ID` / `traceparent` 请求传播和响应 `X-Request-ID` 诊断记录保留；服务端新增日志 `tenant_id` 属内部追踪，不新增前端参数。

## 三类知识来源

知识库首页按归属分三张卡（`src/pages/KnowledgeBase/KnowledgeSourceCards.tsx`），设计见 [议题 6](plans/2026-10-29-product-design-proposals/06-knowledge-sources.md)：

| 来源 | 谁配置 | 客户端怎么访问 | 上传 |
| --- | --- | --- | --- |
| 企业知识库 | 管理员在 Manager 后台配置；部署位置（Manager 托管或企业内网 NAS，NAS 经 Manager 网关）只读显示 | 空间数和部署位置读本机 Agent `GET /api/agent/knowledge-sources`；浏览和上传仍经「连接企业知识库」直连 Manager `/api/manager/knowledge-spaces`，写入需 `owner` / `enterprise_admin` | `POST /api/manager/knowledge-spaces/{id}/documents`，multipart `file`，单文件最大 4 MiB |
| 个人知识库 | 成员自己添加，可连多台服务 | 直连实现[知识库服务适配协议](knowledge-base-provider.md)的服务，保存该服务的 Bearer 令牌 | `POST /api/knowledge-bases/{id}/documents`，JSON `name/mime_type/size/content_base64` |
| 本机目录 | 成员在本机授权并登记的目录 | 本机 Agent 只返回名称和状态，不返回路径；按员工的开关在聊天「权限」面板里管理 | 不上传，见[本机文件访问授权](local-file-access.md) |

- 客户端不保存企业 NAS 的地址或令牌；旧版 Agent 没有 `knowledge-sources`（404）时，企业卡沿用连接状态显示。
- **个人知识库只允许私有**：新建时 `level` 恒为 `private`，团队级已取消；服务上已有的 `team` / `enterprise` 级知识库照常读取，显示「待迁移」，由管理员迁移到企业知识库。服务端没有这一约束，由客户端拦截。
- **企业知识库只连接、不新建**：每企业一个共享知识库，由服务端自动开通，删除返回 409。
- **个人服务先验证后保存**：用草稿地址列取一次知识库，连不上就不保存、不影响已有连接；同一地址或同名服务不能重复添加。「修改连接」保留这台服务的内部 ID；「断开连接」只移除本机连接，不删除服务上的知识库。某台服务失败只在它自己那一行显示，它那一行的「新建知识库」置灰。
- **添加服务和新建知识库分开**：新建只在某台服务那一行发起，弹窗顶部显示目标服务，所以目标总是明确的；页面顶部没有全局「新建」按钮。
- 写操作固定发往知识库所在的那台服务，失败不回退到另一服务。UI 内部 ID 带来源前缀：企业库 `enterprise:<id>`，个人库 `local:<nasId>:<id>`；上传、重试、员工关联、预览都按前缀路由，并只带该连接自己的令牌。旧版单个 `localUrl`/`localToken` 配置读取时自动变成第一台服务（内部 ID `default`）。
- 文档上传不发送本机绝对路径。完成表示服务端已接收，不表示解析/索引成功；批量上传逐文件处理，重试只上传失败文件。
- 浏览器开发还需服务端允许对应 CORS origin；桌面通过原生 HTTP 传输。

## 人才详情

- `Manager /api/manager/recruit/orders` 的成功记录提供模板到员工的权威关联；与本机 `/api/agent/grants/experts` 的当前授权取交集，不按姓名、岗位或模板 ID 猜员工。
- 多个匹配实例时须手动选择；撤权和归档员工不可选。若投影本身提供 `source_template_id` 也可直接识别。
- 现有 Agent 投影通常不含来源模板，因此需配置具有读取招募记录权限的 Manager 连接。没有关联记录或未获本机授权时显示原因，不自动招募或扩大权限。
- 发起对话先请求本机 readiness，再创建本地会话并携带 conversationId 跳转。
- 知识关联作用于已选择的真实员工，不改市场模板。企业库使用 knowledge-space bindings；个人服务使用独立权限接口，保留已有绑定。
- 关联成功不代表运行时立即更新：企业库配置需待本机授权同步后生效；个人服务检索需员工配备对应工具。

## 验证方式

```sh
cd clients/desktop
pnpm test
pnpm build
# Vite :1437 + headless Chrome CDP :9238 启动后：
node tests/workspace-browser-smoke.mjs
# 自动启动/清理 Vite :1441 和独立 Chrome :9239，业务 HTTP 全部模拟：
node tests/knowledge-create-browser-smoke.mjs
```

`tests/workspace-smoke.html` 是开发期组件测试夹具，使用模拟业务响应，不代表真实 Manager/NAS 已联调。浏览器脚本验证自动化桌面/窄屏、表单、筛选空态、Manager multipart 上传以及人才关联/发起对话，截图写到 `output/workspace-smoke/`。
