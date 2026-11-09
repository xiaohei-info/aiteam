import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8')

test('对话窗口内可直接授权目录并绑定当前员工，不依赖企业 Manager / NAS 连接', () => {
  const component = read('src/components/Chat/ConversationDirectories.tsx')
  assert.ok(component.includes('select_local_knowledge_directory'), '复用桌面原生选择器签发票据')
  assert.ok(component.includes('registerLocalDirectory') && component.includes('setLocalDirectoryBinding'), '注册目录后立即添加到本会话')
  // 只走本机 Agent 的本地目录接口，不得引入远端知识库/Manager 通道。
  assert.ok(!component.includes('readKnowledgeSourceConfig'), '不检查企业知识库连接配置')
  assert.ok(!component.includes('backendApi'), '不请求远端后端')
})

test('权限面板把目录授权挂在对话窗口，私聊和群聊都能添加目录', () => {
  const permissions = read('src/components/Chat/ConversationPermissions.tsx')
  const logic = read('src/lib/conversationPermissions.ts')
  assert.ok(permissions.includes('<ConversationDirectories'), '权限面板渲染目录授权一段')
  assert.ok(!logic.includes('directoryEmployeeIdOf') && !permissions.includes('directoryEmployeeIdOf'), '目录归会话，不再判定入口员工')
  assert.ok(!logic.includes("kind === 'chat'") && !permissions.includes("kind === 'chat'"), '不能只认 chat，否则 private 私聊会丢失入口')
})

test('聊天输入区只保留一个权限入口，完全访问仍走三项勾选确认', () => {
  const permissions = read('src/components/Chat/ConversationPermissions.tsx')
  const directories = read('src/components/Chat/ConversationDirectories.tsx')
  assert.ok(!permissions.includes('允许完全访问'), '去掉独立的「允许完全访问」开关')
  assert.ok(!directories.includes('cdir-trigger'), '去掉独立的「授权目录」按钮')
  assert.ok(permissions.includes('aria-haspopup="dialog"') && permissions.includes('aria-expanded={open}'), '权限按钮声明弹出面板与展开状态')
  assert.ok(permissions.includes('useDialogFocus') && permissions.includes("event.key === 'Escape'") && permissions.includes('useGlobalShortcutClose'), '面板有焦点管理、Esc 与 ⌘W 关闭')
  assert.ok(permissions.includes('accepted.every(Boolean)'), '三项全部勾选才能开启完全访问')
  assert.ok(!directories.includes('群聊暂不支持添加目录'), '群聊也能添加目录')
  assert.ok(permissions.includes('全群共用的文件夹'), '群聊工作目录标明全群共用')
})

test('检索目录按会话开关：绑定带会话 ID，列表按会话读取，草稿会话先建会话', () => {
  const api = read('src/api/agent/localDirectories.ts')
  const component = read('src/components/Chat/ConversationDirectories.tsx')
  const permissions = read('src/components/Chat/ConversationPermissions.tsx')
  assert.ok(api.includes('/api/agent/conversations/${encodeURIComponent(conversationId)}/local-directories/'), '绑定接口挂在会话下')
  assert.ok(!api.includes('${base}/${encodeURIComponent(directoryId)}/bindings/'), '不再有按员工生效的绑定路径')
  assert.ok(api.includes('conversation_id: conversationId'), '列表带会话 ID，只返回本会话的开关')
  assert.ok(permissions.includes('useConversationDirectories(conversationId, ensureConversation)'), '面板按当前会话加载')
  assert.equal((component.match(/await ensureConversation\(\)/g) ?? []).length, 2, '开关和添加目录前都先确保会话已创建')
  assert.ok(!component.includes('员工可检索的目录') && !component.includes('对当前员工生效'), '不再暗示对员工的所有会话生效')
})

test('工作目录和本会话添加的目录合在「本会话的目录」一区，权限三档放在下面并对所有目录生效', () => {
  const component = read('src/components/Chat/ConversationDirectories.tsx')
  const permissions = read('src/components/Chat/ConversationPermissions.tsx')
  const folders = permissions.indexOf('本会话的目录')
  const workspace = permissions.indexOf('工作目录', folders)
  const added = permissions.indexOf('<ConversationDirectories', folders)
  const modes = permissions.indexOf('>本会话的权限<')
  assert.ok(folders >= 0 && folders < workspace && workspace < added && added < modes, '目录区：工作目录在前，添加的目录在后，权限在目录区下面')
  // 移除只关掉本会话的绑定，不撤销成员级授权（那会影响所有会话）。
  assert.ok(!component.includes('revokeLocalDirectory'), '移除不撤销授权')
  assert.ok(component.includes('setLocalDirectoryBinding(id, directory.directory_id, false, binding.revision)'), '移除 = 本会话关闭绑定')
  // 列表只展示本会话开着的目录，不展示其他会话的目录或开关。
  assert.ok(component.includes('directory.binding?.enabled') && !component.includes('role="switch"'), '没有开关，只展示本会话添加的目录')
})
