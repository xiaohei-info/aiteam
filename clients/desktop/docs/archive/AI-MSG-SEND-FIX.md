# Hermes API 对接踩坑总结

> [!WARNING]
> **已废弃，仅适用于旧 Hermes 栈。** 当前桌面端使用 Agent `/api/agent/*`、Bearer JWT 与
> 会话级 Pi SSE；请参阅 [Agent 接口迁移说明](./api-agent-migration.md)。下文只保留作历史记录。

1. CSRF Token — 只验证"存在性"

坑：以为需要从 HTML 页面抓取真实 CSRF token 值（window.__HERMES_CONFIG__.csrfToken），为此写了一整套 initCsrfToken 逻辑。

真相：服务端只检查 X-Hermes-CSRF-Token header 是否存在，不验证值。Axios拦截器写死'x' 即可。

apiClient.interceptors.request.use((config) => {
  if ((config.method ?? '').toLowerCase() !== 'get') {
    config.headers.set('X-Hermes-CSRF-Token', 'x')
  }
  return config
})

---
2. Workbench API 响应结构与文档不符

坑：代码里 for (const emp of data.employees) 迭代，但 /api/team/workbench 实际返回 active_employees: number（数字），不是数组。直接抛 TypeError，对话列表永远空白，且被 .catch(console.error) 吞掉无任何提示。

真相：workbench 只返回 recent_conversations 数组，没有 employees 列表。

---
3. Employee ID 的正确来源

坑：以为 workbench 会返回 employee → conversation 的映射关系。

真相：employee_id 在对话详情接口里：

GET /api/team/conversations/:convId
→ { employee_ref: { employee_id, display_name }, messages: { items } }

在 syncConvMessages 里顺带建map 即可，不需要额外请求：

const data = await fetchConvMessages(convId)
if (data.employee_ref) _employeeMap.set(convId, data.employee_ref.employee_id)

---
4. SSE 流的事件结构完全不同

坑：监听 message_delta / run_finished 事件，从 data.text 取内容。

真相：

┌──────────┬───────────────┬────────────────────────────────────────────────┐
│   项目   │ 预期（错的）  │                      实际                      │
├──────────┼───────────────┼────────────────────────────────────────────────┤
│ 事件名   │ message_delta │ timeline                                       │
├──────────┼───────────────┼────────────────────────────────────────────────┤
│ 结束事件 │ run_finished  │ stream_end                                     │
├──────────┼───────────────┼────────────────────────────────────────────────┤
│ 文本字段 │ data.text     │ data.payload.delta                             │
├──────────┼───────────────┼────────────────────────────────────────────────┤
│ 过滤条件 │ 无            │ payload.kind !== 'reasoning'（推理过程要跳过） │
└──────────┴───────────────┴────────────────────────────────────────────────┘

es.addEventListener('timeline', (e) => {
  const data = JSON.parse(e.data)
  if (data.event_type === 'message_delta'&& data.payload?.kind !== 'reasoning'
      && data.payload?.delta) {
    onDelta(data.payload.delta)
  }
})
es.addEventListener('stream_end', () => { es.close(); onDone() })

---
5. Vite Proxy 与服务端的 Origin 校验冲突

坑：用Vite proxy 的 changeOrigin: true，但浏览器 POST 请求会自动带 Origin: http://localhost:1420，服务端比对 Host（已被 proxy改成目标服务器地址）vs Origin → "Cross-origin mismatch - check reverse proxy headers" → 403。

尝试1（失败）：proxy 加headers: { Origin: 'http://121.40.78.201:8787' } 覆盖——改了 Origin但headers 选项不能可靠覆盖浏览器已发的同名 header，或login/runs 两次请求的 Origin 不一致 → "Session expired" 403。

最终解法：在 proxy configure 回调里直接删掉 Origin 和 Referer——让代理请求行为与 curl 一致（curl 不发 Origin，服务端不做 Origin 校验）：

configure: (proxy) => {
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.removeHeader('Origin')
    proxyReq.removeHeader('Referer')
  })
},

▎ 注意：每次修改 vite.config.ts 后必须重启 dev server。而且只要改了 Origin 相关逻辑，都需要退出登录重新登录，否则旧 session 存的 Origin 与新请求不匹配。
