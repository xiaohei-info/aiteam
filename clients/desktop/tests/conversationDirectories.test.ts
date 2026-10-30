import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = (relativePath: string) => fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf-8')

test('对话窗口内可直接授权目录并绑定当前员工，不依赖企业 Manager / NAS 连接', () => {
  const component = read('src/components/Chat/ConversationDirectories.tsx')
  assert.ok(component.includes('select_local_knowledge_directory'), '复用桌面原生选择器签发票据')
  assert.ok(component.includes('registerLocalDirectory') && component.includes('setLocalDirectoryBinding'), '注册目录后立即绑定当前员工')
  // 只走本机 Agent 的本地目录接口，不得引入远端知识库/Manager 通道。
  assert.ok(!component.includes('readKnowledgeSourceConfig'), '不检查企业知识库连接配置')
  assert.ok(!component.includes('backendApi'), '不请求远端后端')
})

test('权限面板把目录授权挂在对话窗口，且仅私聊可检索', () => {
  const permissions = read('src/components/Chat/ConversationPermissions.tsx')
  const logic = read('src/lib/conversationPermissions.ts')
  assert.ok(permissions.includes('<ConversationDirectories'), '权限面板渲染目录授权一段')
  assert.ok(permissions.includes('directoryEmployeeIdOf'), '入口员工的判定走共享纯逻辑')
  assert.ok(logic.includes("metadata.kind !== 'group'"), '只排除群聊；自动化任务的 private 会话也展示')
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
  assert.ok(directories.includes('群聊暂不支持目录检索') && permissions.includes("metadata?.kind === 'group'"), '群聊目录段置灰并说明，不隐藏')
})
