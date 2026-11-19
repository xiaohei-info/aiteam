import assert from 'node:assert/strict';
import { test } from 'node:test';

import { capabilityGrantSourceLabel, groupCapabilityGrants } from '../src/lib/capabilityGrantLabels.ts';
import { isWaitingSignIn, pickCurrent, queuePosition, visibleQueue, type QueueEntry } from '../src/lib/approvalQueue.ts';

const entry = (approvalId: string, conversationId: string, phase = 'pending'): QueueEntry => ({ approvalId, conversationId, phase });

test('同一会话的多条待批合并为一个队列，一次显示一条', () => {
  const pending = [entry('a1', 'c1'), entry('a2', 'c1'), entry('a3', 'c2')];
  assert.deepEqual(visibleQueue(pending, 'c1').map((item) => item.approvalId), ['a1', 'a2']);
  assert.equal(pickCurrent(pending)?.approvalId, 'a1');
  assert.deepEqual(queuePosition(pending, entry('a2', 'c1')), { index: 2, total: 2 });
  assert.deepEqual(queuePosition(pending, entry('a1', 'c1')), { index: 1, total: 2 });
  assert.deepEqual(queuePosition(pending, entry('a3', 'c2')), { index: 1, total: 1 });
});

test('不同会话各自成队列：取最早出现的会话', () => {
  const pending = [entry('a1', 'c1'), entry('b1', 'c2'), entry('a2', 'c1')];
  assert.equal(pickCurrent(pending)?.approvalId, 'a1');
});

test('等浏览器登录的条目不挡住新来的审批', () => {
  const pending = [entry('s1', 'c1', 'signing_in'), entry('n1', 'c1')];
  assert.equal(isWaitingSignIn(pending[0]!), true);
  assert.equal(pickCurrent(pending)?.approvalId, 'n1');
  // 只有 signing_in 时仍然显示它，不让弹窗消失。
  assert.equal(pickCurrent([entry('s1', 'c1', 'signing_in')])?.approvalId, 's1');
});

test('空队列不报错', () => {
  assert.equal(pickCurrent([]), undefined);
  assert.deepEqual(visibleQueue([], 'c1'), []);
});

test('能力授权来源标签翻成用户可读文案', () => {
  assert.equal(capabilityGrantSourceLabel('platform_catalog'), '平台目录');
  assert.equal(capabilityGrantSourceLabel('enterprise_catalog'), '企业目录');
  assert.equal(capabilityGrantSourceLabel('clawhub_catalog'), 'ClawHub');
  assert.equal(capabilityGrantSourceLabel('user_import'), '本机导入');
  assert.equal(capabilityGrantSourceLabel('user_url'), '本机导入');
  assert.equal(capabilityGrantSourceLabel(''), '本机导入');
});

test('能力授权按会话分组', () => {
  const grants = [
    { conversation_id: 'c1', kind: 'mcp', ref: 'a', source: 'platform_catalog' },
    { conversation_id: 'c1', kind: 'skill', ref: 'b', source: 'enterprise_catalog' },
    { conversation_id: 'c2', kind: 'mcp', ref: 'c', source: 'clawhub_catalog' },
  ];
  const grouped = groupCapabilityGrants(grants);
  assert.deepEqual([...grouped.keys()], ['c1', 'c2']);
  assert.deepEqual(grouped.get('c1')!.map((item) => item.ref), ['a', 'b']);
  assert.deepEqual(groupCapabilityGrants([]).size, 0);
});
