import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ELEMENT_NODE, TEXT_NODE, extractMentionText, type RichTextNodeLike } from '../src/components/Chat/mentionRichText.ts'

// 回归：群聊输入框粘贴内容后发送按钮保持禁用。
// 浏览器粘贴多行/富文本会插入 <div>/<p>/<br>（不是顶层文本节点），旧的 extract 只遍历顶层
// childNodes，展开出空文本 → ChatInputBar 的 hasComposerContent 为 false → 发送键变灰。
const text = (value: string): RichTextNodeLike => ({ nodeType: TEXT_NODE, childNodes: [], textContent: value })
const el = (tagName: string, children: RichTextNodeLike[], dataset?: Record<string, string>): RichTextNodeLike => ({
  nodeType: ELEMENT_NODE,
  childNodes: children,
  tagName,
  dataset,
})
const root = (...children: RichTextNodeLike[]): RichTextNodeLike => el('DIV', children)

test('顶层纯文本仍按原样展开', () => {
  assert.deepEqual(extractMentionText(root(text('你好'))), { text: '你好', mentions: [] })
})

test('粘贴的单行 <div> 文本不再被丢弃', () => {
  const pasted = root(el('DIV', [text('请帮我看下这个审批单')]))
  assert.equal(extractMentionText(pasted).text.trim(), '请帮我看下这个审批单')
})

test('粘贴的多行内容按行拆分，不会被拼成一行', () => {
  const pasted = root(el('DIV', [text('第一行')]), el('DIV', [text('第二行')]), el('DIV', [text('第三行')]))
  const { text: result } = extractMentionText(pasted)
  assert.equal(result.trim(), '第一行\n第二行\n第三行')
})

test('<br> 折行与嵌套 <span> 都能展开', () => {
  const pasted = root(
    el('SPAN', [text('A')]),
    el('BR', []),
    el('SPAN', [el('B', [text('B')])]),
    el('BR', []),
    el('P', [text('C')]),
  )
  assert.equal(extractMentionText(pasted).text.trim(), 'A\nB\nC')
})

test('深层嵌套里的 @ 成员标签仍被识别并收集 id', () => {
  const mentionChip = el('SPAN', [text('@张三')], { mentionId: 'm-1', mentionName: '张三' })
  const pasted = root(el('DIV', [text('请 '), mentionChip, text(' 看一下')]))
  const { text: result, mentions } = extractMentionText(pasted)
  assert.equal(result.trim(), '请 @张三 看一下')
  assert.deepEqual(mentions, ['m-1'])
})

test('空输入框展开为空文本（发送键仍应禁用）', () => {
  assert.deepEqual(extractMentionText(root(el('BR', []))), { text: '', mentions: [] })
})

// MentionInput 侧的结构断言：粘贴必须只取纯文本，避免富文本/脏结构进入 contentEditable。
const source = readFileSync(new URL('../src/components/Chat/MentionInput.tsx', import.meta.url), 'utf8')
// 粘贴与拖入共用 insertPlainText（插入 + emit），从它开始截取到 handleKeyDown 覆盖整条粘贴链路。
const pasteStart = source.indexOf('const insertPlainText = useCallback')
assert.ok(pasteStart > 0, '找不到 MentionInput.insertPlainText')
assert.ok(source.indexOf('const handlePaste = useCallback') > pasteStart, '找不到 MentionInput.handlePaste')
const pasteBody = source.slice(pasteStart, source.indexOf('const handleKeyDown = useCallback', pasteStart))

test('contentEditable 绑定了 onPaste 处理器', () => {
  assert.ok(source.includes('onPaste={handlePaste}'), 'MentionInput 未绑定 onPaste，粘贴会走浏览器默认富文本插入')
})

test('handlePaste 只接受 text/plain 并阻止默认插入', () => {
  assert.ok(pasteBody.includes("getData('text/plain')"), 'handlePaste 应读取 text/plain')
  assert.ok(pasteBody.includes('e.preventDefault()'), 'handlePaste 应阻止默认 HTML 插入')
  assert.ok(pasteBody.includes('emit(el)'), 'handlePaste 结束后必须回调 onChange，否则发送键判定不到内容')
})

test('展开逻辑已抽到可测的纯函数（递归遍历子树）', () => {
  assert.ok(source.includes('extractMentionText'), 'MentionInput 应复用 mentionRichText.extractMentionText')
  assert.equal(
    /for \(const node of Array\.from\(el\.childNodes\)\)/.test(source),
    false,
    '仍存在只遍历顶层 childNodes 的展开实现',
  )
})

test('连续 <br> 保留空行，块末尾占位 <br> 不多出一行', () => {
  const br = () => el('BR', [])
  assert.equal(extractMentionText(root(text('a'), br(), br(), text('b'))).text, 'a\n\nb')
  assert.equal(extractMentionText(root(text('a'), el('DIV', [br()]), el('DIV', [text('b')]))).text, 'a\n\nb')
  assert.equal(extractMentionText(root(el('DIV', [text('a'), br()]), el('DIV', [text('b')]))).text, 'a\nb')
  assert.equal(extractMentionText(root(el('DIV', [text('a')]), el('DIV', [text('b')]))).text, 'a\nb')
  assert.equal(extractMentionText(root(el('DIV', [br()]), el('DIV', [text('b')]))).text, '\nb')
  assert.equal(extractMentionText(root(text('a'), br())).text, 'a')
})
