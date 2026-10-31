/**
 * MCP 服务配置页，展示已配置的 Model Context Protocol 服务器列表，支持新增服务。
 *
 * @注意 当前使用 mock 数据，添加服务功能未实现；列表项带入场动画延迟。
 */
const MOCK_SERVERS = [
  { id: '1', name: 'GitHub Tools', url: 'https://mcp.github.com', status: 'connected' },
  { id: '2', name: 'Notion Integration', url: 'https://mcp.notion.so', status: 'connected' },
  { id: '3', name: 'Local File System', url: 'localhost:3100', status: 'disconnected' },
]

export default function McpConfig() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <p className="m-0 text-xs text-txt-secondary">管理 Model Context Protocol 服务器</p>
        <button className="rounded-xl bg-brand/10 px-4 py-2 font-display text-xs font-medium text-brand hover:bg-brand/20 transition-colors border border-brand/20">
          + 添加服务
        </button>
      </div>
      <div className="space-y-3">
        {MOCK_SERVERS.map((server, i) => (
          <div
            key={server.id}
            className="flex items-center gap-4 rounded-2xl border border-[var(--border)] bg-surface-1 p-4 transition-all hover:border-[var(--border-hover)] animate-fade-up"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-lg">🔌</div>
            <div className="flex-1">
              <h3 className="font-display text-sm font-medium text-txt-primary">{server.name}</h3>
              <p className="text-[11px] text-txt-muted">{server.url}</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${server.status === 'connected' ? 'bg-green-400' : 'bg-red-400'}`} />
              <span className="text-[11px] text-txt-secondary">{server.status === 'connected' ? '已连接' : '未连接'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
