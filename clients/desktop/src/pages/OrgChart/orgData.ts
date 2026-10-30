export type OrgLevel = 1 | 2 | 3 | 4 | 5

export interface OrgNode {
  id: string
  name: string
  tags: string[]
  memberCount: number
  level: OrgLevel
  parentId: string | null
}

export interface OrgMember {
  id: string
  emoji: string
  name: string
  orgId: string
}

export const LEVEL_COLORS: Record<OrgLevel, string> = {
  1: '#e89a2e',
  2: '#60a5fa',
  3: '#a78bfa',
  4: '#f472b6',
  5: '#4ade80',
}

export const ORG_NODES: OrgNode[] = [
  { id: 'ceo',     name: '决策层', tags: ['核心'],       memberCount: 1, level: 1, parentId: null },
  { id: 'product', name: '产品部', tags: ['产品', '策略'], memberCount: 2, level: 2, parentId: 'ceo' },
  { id: 'tech',    name: '技术部', tags: ['研发', '架构'], memberCount: 3, level: 2, parentId: 'ceo' },
  { id: 'design',  name: '设计部', tags: ['UX', '视觉'],  memberCount: 1, level: 2, parentId: 'ceo' },
  { id: 'data',    name: '数据部', tags: ['分析', 'AI'],  memberCount: 1, level: 2, parentId: 'ceo' },
]

export const ORG_MEMBERS: OrgMember[] = [
  { id: 'a1', emoji: '👑', name: '战略总指挥', orgId: 'ceo' },
  { id: 'a2', emoji: '🧠', name: '产品策略师', orgId: 'product' },
  { id: 'a3', emoji: '📋', name: '需求分析官', orgId: 'product' },
  { id: 'a4', emoji: '👨‍💻', name: '代码审查官', orgId: 'tech' },
  { id: 'a5', emoji: '⚙️', name: '系统架构师', orgId: 'tech' },
  { id: 'a6', emoji: '🔧', name: '后端工程师', orgId: 'tech' },
  { id: 'a7', emoji: '🎨', name: '设计顾问', orgId: 'design' },
  { id: 'a8', emoji: '📊', name: '数据分析师', orgId: 'data' },
]
