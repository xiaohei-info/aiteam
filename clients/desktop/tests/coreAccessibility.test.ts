import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

function readSource(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

const dialogFocusSource = readSource('../src/hooks/useDialogFocus.ts')
const sidebarSource = readSource('../src/components/Layout/Sidebar.tsx')
const panelSource = readSource('../src/components/Layout/Panel.tsx')
const contextMenuSource = readSource('../src/components/Chat/ContextMenu.tsx')
const createGroupSource = readSource('../src/components/Chat/CreateGroupDialog.tsx')
const mentionInputSource = readSource('../src/components/Chat/MentionInput.tsx')
const chatInputSource = readSource('../src/components/Chat/ChatInputBar.tsx')
const attachmentSource = readSource('../src/components/Chat/AttachmentBar.tsx')
const fileChipSource = readSource('../src/components/Chat/FileChip.tsx')
const talentDetailSource = readSource('../src/pages/TalentMarket/TalentDetailPanel.tsx')
const knowledgeDetailSource = readSource('../src/pages/KnowledgeBase/Detail.tsx')
const knowledgeIndexSource = readSource('../src/pages/KnowledgeBase/index.tsx')
const orgChartSource = readSource('../src/pages/OrgChart/index.tsx')
const rechargePromptSource = readSource('../src/components/Billing/RechargePromptDialog.tsx')
const recruitAliasSource = readSource('../src/pages/TalentMarket/RecruitAliasDialog.tsx')
const autoTasksSource = readSource('../src/pages/AutoTasks/index.tsx')

test('dialog focus hook traps Tab and restores the invoking control', () => {
  assert.match(dialogFocusSource, /event\.key !== 'Tab'/)
  assert.match(dialogFocusSource, /focusable\[nextIndex\]\.focus\(\)/)
  assert.match(dialogFocusSource, /returnTarget\?\.isConnected/)
  assert.match(dialogFocusSource, /returnTarget\.focus\(\)/)
})

test('sidebar and conversation panel expose navigation and keyboard context-menu state', () => {
  assert.match(sidebarSource, /aria-label="应用侧栏"/)
  assert.match(sidebarSource, /aria-label="主导航"/)
  assert.match(sidebarSource, /aria-current=\{isActive \? 'page'/)
  assert.match(sidebarSource, /aria-keyshortcuts=\{`Meta\+\$\{index \+ 1\} Control\+\$\{index \+ 1\}`\}/)

  assert.match(panelSource, /e\.key === 'ContextMenu'/)
  assert.match(panelSource, /e\.key === 'F10' && e\.shiftKey/)
  assert.match(panelSource, /aria-current=\{isActive \? 'true'/)
  assert.match(panelSource, /<button[\s\S]*?className="panel-sr-agent"/)
})

test('context menus provide menu semantics, arrow navigation and focus recovery', () => {
  assert.match(contextMenuSource, /role="menu"/)
  assert.match(contextMenuSource, /role="menuitem"/)
  assert.match(contextMenuSource, /'ArrowDown', 'ArrowUp', 'Home', 'End'/)
  assert.match(contextMenuSource, /returnFocusRef/)
})

test('chat composer exposes textbox, attachment and composite-menu semantics', () => {
  assert.match(mentionInputSource, /role="textbox"/)
  assert.match(mentionInputSource, /role="listbox"/)
  assert.match(mentionInputSource, /aria-activedescendant=/)
  assert.match(chatInputSource, /role="separator"/)
  assert.match(chatInputSource, /role="menuitemcheckbox"/)
  assert.match(chatInputSource, /aria-label="发送消息"/)
  assert.match(attachmentSource, /aria-expanded=\{open\}/)
  assert.match(fileChipSource, /aria-label=\{`重试上传 \$\{file\.name\}`\}/)
  assert.match(fileChipSource, /aria-live="polite"/)
})

test('critical dialogs and organization controls use modal focus and native controls', () => {
  assert.match(createGroupSource, /useDialogFocus<HTMLDivElement>/)
  assert.match(createGroupSource, /role="dialog"/)
  assert.match(createGroupSource, /aria-modal="true"/)
  assert.match(createGroupSource, /aria-pressed=\{selected\}/)

  assert.match(talentDetailSource, /useDialogFocus<HTMLElement>/)
  assert.match(talentDetailSource, /role="tablist"/)
  assert.match(talentDetailSource, /role="tabpanel"/)
  assert.match(talentDetailSource, /'ArrowLeft', 'ArrowRight', 'Home', 'End'/)

  assert.match(knowledgeDetailSource, /bindDialogRef = useDialogFocus/)
  assert.match(knowledgeDetailSource, /previewDialogRef = useDialogFocus/)
  assert.match(knowledgeIndexSource, /createDialogRef = useDialogFocus/)
  assert.match(knowledgeIndexSource, /deleteDirectoryDialogRef = useDialogFocus/)

  assert.match(rechargePromptSource, /useDialogFocus<HTMLDivElement>/)
  assert.match(recruitAliasSource, /useDialogFocus<HTMLFormElement>/)
  assert.match(autoTasksSource, /useDialogFocus<HTMLElement>/)

  assert.match(orgChartSource, /<button[\s\S]*?className="oc-member oc-member--clickable"/)
  assert.match(orgChartSource, /aria-label="组织架构缩放控制"/)
  assert.match(orgChartSource, /role="region" aria-label="组织架构图"/)
})
