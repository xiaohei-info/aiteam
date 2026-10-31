# 设计与实现差距清单 (design_gaps)

> 用途：登记设计文档 (`docs/design/new_design.md` / `设计系统视觉规范.md`) 中已经画到但当前
> 后端 / SDK 未就绪、或需要多端同步才能落地的能力。前端在推进过程中把服务端相关
> 缺口全部收敛到本文，避免散落在各个 TODO / FIXME 里。
>
> 每一项都遵循：
>
> - **场景**：设计文档里的位置与目标
> - **前端现状**：当下的实现或占位
> - **服务端缺口**：需要新增 / 扩展的接口 / 字段
> - **建议**：可行的推进方式或临时方案

---

## 1. 会话列表元数据

**场景**：设计文档 §5.1 / §5.2 会话列表 —— 需要展示 `last_preview`（末条消息摘要）、
`unread_count`（稳定的未读数）、群聊头像成员列、成员在线状态。

**前端现状**：
- `last_preview` 目前由前端读消息数组末尾自算，切换会话或刷新后偶发丢失
- `unread_count` 无服务端下发，只在 SSE 到达时前端 +1，重启后归零
- 群聊头像只用一个 emoji 占位，未实现成员头像叠加
- 员工 `online_status` 目前一律显示"活跃"，无实时数据

**服务端缺口**：
- 会话摘要接口在响应里补 `last_preview`、`unread_count`、`last_message_at`
- 群会话需返回 `members[]`（含 avatar_url、display_name）与 `description`
- 员工需要 `online_status`（online / busy / offline）与 `last_seen_at`

**建议**：优先补 `last_preview` + `unread_count` 两项，其它随办公室视图动画一同推进。

---

## 2. 员工用量统计

**场景**：设计文档 §5.5 人才市场卡片 —— "召唤 N 次 / 累计费用 / 单次价格"。

**前端现状**：
- `召唤次数` 前端展示 `usage_stats.total_recruits`，已加千分位
- `累计费用` 与 `单次价格` 目前没有数据源；筛选与价格排序明确禁用，不再生成哈希价格
- Marketplace 只有 `skills_count`，缺技能名称、职级和描述；前端显示“待服务端提供”，不生成占位业务数据
- “活跃实例数”缺失时详情页显示 `—`，不再用 0 冒充统计值

**服务端缺口**：
- 模板级：`price_per_call`、`cumulative_cost`（企业维度）
- 模板详情：`description`、`skills[]`、`level`、`active_instances`
- 员工级：`invocation_count`、`token_usage`、`total_cost`

**建议**：计费字段随计费模块落地；其它模板详情字段可先扩展 marketplace detail 接口。前端在字段到位前保持不可筛选状态。

---

## 3. 群聊编排规则

**场景**：设计文档 §5.2 群聊 —— "AI 自由编排 / 固定流程编排" 两种模式，且允许后续
在群聊面板里编辑。

**前端现状**：
- `CreateGroupDialog` UI 中提供了 `scheduleMode: 'auto' | 'custom'` 与规则文本框
- 但服务端 `POST /api/agent/conversations`（kind='group'）不接受也不落库此字段
- 群聊详情面板暂时没有编辑入口

**服务端缺口**：
- 会话元数据表补两列：`orchestration_mode`、`orchestration_rule`
- 已有 `PATCH /api/agent/conversations/:id`；需要扩展 schema 支持 `description` 与编排字段

**建议**：先落库不做行为影响；引擎接入编排规则的工作可以留到下期。

---

## 4. 自动化模块（设计文档 §5.3）

**场景**：任务模板、定时触发、外部 Webhook —— 完整的自动化平台。

**前端现状**：Sidebar 与 `/tasks` 已可达，但页面明确标记“功能预览”；创建按钮和模板入口均禁用，不会产生伪任务。

**服务端缺口**：整个后端未就绪（调度、触发条件、执行日志、外部集成均缺）。

**建议**：整个模块独立立项；服务端契约稳定前保持只读预览。

---

## 5. 知识库网格 / 列表切换 + 拖拽上传（设计文档 §5.4）

**场景**：知识库文件视图支持网格 / 列表两种布局，并支持从桌面拖拽上传，附带高亮反馈。

**前端现状**：知识库总览已支持 180×180 网格 / 列表切换和本地偏好记忆；这不是设计 §5.4.4 的文件网格。`Detail.tsx` 的真实文档内容区仍需补网格视图和规范化拖拽反馈。

**服务端缺口**：不涉及（前端可独立完成）。

**建议**：保留总览网格，把文件网格单列为 `archive/todo.md` A4.4（已归档）；上传队列和拖拽视觉继续由 C6 跟踪。

---

## 6. 办公室视图状态动画差异化（设计文档 §5.7）

**场景**：不同员工的动画状态（发呆、思考、跑动、协作）用来直观反映当前忙碌情况。

**前端现状**：员工节点使用统一动画，未依据活动类型切换。

**服务端缺口**：需要下发 `activity_type`（thinking / running / idle / collaborating）。

**建议**：可以先前端根据 SSE 事件类型粗略推断（收到 THINKING 就切 thinking，收到 message 就切 idle），
未来再叠服务端权威字段。

---

## 7. 会话列表右键菜单

**场景**：设计文档 §5.1.4 —— 会话列表条目支持右键 "置顶 / 标记已读 / 删除"。

**前端现状**：右键菜单已实现置顶 / 全部已读 / 删除，并具备视口边缘回避、键盘焦点、处理中防重复和结果反馈。置顶暂按 tenant/member 存在 localStorage。

**服务端缺口**：
- 置顶：会话上加 `pinned_at` 字段，需要 `PATCH` 接口
- 标记已读：`markConversationRead` 已存在，但缺 "整个会话标记全已读"（当前必须传 `last_entry_id`）
- 删除：`DELETE /api/agent/conversations/:id` 已开放并接入，不再是缺口

**建议**：补服务端 `pinned_at` 后替换本地置顶；全部已读快捷接口可减少前端先拉 entries 的额外请求。

---

## 附：已消化的差距

以下是设计文档中曾经的差距，本轮已经落地（不再列入未来清单）：

- **员工头像 avatar_url**：`ExpertProjection.avatar_url` 已透传到 `ConversationItem` 与 `WorkbenchEmployee`，
  会话列表 / 员工详情面板均已消费。
- **未读数 99+ 折叠**：Panel 已按 `> 99 ? '99+'` 折叠展示。
- **相邻消息 5 分钟时间分隔 + 新消息按钮**：Chat 页已实现。
- **人才市场召唤次数千分位**：AgentCard 与 TalentDetailPanel 均已 `toLocaleString('zh-CN')`。
- **人才市场缺字段降级**：价格、职级、技能名称、描述缺失时明确提示并禁用相关筛选/排序，不再构造演示数据；招募接口 410，成功 Toast 路径当前不可达。
- **CreateGroupDialog 步骤指示器**：从 5 步降为实际 3 步。
- **组织架构多级部门递归渲染**：OrgChart 顶层部门下已递归渲染子部门与员工。
- **单聊 @ 提及**：ChatInputBar 单聊入口已接入 MentionInput，@ 列表仅含当前员工。
- **会话列表空状态**：Panel 已展示引导 CTA（前往人才市场 / 创建群聊）。
- **知识库总览视图切换**：总览已支持 180×180 知识库卡片和列表视图，并安全记忆本地偏好；真正文件网格仍在 A4.4。
- **全局减少动效偏好**：`globals.css` 已响应 `prefers-reduced-motion`。
