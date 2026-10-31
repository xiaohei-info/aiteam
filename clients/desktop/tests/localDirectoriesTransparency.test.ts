import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8')

test('本地扫描文案如实标注检索格式边界（不再暗示 DOCX/PDF/PPT 可被员工检索）', () => {
  const index = read('src/pages/KnowledgeBase/index.tsx')

  // 旧的扫描文案会把 DOCX/PDF/PPT 与可检索格式混在一起，诱导用户误以为都能被检索
  assert.ok(
    !index.includes('正在扫描 DOCX、Markdown、PDF、CSV、PPT 文件'),
    '扫描提示不再把 DOCX/PDF/PPT 表述为可检索对象',
  )
  // 新文案必须显式说明「员工对话检索仅支持纯文本」与「DOCX/PDF/PPT 仅支持上传」
  assert.ok(index.includes('员工对话检索仅支持纯文本'), '扫描提示包含检索格式边界说明')
  assert.ok(index.includes('仅支持上传'), '扫描提示包含仅上传边界说明')
})

test('扫描结果列表为不可检索格式标注「仅上传」', () => {
  const index = read('src/pages/KnowledgeBase/index.tsx')
  assert.ok(index.includes('isLocalSearchableFile'), '文件行使用 isLocalSearchableFile 判定可检索性')
  assert.ok(index.includes('仅上传'), '不可检索的文件渲染「仅上传」标注')

  const utils = read('src/pages/KnowledgeBase/utils.ts')
  // 与 Agent 侧 FORMATS（.txt/.md/.markdown/.csv/.json/.log）对齐
  for (const ext of ['txt', 'md', 'markdown', 'csv', 'json', 'log']) {
    assert.ok(
      utils.includes(`'${ext}'`),
      `LOCAL_SEARCHABLE_EXTENSIONS 应包含 ${ext}`,
    )
  }
})

test('对话窗口目录授权把 403 转成可行动的中文提示', () => {
  const panel = read('src/components/Chat/localDirectoryErrors.ts')
  const dialog = read('src/components/Chat/ConversationDirectories.tsx')
  assert.ok(
    panel.includes('local_directory_unauthorized'),
    '面板映射 local_directory_unauthorized 错误码',
  )
  assert.ok(
    panel.includes('AITEAM_AGENT_DEV_AUTH'),
    '提示列出开发认证这一可能原因与排查方向',
  )
  assert.ok(
    dialog.includes('localDirectoryApiErrorText'),
    'load/addDirectory 的错误路径统一走 localDirectoryApiErrorText',
  )
})

test('本地目录授权请求发往本机 Agent，不走远端会话服务', () => {
  const facade = read('src/api/agent/index.ts')
  // 授权挑战依赖桌面授权桥接（本机 Unix socket），远端 Agent 无此通道，只会返回 503
  const methods = [
    'supportsLocalDirectories',
    'listLocalDirectories',
    'createLocalDirectoryChallenge',
    'registerLocalDirectory',
    'setLocalDirectoryBinding',
    'revokeLocalDirectory',
    'verifyLocalDirectoryCitation',
  ]
  for (const method of methods) {
    // 条目可能跨行（续行缩进 4 空格），截到下一个两空格缩进的成员为止
    const entry = facade.match(new RegExp(`^  ${method}:[\\s\\S]*?(?=^  \\S)`, 'm'))?.[0]
    assert.ok(entry, `${method} 仍由 agentApi 暴露`)
    assert.ok(entry.includes('getLocalClient()'), `${method} 使用本机 Agent client`)
    assert.ok(!entry.includes('getClient()'), `${method} 不使用远端 client`)
  }
  // 本机 client 不带 resolveBaseUrl，沿用 AgentApiClient 默认的本机地址发现；会话 client 仍指向后台地址
  assert.match(facade, /new AgentApiClient\(\{ getToken: currentToken \}\)/, '本机 client 走默认本机地址发现')
  assert.match(facade, /resolveBaseUrl: resolveBackendBaseUrl/, '会话 client 保持连接后台地址')
})
