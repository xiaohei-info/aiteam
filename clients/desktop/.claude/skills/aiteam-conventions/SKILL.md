---
name: aiteam-conventions
description: AITeam 桌面端项目编码规范速查 — 新建组件前或 PR Review 前调用，确保风格与 feature/dev_agents 分支一致
---

# AITeam 编码规范

## 速查清单

新建组件或 PR Review 时逐项核对：

- [ ] CSS 策略：简单列表页 → Tailwind；复杂交互子页面 → 独立 `.css` 文件
- [ ] CSS 状态类：扁平类名（`selected`/`active`/`open`），不用 BEM `--` 修饰符
- [ ] import 无 `@/` 别名，全部相对路径
- [ ] import 顺序：React → 第三方 → CSS → 内部模块
- [ ] 图标使用 `lucide-react`，不手写 SVG
- [ ] Props interface 定义在文件顶部，组件函数之前
- [ ] 事件处理函数命名：`handleX`（`handleCreate`、`handleBack`、`handleToggle`）
- [ ] 文件命名：组件 PascalCase，工具函数 camelCase，页面入口用 `index.tsx`

---

## 1. CSS 使用策略

**简单列表 / 容器页面** → 保留 Tailwind，不引入 CSS 文件：

```tsx
// AgentConfig/index.tsx — 列表页，Tailwind OK
<div className="h-full overflow-y-auto p-6">
  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
```

**复杂交互子页面** → 独立 CSS 文件，TSX 内只用 CSS 类：

```tsx
// AgentCreate.tsx — 复杂表单，用独立 CSS
import './AgentCreate.css'

<div className="ac">
  <aside className="ac-preview">
```

判断标准：有 hover/active 状态切换、动画、多层嵌套布局 → 独立 CSS。

---

## 2. CSS 文件结构

```css
/* ═══════════════════════════════════════════
   组件名 — 简要说明
   ═══════════════════════════════════════════ */

.ac { ... }

/* ─── 子区域标题 ─── */

.ac-preview { ... }
```

- 主节用 `═══` 装饰注释
- 子节用 `─── 标题 ───`
- 每个组件用短前缀（`ac-`、`mb-`、`chat-`、`ad-`）

---

## 3. CSS 状态类命名

**✅ 正确 — 扁平状态类：**

```css
.ac-avatar-opt.selected { border-color: var(--brand); }
.ad-nav-item.active     { color: var(--text-primary); }
.ad-status.active .ad-status-dot { background: #34d399; }
```

```tsx
<div className={`ac-avatar-opt ${isSelected ? 'selected' : ''}`}>
<button className={`ad-nav-item ${activeSection === key ? 'active' : ''}`}>
```

**❌ 错误 — BEM 双横线修饰符（不符合本项目规范）：**

```css
/* 禁止 */
.mb-bubble--left { }
.chat-header-dot--streaming { }
```

---

## 4. Import 规范

**顺序：React → 第三方 → CSS → 内部模块**

```tsx
// 1. React
import { useState } from 'react'

// 2. 第三方
import { ChevronLeft, Plus, X } from 'lucide-react'

// 3. CSS（紧跟第三方之后）
import './AgentCreate.css'

// 4. 内部模块（相对路径，无 @/ 别名）
import { useChatStore } from '../../stores/chat'
import { dbInsertMessage } from '../../lib/db'
```

**路径规则：**
- ✅ `'../lib/db'`、`'../../stores/chat'`、`'./AgentCreate.css'`
- ❌ `'@/lib/db'`、`'@/stores/chat'`

---

## 5. 图标

优先使用 `lucide-react`，不手写 SVG：

```tsx
// ✅ 正确
import { ChevronLeft, Plus, Trash2, Sparkles } from 'lucide-react'
<ChevronLeft size={16} />

// ❌ 避免（已有组件可保留，新组件不用）
<svg width="14" height="14" viewBox="0 0 16 16">...</svg>
```

---

## 6. Props Interface

Interface 定义在文件顶部，export default 函数之前：

```tsx
// ✅ 正确
interface AgentCreateProps {
  onBack: () => void
  onCreateSuccess: (agent: any) => void
}

export default function AgentCreate({ onBack, onCreateSuccess }: AgentCreateProps) {
```

辅助 interface（数据结构）也在顶部，组件 props interface 之前：

```tsx
interface AvailableSkill {
  id: string
  name: string
  category: 'analysis' | 'generation' | 'integration'
}

interface AgentCreateProps {
  onBack: () => void
}
```

---

## 7. 事件处理函数

统一用 `handleX` 前缀：

```tsx
// ✅
const handleCreate = async () => { ... }
const handleBack = () => { ... }
const handleToggleSkill = (id: string) => { ... }
const handleContextMenu = (e: MouseEvent) => { ... }

// ❌
const onCreate = () => { ... }
const onBack = () => { ... }
const clickHandler = () => { ... }
```

---

## 8. 文件命名

| 类型 | 规则 | 示例 |
|------|------|------|
| React 组件 | PascalCase | `AgentCreate.tsx`, `MessageBubble.tsx` |
| 组件 CSS | 同组件名 | `AgentCreate.css`, `MessageBubble.css` |
| 工具函数 | camelCase | `fileCache.ts`, `message.ts` |
| 页面入口 | `index.tsx` | `AgentConfig/index.tsx`, `Chat/index.tsx` |
| 子页面 | PascalCase 兄弟文件 | `AgentConfig/AgentCreate.tsx` |
| Store | camelCase | `chat.ts`, `auth.ts` |

---

## 9. CSS 变量速查

```css
/* 背景层级 */
var(--surface-0)   /* #0c0e12 — 最深背景 */
var(--surface-1)   /* #13161c */
var(--surface-2)   /* #1a1e26 */
var(--surface-3)   /* #22272f */
var(--surface-4)   /* #2a3038 */

/* 文字 */
var(--text-primary)    /* #eeeae2 */
var(--text-secondary)  /* #9b9da3 */
var(--text-muted)      /* #5a5c62 */

/* 品牌色 */
var(--brand)           /* #e89a2e */

/* 边框 */
var(--border)          /* rgba(255,255,255,0.05) */
var(--border-active)   /* rgba(232,154,46,0.25) */
```

---

## 参考文件

- 规范来源分支：`origin/feature/dev_agents`，参考提交 `0d797bb`
- 典型示例：`src/pages/AgentConfig/AgentCreate.tsx` + `AgentCreate.css`
- 当前分支已迁移示例：`src/components/Chat/MessageBubble.tsx` + `MessageBubble.css`
