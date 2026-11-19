import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSkillImportRequest, clawHubCandidateUrl, resetCheckState } from '../src/lib/skillImportRequest.ts';

test('请求体只带当前来源需要的字段', () => {
  const base = { path: '/tmp/skill', text: '---\nname: x\n---', url: 'https://clawhub.ai/a/skills/b', roots: ['skill-a'] };

  assert.deepEqual(buildSkillImportRequest({ source: 'folder', ...base }, { preview: true }), {
    source: 'folder', preview: true, path: '/tmp/skill', roots: ['skill-a'],
  });
  assert.deepEqual(buildSkillImportRequest({ source: 'zip', ...base }, { preview: false }), {
    source: 'zip', preview: false, path: '/tmp/skill', roots: ['skill-a'],
  });
  // 粘贴来源：不再把已清空的文本框当成内容提交，也不带 path / url。
  assert.deepEqual(buildSkillImportRequest({ source: 'text', ...base, text: '' }, { preview: false }), {
    source: 'text', preview: false,
  });
  assert.deepEqual(buildSkillImportRequest({ source: 'text', ...base }, { preview: true }), {
    source: 'text', preview: true, skill_md: base.text,
  });
  // 网址 / ClawHub：不带 path，也不带文件夹扫出来的 roots。
  assert.deepEqual(buildSkillImportRequest({ source: 'url', ...base }, { preview: true }), {
    source: 'url', preview: true, url: base.url,
  });
  assert.deepEqual(buildSkillImportRequest({ source: 'clawhub', ...base }, { preview: false }), {
    source: 'clawhub', preview: false, url: base.url,
  });
  // 单个 .md 文件不是「包」，不该带 roots。
  assert.deepEqual(buildSkillImportRequest({ source: 'file', ...base }, { preview: false }), {
    source: 'file', preview: false, path: '/tmp/skill',
  });
});

test('换来源时检查状态清空', () => {
  const fresh = resetCheckState();
  assert.equal(fresh.preview, null);
  assert.equal(fresh.scan, null);
  assert.deepEqual(fresh.picked, []);
  assert.equal(fresh.clawHub, null);
});

test('ClawHub 候选拼成带作者的地址', () => {
  assert.equal(clawHubCandidateUrl('octocat', 'demo'), 'https://clawhub.ai/octocat/skills/demo');
});
