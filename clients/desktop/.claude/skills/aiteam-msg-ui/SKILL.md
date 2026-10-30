---
name: aiteam-msg-ui
description: AITeam消息UI组件使用说明 - MessageRow、MessageBubble、TextMessage等组件的使用和定制
---

# AITeam 消息UI组件使用说明

## 一、组件层次

```
MessageRow (入口)
  ├─ FileMessage (文件/图片)
  │   └─ MessageBubble + 文件显示
  └─ TextMessage (文本)
      └─ MessageBubble
          ├─ ThinkingBlock (推理过程)
          ├─ ReactMarkdown (内容)
          └─ AttachmentBar (附件)
```

## 二、核心组件文件

- `src/components/Chat/MessageRow.tsx:19` - 消息统一入口
- `src/components/Chat/MessageBubble.tsx:22` - 气泡布局容器
- `src/components/Chat/TextMessage.tsx:27` - 文本消息渲染
- `src/components/Chat/FileMessage.tsx` - 文件/图片消息
- `src/components/Chat/ThinkingBlock.tsx` - 推理过程显示

## 三、使用示例

### Chat页面 (src/pages/Chat/index.tsx:453)

```typescript
<MessageRow
  msg={msg}
  convEmoji={conv?.agentEmoji ?? '🤖'}
  convAgentName={conv?.agentName ?? '助手'}
  userAvatar={userId.slice(0, 1).toUpperCase()}
  displayContent={content}
  isThisStreaming={msg === streamingMsg && streaming}
  isThinkingPhase={msg === streamingMsg && isStreaming && content === ''}
/>
```

### GroupChat页面 (src/pages/GroupChat/index.tsx:156)

```typescript
<MessageRow
  msg={msg}
  convEmoji={group.emoji}
  userAvatar={userId.slice(0, 1).toUpperCase()}
  displayContent={msg.content}
  isThisStreaming={streaming}
  isThinkingPhase={isThinkingPhase}
  onAvatarClick={msg.senderName ? (e) => handleAvatarClick(msg, e) : undefined}
/>
```

## 四、Props说明

### MessageRowProps
- `msg` - 消息对象
- `convEmoji` - 对话emoji（assistant头像）
- `convAgentName` - 对话智能体名称
- `userAvatar` - 用户头像
- `displayContent` - 展示内容
- `isThisStreaming` - 是否正在流式输出
- `isThinkingPhase` - 是否处于thinking阶段
- `onAvatarClick` - 头像点击回调（群聊）

### MessageBubbleProps
- `side` - 'left' | 'right' 对齐方向
- `avatar` - 头像内容
- `name` - 发送者名称
- `time` - 时间戳
- `above` - 气泡上方内容（ThinkingBlock）
- `isStreaming` - 流式状态（头像动画）
- `onContextMenu` - 右键菜单
- `children` - 气泡内容

## 五、特性

### Markdown渲染
- 表格、列表、链接
- 代码高亮（react-syntax-highlighter）
- 图片懒加载

### 流式状态
- 头像pulse动画
- "思考中"波点动画
- 80ms防抖更新

### ThinkingBlock
- 折叠/展开
- reasoning文本
- tool调用显示（input/result）

---

**最后更新：** 2026-08-20
