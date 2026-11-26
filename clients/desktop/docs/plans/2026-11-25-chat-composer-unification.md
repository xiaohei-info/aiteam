# 聊天输入框统一方案（单聊 textarea ↔ 群聊 contentEditable）

- 日期：2026-11-25
- 状态：**已实施方案 A**（2026-11-26，分支 `feat/desktop-chat-composer-unify`，基于 `fix/avatar-sync-and-group-paste`；实施记录见 §9）
- 触发问题：群聊粘贴富文本后发送键变灰（已修，见 `docs/部署运维/2026-11-25-头像三端同步与群聊粘贴发送键排查复盘.md`）
- 结论：**应该统一**，推荐方案 A（单 contentEditable 实现 + 可选 mention）。桌面端是 outlier，`web/agent` 早已统一。

---

## 1. 现状：桌面端是两套实现

`clients/desktop/src/components/Chat/ChatInputBar.tsx:116`

```ts
const isMentionMode = members !== undefined && members.length > 0
```

- `isMentionMode === true`（群聊，有成员列表）→ `<MentionInput>`：`contentEditable`，支持 `@` 成员 chip；
- `isMentionMode === false`（单聊）→ 受控 `<textarea value={input} onChange={e => setInput(e.target.value)}>`。

同一文件围绕这个判断有 **16 行引用，归为 10 组逻辑**（行号按 `dc32beeb` 核对；实施前快照）：

| 行 | 用途 |
| --- | --- |
| 116 | `isMentionMode` 定义 |
| 177 / 182–183 | 切换会话时恢复/清空 contentEditable DOM（防草稿串会话） |
| 193 / 195 | 读取当前输入内容（草稿快照） |
| 347 | 提交前的空内容判定 |
| 359 | 读取消息（普通发送） |
| 398–399 | 读取消息（发送中排队） |
| 448 | **发送键使能**：`(isMentionMode ? !!mentionText.trim() : !!input.trim())` |
| 535 / 538 | 草稿恢复 |
| 568 / 573 | 高度自适应 / 依赖 |
| 741 | 渲染分支：`<MentionInput>` / `<textarea>` |

## 2. 为什么当初会分叉

不是随手写的，是功能驱动：

- 群聊需要 `@` 成员 chip。chip 是「员工 id ↔ 展示名」的**结构化 token**，要能原子删除、不能被光标劈开、要参与 mention 提交（`mentions: employeeId[]`）。
- `<textarea>` 里只有纯文本，做不了内联 chip，也无法可靠区分「正文里的 @ 字样」与「真正的 mention」。
- 单聊没有 mention 需求，最省事的实现就是 textarea。

问题在于：这个分叉被固化成「**两个组件**」，而不是「**一个组件 + 可选能力**」。

## 3. 分叉的真实代价

| 代价 | 具体表现 |
| --- | --- |
| 粘贴行为两套 | textarea 走浏览器原生（写 value → input → onChange）；contentEditable 手写 `extract` 提取文本。群聊粘贴 bug 只可能出在后者 |
| 发送使能逻辑重复 | `isMentionMode ? !!mentionText.trim() : !!input.trim()`，任何一侧漏改就两端不一致 |
| 草稿/队列/清空/高度各写一遍 | 177/193/347/358/535/568 行成对出现 |
| 测试覆盖不对称 | 群聊有 `tests/mentionInputPaste.test.ts`、`tests/chat-paste-smoke.html`；单聊直到 2026-11-25 才有 `tests/chat-paste-real-clipboard.mjs` 覆盖 |
| 缺陷修复只修一边 | 2026-11-18 `3b299305` 修了群聊 `handleInput` 的 selection 早退；2026-11-25 `6cc2e112` 才补上同一组件里的第二条路径（`extract` 只看顶层 childNodes） |

## 4. 参照：web/agent 已经是统一实现

`web/agent/src/features/chat/MessageComposer.tsx`

```tsx
// :92
mentionRoster?: MentionRosterExpert[]
// :499 单聊与群聊渲染同一个 ChatComposerInput
<ChatComposerInput
  value={content}
  triggers={mentionTriggers}
  onChange={setContent}
  ...
/>
```

单聊只是不传 `mentionRoster`（`triggers` 为空），组件本身不分叉。桌面端是唯一的两套实现。

## 5. 可选路线

### 方案 A（推荐）：单 contentEditable 实现 + 可选 mention

- 把 `MentionInput` 泛化成「成员列表可选」：单聊传 `members=[]`，`@` 触发菜单不出现；
- 把「文本提取（`extractMentionText`）+ 发送使能 + 粘贴策略 + IME 合成处理 + 草稿快照」收敛到一个 hook（如 `useComposerValue`）；
- `ChatInputBar` 里 10 组 `isMentionMode` 分支清零，只留渲染层差异（placeholder、工具条按钮）。

收益：以后粘贴 / IME / 撤销 / 草稿 / 无障碍只改一处。
代价与风险：contentEditable 的**撤销栈**、**输入法合成**（`compositionstart/end`）、**无障碍语义**（`role="textbox"`、`aria-multiline`）、移动端软键盘都要重新回归；跨应用粘贴的 DOM 结构差异需要继续用 `extractMentionText` 兜住。

### 方案 B（不建议）：统一回 textarea

群聊 mention 退化为纯文本 `@名称`，提交时从文本解析成员。

代价：丢失 chip 的原子删除与高亮；重名场景有歧义；`@` 编辑体验退化；仍需一个解析器去猜「这是不是 mention」，本质是把确定性换成了启发式。

### 方案 C（折中，最小改动）：保留两个组件，抽共享层

把「文本提交 + 发送使能 + 粘贴策略」抽成共享 hook / 工具函数，双实现只保留渲染层。

收益：风险最低，能立刻消除「只修一边」的大类问题。
代价：仍存在两套 DOM 行为（撤销栈、IME、a11y 仍各测一遍），长期仍需 A。

## 6. 建议的落地顺序（若采纳 A）

1. 抽 `useComposerValue`（提取 + 使能 + 粘贴 + IME），先用它重写 `MentionInput`，行为与现状逐条对齐（含本次 `extractMentionText` 的换行规则）；
2. 让单聊也渲染 `MentionInput`（`members=[]`），`ChatInputBar` 的 10 组分支降到 0；
3. 补回归：真实剪贴板（`tests/chat-paste-real-clipboard.mjs` 增加单聊/群聊同源用例）、IME 合成、撤销/重做、草稿跨会话、空内容发送键禁用、长文本高度自适应；
4. 保结构守卫测试：断言 `ChatInputBar` 不再出现 `isMentionMode` 渲染分支，避免回退。

## 7. 验收标准

- 单聊与群聊共用同一个输入组件实例类型；
- `ChatInputBar` 中不再有 `isMentionMode ? ... : ...` 的取值/使能分支；
- 真实剪贴板粘贴（`text/html` + `text/plain`）在单聊/群聊均能正确提取多行文本并启用发送键；
- 输入法合成期间不误发、不丢字；
- 草稿切换会话不串内容；
- 既有群聊 mention 行为（chip 原子删除、提交携带 `mentions`）无回归。

## 8. 明确不在本方案范围

- 不做「单聊也支持 @ 成员」的产品能力变更（只是组件统一，单聊仍不展示 mention 菜单）；
- 不改消息协议 / 后端接口；
- 不顺手改发送按钮的视觉与工具栏布局。

## 9. 实施记录（2026-11-26）

### 改动

| 文件 | 内容 |
| --- | --- |
| `src/components/Chat/useComposerValue.ts`（新） | 唯一取值来源：`valueRef`（事件回调同步读）+ `text`（渲染用）；`handleChange / setText / clear / snapshot / restore / focus / insertText / getScrollHeight` |
| `src/components/Chat/ChatInputBar.tsx` | 删除 `<textarea>` 分支、`input/setInput`、`mentionTextRef/mentionText`、`textareaRef`、`prevMentionModeRef`、`isComposingRef`、`isMentionMode`；单聊传 `members ?? []`；读取/清空/失败放回/排队编辑/语音插入都走 `composer`；高度改为随 `composer.text` 的 layout effect |
| `src/components/Chat/MentionInput.tsx` | `emit(el)` = `extract` + 空态标记 + `onChange`，所有改内容的路径（输入、粘贴、插 chip、删 chip、`setText`、`clear`、`restore`、`insertText` 兜底）统一经过它；`setText` 现在也回调 `onChange`；无成员时不声明 `aria-autocomplete`；补 `autoCorrect/autoCapitalize="off"`（与原 textarea 一致） |
| `MentionInput.css` / `pages/Chat/Chat.css` | 占位文字同时认 `:empty` 与 `[data-empty="true"]`（全删后 contentEditable 会留下占位 `<br>`，`:empty` 失效）；hero 占位字号/颜色同步到 contentEditable |

### 与原单聊 textarea 的行为差异（已知、有意）

- 语音转写插入：原单聊直接拼接，现在与群聊一致——前面已有非空白内容时补一个空格。
- 输入区下沿少 6px：textarea 是行内元素，下方有基线空隙；现在单聊与群聊间距一致。字号、行高、颜色、占位样式、宽高经计算样式对比完全一致。
- 群聊成员异步加载（`members` 从 `[]` 变为非空）时不再切换组件，已输入内容不会被重置为草稿。

### 验证

- 结构守卫：`tests/chatComposerUnified.test.ts`（无 `<textarea>`、无 `isMentionMode`、只有一个 `<MentionInput>`、取值/使能走 `useComposerValue`、`setText/clear/restore` 均回调 `onChange`、空态占位）；`mentionInputPaste` / `mentionRichText` / `chatComposerRestore` 守卫同步改为认 `emit(el)` / `composer.clear()`。
- 浏览器冒烟：`tests/chat-composer-unified-smoke.mjs` + `tests/chat-composer-smoke.html`（Vite 1437 + Chrome CDP 9238），单聊/群聊各跑同一组：占位、发送键使能、Shift+Enter 换行 / Enter 发送、IME 合成期间回车不发送、Cmd+Z 撤销、全删后占位恢复、20 行长文本高度封顶 240 且发送键 `elementFromPoint` 命中、切会话草稿不串、发送失败原样放回（含 chip）、群聊 mentions 提交 / 单聊不弹 @ 菜单、真实剪贴板（`text/html` + `text/plain`）粘贴；另有 1440×640 小窗口与 hero 截图。
- 原有 `tests/chat-paste-real-clipboard.mjs`（单聊断言改为 contentEditable）与 `tests/chat-paste-browser-smoke.mjs` 通过。
- 未验证：真机 Tauri WebView（macOS WKWebView）下的输入法、撤销与粘贴；移动端软键盘（桌面端不涉及）。
