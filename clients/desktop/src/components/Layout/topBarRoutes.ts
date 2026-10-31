export interface TopBarBreadcrumb {
  label: string
  to?: string
  /** 页内视图使用：点击时执行回调，而不是路由跳转。 */
  onSelect?: () => void
}

export interface TopBarRoute {
  title: string
  breadcrumbs: TopBarBreadcrumb[]
}

const STATIC_ROUTES: Record<string, TopBarRoute> = {
  '/chat': { title: '单聊', breadcrumbs: [{ label: '单聊' }] },
  '/group-chat': { title: '群聊', breadcrumbs: [{ label: '群聊' }] },
  '/tasks': { title: '自动化', breadcrumbs: [{ label: '自动化' }] },
  '/agents': { title: '智能体', breadcrumbs: [{ label: '智能体' }] },
  '/talents': { title: '人才市场', breadcrumbs: [{ label: '人才市场' }] },
  '/skills': { title: '技能中心', breadcrumbs: [{ label: '技能中心' }] },
  '/knowledge': { title: '知识库', breadcrumbs: [{ label: '知识库' }] },
  '/knowledge/local-documents': {
    title: '本地文档',
    breadcrumbs: [
      { label: '知识库', to: '/knowledge' },
      { label: '本地文档' },
    ],
  },
  '/workbench': { title: '工作台', breadcrumbs: [{ label: '工作台' }] },
  '/org': { title: '组织架构', breadcrumbs: [{ label: '组织架构' }] },
  '/mcp': { title: 'MCP 服务', breadcrumbs: [{ label: 'MCP 服务' }] },
  '/office': { title: '办公室', breadcrumbs: [{ label: '办公室' }] },
  '/settings': { title: '设置', breadcrumbs: [{ label: '设置' }] },
  '/profile': { title: '个人资料', breadcrumbs: [{ label: '个人资料' }] },
  '/profile/settings': {
    title: '设置',
    breadcrumbs: [
      { label: '个人资料', to: '/profile' },
      { label: '设置' },
    ],
  },
  '/profile/agents': {
    title: '智能体',
    breadcrumbs: [
      { label: '个人资料', to: '/profile' },
      { label: '智能体' },
    ],
  },
  '/profile/knowledge': {
    title: '知识库',
    breadcrumbs: [
      { label: '个人资料', to: '/profile' },
      { label: '知识库' },
    ],
  },
  '/profile/skills': {
    title: '技能中心',
    breadcrumbs: [
      { label: '个人资料', to: '/profile' },
      { label: '技能中心' },
    ],
  },
}

function normalizePathname(pathname: string): string {
  if (pathname === '/') return pathname
  return pathname.replace(/\/+$/, '') || '/'
}

export function resolveTopBarRoute(pathname: string): TopBarRoute {
  const normalizedPathname = normalizePathname(pathname)
  const staticRoute = STATIC_ROUTES[normalizedPathname]
  if (staticRoute) return staticRoute

  if (/^\/chat\/[^/]+$/.test(normalizedPathname)) {
    return {
      title: '单聊',
      breadcrumbs: [
        { label: '单聊', to: '/chat' },
        { label: '会话' },
      ],
    }
  }

  if (/^\/knowledge\/[^/]+$/.test(normalizedPathname)) {
    return {
      title: '知识库详情',
      breadcrumbs: [
        { label: '知识库', to: '/knowledge' },
        { label: '知识库详情' },
      ],
    }
  }

  return { title: 'AIFred', breadcrumbs: [] }
}
