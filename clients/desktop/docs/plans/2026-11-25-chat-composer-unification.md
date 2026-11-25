# 聊天输入框统一方案（单聊 textarea ↔ 群聊 contentEditable）

- 日期：2026-11-25
- 状态：**未开始**（待排期；不在 `fix/avatar-sync-and-group-paste` 这个 bugfix 分支内实施）
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

同一文件围绕这个判断有 **18 处引用，归为 10 组逻辑**：

| 行 | 用途 |
| --- | --- |
| 116 | `isMentionMode` 定义 |
| 177 / 182–183 | 切换会话时恢复/清空 contentEditable DOM（防草稿串会话） |
| 193 / 195 | 读取当前输入内容（草稿快照） |
| 347 | 提交前的空内容判定 |
| 358–359 | 读取消息（普通发送） |
| 398–399 | 读取消息（发送中排队） |
| 448 | **发送键使能**：`(isMentionMode ? !!mentionText.trim() : !!input.trim())` |
| 535 / 538 | 草稿恢复 |
| 568 / 573 | 高度自适应 / 依赖 |
| 741 / 759 | 渲染分支：`<MentionInput>` / `<textarea>` |

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
