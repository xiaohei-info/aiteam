import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  formatUnreadCount,
  getConversationUnreadCount,
  sumConversationUnreadCounts,
  type ConversationUnreadState,
} from '../src/lib/conversationUnread.ts'

for (const kind of ['单聊', '群聊']) {
  test(`${kind}：列表未显示的不可用计数不会在 Tab 中残留 1`, () => {
    const conversation = { unread: 1, summaryAvailability: { unreadCount: false } }
    assert.equal(getConversationUnreadCount(conversation), undefined)
    assert.equal(sumConversationUnreadCounts([conversation]), 0)
  })

  test(`${kind}：新消息、已读清零、刷新和删除后 Tab 等于列表未读之和`, () => {
    let conversations: ConversationUnreadState[] = [{ unread: 2 }, { unread: 1 }]
    const check = (expected: number) => {
      assert.equal(sumConversationUnreadCounts(conversations), expected)
      assert.equal(sumConversationUnreadCounts(conversations), conversations.reduce(
        (sum, conversation) => sum + (getConversationUnreadCount(conversation) ?? 0), 0,
      ))
    }
    check(3)
    conversations = [{ unread: 3 }, conversations[1]]
    check(4)
    conversations = [{ unread: undefined, summaryAvailability: { unreadCount: true } }, conversations[1]]
    check(1)
    conversations = [conversations[0], { unread: 0, summaryAvailability: { unreadCount: true } }]
    check(0)
    conversations = []
    check(0)
  })
}

test('未知值和非法计数不参与汇总，已读或占位会话不会产生徽标', () => {
  for (const unread of [-1, NaN, Infinity, 1.5]) {
    assert.equal(getConversationUnreadCount({ unread }), undefined)
    assert.equal(sumConversationUnreadCounts([{ unread }]), 0)
  }
  assert.equal(getConversationUnreadCount({}), 0)
  assert.equal(getConversationUnreadCount({ unread: 0 }), 0)
  assert.equal(getConversationUnreadCount({ summaryAvailability: { unreadCount: false } }), undefined)
})

test('汇总使用真实数量，列表和 Tab 只在展示时截断为 99+', () => {
  assert.equal(sumConversationUnreadCounts([{ unread: 100 }, { unread: 2 }]), 102)
  assert.equal(formatUnreadCount(99), '99')
  assert.equal(formatUnreadCount(100), '99+')
  assert.equal(formatUnreadCount(102), '99+')
})

test('单聊群聊列表与 Tab 均接入共享未读规则', () => {
  const panel = readFileSync(new URL('../src/components/Layout/Panel.tsx', import.meta.url), 'utf8')
  const sidebar = readFileSync(new URL('../src/components/Layout/Sidebar.tsx', import.meta.url), 'utf8')
  const badge = readFileSync(new URL('../src/components/Layout/ConversationUnreadBadge.tsx', import.meta.url), 'utf8')
  assert.match(panel, /<ConversationUnreadBadge conversation=\{conv\}/)
  assert.match(panel, /<ConversationUnreadBadge conversation=\{group\}/)
  assert.match(sidebar, /sumConversationUnreadCounts\(conversations\)/)
  assert.match(sidebar, /sumConversationUnreadCounts\(groups\)/)
  assert.match(badge, /getConversationUnreadCount\(conversation\)/)
  assert.match(badge, /if \(count === 0\) return null/)
})
