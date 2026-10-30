import { useNavigate, useParams } from 'react-router-dom'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  User,
  Settings as SettingsIcon,
  ArrowLeft,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ProfileInfo from './ProfileInfo'
import AgentConfig from '../AgentConfig'
import KnowledgeBase from '../KnowledgeBase'
import SkillCenter from '../SkillCenter'
import Settings from '../Settings'
import TopBar from '../../components/Layout/TopBar'

type TabKey = 'profile' | 'agents' | 'knowledge' | 'skills' | 'settings'

const TABS: { key: TabKey; icon: LucideIcon; label: string }[] = [
  { key: 'profile', icon: User, label: '个人资料' },
  // { key: 'agents', icon: Bot, label: '智能体' },
  // { key: 'knowledge', icon: BookOpen, label: '知识库' },
  // { key: 'skills', icon: Puzzle, label: '技能中心' },
  { key: 'settings', icon: SettingsIcon, label: '设置' },
]

const TAB_COMPONENTS: Record<TabKey, React.ComponentType> = {
  profile: ProfileInfo,
  agents: AgentConfig,
  knowledge: KnowledgeBase,
  skills: SkillCenter,
  settings: Settings,
}

function isTabKey(tab: string | undefined): tab is TabKey {
  return Boolean(tab && Object.prototype.hasOwnProperty.call(TAB_COMPONENTS, tab))
}

export default function Profile() {
  const { tab } = useParams<{ tab?: string }>()
  const activeTab: TabKey = isTabKey(tab) ? tab : 'profile'
  const navigate = useNavigate()

  const ActiveComponent = TAB_COMPONENTS[activeTab]

  const handleTabChange = (key: TabKey) => {
    navigate(key === 'profile' ? '/profile' : `/profile/${key}`)
  }

  return (
    <div className="app-page-bg flex h-[100dvh] overflow-hidden">
      {/* Left sidebar */}
      <aside className="relative flex flex-col w-[220px] border-r border-[var(--border)] bg-surface-1 pt-4">
        {/* Window controls */}
        <div data-tauri-drag-region className="flex items-center gap-[7px] px-[18px] mb-4 h-10">
          <button
            onClick={() => getCurrentWindow().close()}
            className="w-[12px] h-[12px] rounded-full bg-[#ff5f57] hover:bg-[#ff3b30] transition-colors duration-150 cursor-pointer border border-[#e0443e]/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
            title="关闭"
          />
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="w-[12px] h-[12px] rounded-full bg-[#febc2e] hover:bg-[#f5a623] transition-colors duration-150 cursor-pointer border border-[#dea123]/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
            title="最小化"
          />
          <button
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="w-[12px] h-[12px] rounded-full bg-[#28c840] hover:bg-[#1db934] transition-colors duration-150 cursor-pointer border border-[#1aab29]/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
            title="最大化"
          />
        </div>

        {/* Back button */}
        <div className="px-[10px] mb-4">
          <button
            onClick={() => navigate(-1)}
            className="flex items-center w-full h-10 rounded-[12px] gap-3 px-[11px] text-txt-muted hover:bg-surface-2 hover:text-txt-secondary transition-colors duration-200"
          >
            <ArrowLeft size={18} strokeWidth={1.8} />
            <span className="text-[13px] font-medium">返回应用</span>
          </button>
        </div>

        {/* Nav tabs */}
        <nav className="flex flex-1 flex-col gap-0.5 px-[10px]">
          {TABS.map((item) => {
            const isActive = activeTab === item.key
            const Icon = item.icon
            return (
              <button
                key={item.key}
                onClick={() => handleTabChange(item.key)}
                className={`relative flex items-center w-full h-10 rounded-[12px] gap-3 px-[11px] transition-colors duration-200 ${
                  isActive
                    ? 'bg-surface-3/80 text-brand-300'
                    : 'text-txt-muted hover:bg-surface-2 hover:text-txt-secondary'
                }`}
              >
                {isActive && (
                  <span className="absolute -left-[9px] h-5 w-[3px] rounded-r-full bg-brand animate-slide-in-left" />
                )}
                <Icon size={18} strokeWidth={1.8} />
                <span className="text-[13px] font-medium">{item.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      {/* Right content */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <TopBar />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ActiveComponent />
        </div>
      </main>
    </div>
  )
}
