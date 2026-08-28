# Agent 私聊/群聊数字员工头像与名称计划

## 目标与边界

- 借鉴 OpenBMB/StaffDeck 的数字员工头像语言：浅灰身份带、黑白线稿人物插画、柔和边框/阴影、清晰姓名与岗位层级。
- Agent 私聊、群聊的 Pi assistant 消息和活动卡显示来源专家名称与头像；普通用户消息显示“我”，保持聊天上下文可读。
- 复用现有 Agent SSE/JSONL 来源元数据（`source_employee_id`、`source_employee_display_name`）与本地授权专家投影；不上传会话内容，不新增后端接口。
- Operator/Manager 已有专家卡片保持现有视觉基础，本轮仅让头像视觉语义与 Agent 回复保持一致；不复制 StaffDeck 受 AGPL 约束的图片资源或代码。

## 涉及模块与文件

- `web/shared/src/theme/digital-employee-avatar.tsx`：新增自绘、可复用的数字员工人物头像（不复制 StaffDeck AGPL 图片/代码），支持同源头像 URL、确定性人物预设和 fallback。
- `web/agent/src/features/chat/TimelineView.tsx`：为 `ChatMessage` 传入 name/avatar；以来源专家投影补齐 avatar URL，缺失时使用人物插画预设；保留脱敏、事件分类、去重和活动卡行为。
- `web/agent/src/features/group/GroupPage.tsx`：将当前群聊授权 roster 传递给 `TimelineView`，避免重复请求并保证固定 participant 的头像/名称来源。
- `web/agent/src/features/group/useGroupApi.ts`：补齐 `LoadedExpertProjection.avatar_url` 可选类型（兼容旧投影）。
- `web/agent/src/styles/app.css`：新增消息来源姓名/头像布局样式、响应式尺寸与 reduced-motion 规则，继续使用 Astryx theme token。
- `web/operation/src/features/catalog/CatalogPage.tsx`、`web/manager/src/features/marketplace/MarketplacePage.tsx`、`web/manager/src/features/experts/ExpertsPage.tsx`：统一接入人物插画头像。
- `web/agent/src/features/chat/TimelineView.test.tsx`：增加私聊/群聊来源姓名、头像、source fallback 和用户消息标识回归。

## 实施顺序

1. 先确认 `aiteam#2` 当前 Agent 修改范围，避免覆盖其未提交聊天/会话改动；只做小块合并编辑。
2. 增加最小来源投影映射：按 employee id 优先取本地授权专家名称/头像，SSE/durable source metadata 作为名称 fallback，未知来源不展示内部 ID。
3. 用 `ChatMessage` 原生 `name`/`avatar` 能力渲染私聊和群聊 assistant/user 消息；活动卡沿用来源名称但不为每个技术事件重复创建业务状态。
4. 添加自绘 SVG 人物 avatar（不复制 StaffDeck 图片），支持 same-origin avatar URL、确定性人物预设和浅色身份带；所有外部头像 fail-closed 为本地插画。
5. 同步测试和类型；运行 Agent 全量测试、typecheck、build、diff-check。
6. 若服务可用，执行 taiyi 私聊/群聊浏览器 smoke，确认头像姓名、participant 来源、长名称、手机宽度和无网络/控制台错误。

## 关键约束与非目标

- 不修改 Pi 事件协议、SSE 脱敏规则、会话事实源或后端权限契约。
- 不依赖 `source_employee_id` 直接展示 UUID；无名称时使用“数字员工/协作专家”有界占位。
- 不将头像 URL、员工投影或会话内容写入 Agent 新的持久化产品状态；头像只来自现有本地投影/来源元数据。
- 不复制 StaffDeck AGPL 图片/组件代码，不新增 UI 依赖，不使用嵌套 interactive role。
- 不覆盖 `web/agent` 与 `server/agent_service` 中并发未提交改动。

## 完成标准与验证

- 私聊 assistant 回复显示头像和数字员工名称；群聊 coordinator/participant 回复显示各自来源头像和名称；用户消息显示“我”。
- source metadata 缺失、未知、撤权或头像 URL 失败时仍安全显示有界占位，不泄漏 ID/路径/密钥。
- Agent 全量测试、typecheck、生产构建、`git diff --check` 通过；taiyi 浏览器 smoke 有可复现结果。
