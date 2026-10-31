# 办公室动态日志功能实现文档

## 📋 功能概述

实现了办公室动态页面的实时活动日志功能，通过复用现有的对话 SSE 连接，展示员工的实时工作状态。

## ✅ 已实现的功能

### 1. 全局活动收集器
**文件**: `src/lib/globalActivityCollector.ts`

**功能**:
- 单例模式的活动收集器
- 支持添加/移除监听器
- 自动去重（防止重复事件）
- 自动清理缓存（保留最近 50 个 run）
- 带详细的调试日志

**核心 API**:
```typescript
globalActivityCollector.addListener(callback)      // 添加监听器
globalActivityCollector.removeListener(callback)   // 移除监听器
globalActivityCollector.emit(log)                  // 发送活动日志
globalActivityCollector.clearRunCache(runId)       // 清理缓存
```

---

### 2. Chat Store 集成活动收集
**文件**: `src/stores/chat.ts`

**修改内容**:
- 导入 `globalActivityCollector`
- 在 `startAssistantStream` 方法中集成活动收集

**监听的事件**:

#### (1) 思考事件
- **触发时机**: `onThinkingDelta` 第一次接收到推理内容
- **显示内容**: "正在思考..."
- **去重**: 使用 `hasEmittedThinking` 标志防止重复

#### (2) 工具调用事件
- **触发时机**: `onToolCall` 且 `done: true`
- **显示内容**: "调用 [工具名称]"
- **支持的工具**: Read, Write, Edit, Bash, WebSearch, WebFetch, Agent, Workflow, LSP, TaskCreate, TaskUpdate, Grep, Monitor

#### (3) 任务完成事件
- **触发时机**: `finalize` 方法，状态为 `delivered`
- **显示内容**: 根据回复内容智能判断
  - 包含 `<html` 或 `<!DOCTYPE` → "生成网页"
  - 包含 ` ``` ` → "生成代码"
  - 包含 "数据分析" 或 "统计" → "完成数据分析"
  - 包含 "报告" → "生成报告"
  - 默认 → "生成回答"

#### (4) 任务失败事件
- **触发时机**: `finalize` 方法，状态为 `failed`
- **显示内容**: "任务失败"

---

### 3. 发送消息后立即显示"思考中"
**文件**: 
- `src/pages/Chat/index.tsx`
- `src/pages/GroupChat/index.tsx`

**功能**:
- 用户发送消息后，立即在办公室动态显示"收到消息，思考中..."
- 在 `sendRun` / `sendGroupMessage` 成功后、`startAssistantStream` 之前触发
- 提供即时反馈，让用户知道消息已被接收

---

### 4. 办公室页面订阅活动
**文件**: `src/pages/OfficeStatus/index.tsx`

**修改内容**:
- 导入 `globalActivityCollector` 和 `ActivityLog` 类型
- 移除 mock 日志定时器
- 添加活动监听器 `useEffect`

**功能**:
- 订阅全局活动事件
- 自动去重处理
- 追加到日志列表头部（最新的在最上面）
- 触发入场动画
- 保留最近 100 条日志
- 无活动时显示占位提示

---

## 🎯 工作流程

```
用户在对话页面发送消息
    ↓
【立即触发】
Chat/GroupChat: globalActivityCollector.emit({
  text: '收到消息，思考中...',
  type: 'thinking'
})
    ↓
办公室页面 → 显示: 14:28 数据分析师 收到消息，思考中...
    ↓
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SSE 事件流开始：
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    ↓
[1] onThinkingDelta('开始思考...') 首次触发
    ↓
    globalActivityCollector.emit({
      text: '正在思考...',
      type: 'thinking'
    })
    ↓
    办公室页面 → 显示: 14:28 数据分析师 正在思考...
    ↓
[2] onToolCall({ tool: 'Read', done: true })
    ↓
    globalActivityCollector.emit({
      text: '调用 读取文件',
      type: 'tool'
    })
    ↓
    办公室页面 → 显示: 14:28 数据分析师 调用 读取文件
    ↓
[3] finalize('delivered', '数据分析报告...')
    ↓
    globalActivityCollector.emit({
      text: '完成数据分析',
      type: 'result'
    })
    ↓
    办公室页面 → 显示: 14:29 数据分析师 完成数据分析
```

---

## 📊 显示效果

当用户与员工交互时，办公室页面会实时显示：

```
14:29  数据分析师    完成数据分析
14:28  数据分析师    调用 执行命令
14:28  数据分析师    调用 读取文件
14:28  数据分析师    正在思考...
14:28  数据分析师    收到消息，思考中...
14:27  产品策略师    生成报告
14:27  产品策略师    调用 搜索网页
14:27  产品策略师    正在思考...
14:27  产品策略师    收到消息，思考中...
```

---

## ✅ 技术优势

1. **零额外请求** - 完全复用现有的对话 SSE 连接
2. **实时性强** - 事件驱动，延迟 < 100ms
3. **真实数据** - 显示真实的对话活动，不是 mock
4. **自动去重** - 防止重复显示相同事件
5. **内存安全** - 自动清理缓存，最多保留 100 条日志
6. **即时反馈** - 消息发送后立即显示"思考中"
7. **开发成本低** - 纯前端实现，无需后端改动

---

## 🔧 涉及的文件

### 新增文件
- `src/lib/globalActivityCollector.ts` - 全局活动收集器

### 修改文件
- `src/stores/chat.ts` - 集成活动收集到 SSE 事件处理
- `src/pages/OfficeStatus/index.tsx` - 订阅活动收集器
- `src/pages/Chat/index.tsx` - 发送消息后立即显示"思考中"
- `src/pages/GroupChat/index.tsx` - 群聊发送消息后立即显示"思考中"

---

## 📝 使用示例

### 监听活动事件

```typescript
import { globalActivityCollector } from '../../lib/globalActivityCollector'

// 添加监听器
useEffect(() => {
  const handleActivity = (log) => {
    console.log('New activity:', log)
    // 处理活动日志
  }

  globalActivityCollector.addListener(handleActivity)

  return () => {
    globalActivityCollector.removeListener(handleActivity)
  }
}, [])
```

### 手动发送活动日志

```typescript
import { globalActivityCollector } from '../../lib/globalActivityCollector'

globalActivityCollector.emit({
  time: '14:28',
  agent: '数据分析师',
  text: '正在执行任务...',
  type: 'thinking',
  convId: 'conv_123',
  runId: 'run_456',
})
```

---

## 🚀 未来优化方向

1. **支持任务分组** - 按 runId 将同一任务的日志分组显示
2. **支持日志过滤** - 按员工、类型、时间范围过滤
3. **支持导出日志** - 导出为 CSV 或 JSON
4. **跨标签页同步** - 使用 BroadcastChannel 实现多标签页同步
5. **支持历史回放** - 查看过去的活动日志

---

## 🎉 总结

本功能通过巧妙地复用现有的 SSE 基础设施，在不新增任何后端接口的情况下，实现了办公室动态的实时日志功能。用户可以实时看到所有员工的工作状态，包括思考、工具调用和任务完成等关键节点。
