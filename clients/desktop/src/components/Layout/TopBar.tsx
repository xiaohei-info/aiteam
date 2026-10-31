import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ChevronRight, Search, Settings } from 'lucide-react'
import './TopBar.css'
import { isGlobalSearchShortcut, requestGlobalSearch } from './globalSearch'
import { resolveTopBarRoute } from './topBarRoutes'
import { useTopBarOverrideValue } from './topBarOverride'

export default function TopBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const override = useTopBarOverrideValue()
  const route = override ?? resolveTopBarRoute(location.pathname)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isGlobalSearchShortcut(event)) return

      event.preventDefault()
      requestGlobalSearch('keyboard')
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleSearch = () => {
    requestGlobalSearch('button')
  }

  const handleSettings = () => {
    navigate('/settings')
  }

  const parentBreadcrumb =
    route.breadcrumbs.length > 1 ? route.breadcrumbs[route.breadcrumbs.length - 2] : undefined

  const backLabel = override?.backLabel ?? parentBreadcrumb?.label

  const handleBack = () => {
    if (override) {
      override.onBack()
    } else if (parentBreadcrumb?.to) {
      navigate(parentBreadcrumb.to)
    } else {
      navigate(-1)
    }
  }

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-context" data-tauri-drag-region>
        {parentBreadcrumb && (
          <button
            type="button"
            className="topbar-back"
            onClick={handleBack}
            aria-label={`返回${backLabel}`}
            title={`返回${backLabel}`}
          >
            <ArrowLeft size={16} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <h1 className="topbar-title">{route.title}</h1>
        {route.breadcrumbs.length > 1 && (
          <nav className="topbar-breadcrumbs" aria-label="面包屑导航">
            {route.breadcrumbs.map((breadcrumb, index) => {
              const isCurrent = index === route.breadcrumbs.length - 1
              return (
                <span className="topbar-breadcrumb-item" key={`${breadcrumb.label}-${index}`}>
                  {index > 0 && <ChevronRight size={12} strokeWidth={1.8} aria-hidden="true" />}
                  {breadcrumb.onSelect ? (
                    <button type="button" className="topbar-breadcrumb-link" onClick={breadcrumb.onSelect}>{breadcrumb.label}</button>
                  ) : breadcrumb.to && !isCurrent ? (
                    <Link className="topbar-breadcrumb-link" to={breadcrumb.to}>{breadcrumb.label}</Link>
                  ) : (
                    <span className="topbar-breadcrumb-current" aria-current={isCurrent ? 'page' : undefined}>
                      {breadcrumb.label}
                    </span>
                  )}
                </span>
              )
            })}
          </nav>
        )}
      </div>

      <div className="topbar-actions">
        <button
          type="button"
          className="topbar-search"
          onClick={handleSearch}
          aria-label="打开全局搜索，快捷键 Command K"
          aria-keyshortcuts="Meta+K Control+K"
          title="打开全局搜索（⌘K）"
        >
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <span className="topbar-search-label">搜索员工、会话、任务与知识</span>
          <kbd className="topbar-search-shortcut" aria-hidden="true">⌘K</kbd>
        </button>

        <button
          type="button"
          className="topbar-settings"
          onClick={handleSettings}
          aria-label="打开设置"
          title="设置"
        >
          <Settings size={16} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}
