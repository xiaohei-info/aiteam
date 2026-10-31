export interface Skill {
  id: string
  name: string
  description: string
  icon: string
  category: string
  author: string
  usageCount: number
  rating: number
  tags: string[]
  createdAt: string
  isOwned?: boolean
}

export interface SkillCategory {
  id: string
  label: string
  count: number
}
