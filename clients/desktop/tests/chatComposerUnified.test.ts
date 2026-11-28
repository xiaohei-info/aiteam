import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 结构守卫：单聊与群聊共用同一个 MentionInput（方案 A，见 docs/plans/2026-11-25-chat-composer-unification.md）。
// 回退成「单聊 textarea + 群聊 contentEditable」两套实现时，粘贴/发送使能/草稿等修复会再次只修一边。
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const bar = read('../src/components/Chat/ChatInputBar.tsx')
const mention = read('../src/components/Chat/MentionInput.tsx')
const hook = read('../src/components/Chat/useComposerValue.ts')

test('ChatInputBar 只渲染一个 MentionInput，不再有 textarea 分支', () => {
  assert.doesNotMatch(bar, /<textarea\b/)
  assert.doesNotMatch(bar, /isMentionMode/)
  assert.equal(bar.match(/<MentionInput\b/g)?.length, 1)
  assert.match(bar, /members=\{mentionMembers\}/)
  assert.match(bar, /const mentionMembers = members \?\? \[\]/)
})

test('取值、发送使能、清空、放回都只经过 useComposerValue', () => {
  assert.match(bar, /const composer = useComposerValue\(draft \?\? ''\)/)
  assert.match(bar, /onChange=\{composer\.handleChange\}/)
  assert.match(bar, /const hasComposerContent = !!composer\.text\.trim\(\) \|\| pendingFiles\.length > 0/)
  assert.doesNotMatch(bar, /setInput\(|mentionTextRef|textareaRef/)
  assert.match(hook, /export function useComposerValue/)
})

test('MentionInput 支持空成员列表：无 @ 菜单语义，占位文字不依赖 :empty', () => {
  assert.match(mention, /aria-autocomplete=\{members\.length > 0 \? 'list' : undefined\}/)
  assert.match(mention, /el\.dataset\.empty = /)
  const css = read('../src/components/Chat/MentionInput.css')
  assert.match(css, /\.mention-input\[data-empty="true"\]::before/)
  // setText/clear/restore 都要回调 onChange，父组件的取值与 DOM 才不会脱节。
  const handle = mention.slice(mention.indexOf('useImperativeHandle('), mention.lastIndexOf('getScrollHeight:'))
  for (const method of ['clear:', 'setText:', 'restore:']) {
    const body = handle.slice(handle.indexOf(method), handle.indexOf('\n    },', handle.indexOf(method)))
    assert.match(body, /emit\(/, `${method} 未回调 onChange`)
  }
})
