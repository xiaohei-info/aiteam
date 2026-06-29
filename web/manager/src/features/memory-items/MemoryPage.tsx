/** B07 记忆管理页 — 记忆条目列表 + CRUD + 搜索。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel, Input, Field } from "@aiteam/shared/ui";
import { useMemoryApi } from "./useMemoryApi";
import type { MemoryItem } from "./types";

export function MemoryPage(): ReactNode {
  const api = useMemoryApi();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [newEmployee, setNewEmployee] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try { setItems(await api.list({ keyword: keyword || undefined })); } catch { /* ignore */ } finally { setLoading(false); }
  }, [api, keyword]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-center justify-between">
        <h1 className="m-0 text-xl font-bold text-text-primary">记忆管理</h1>
        <Button variant="primary" size="sm" onClick={() => setShowForm(!showForm)}>+ 新增记忆</Button>
      </div>

      <div className="flex gap-sm"><Input placeholder="搜索记忆内容…" value={keyword} onChange={(e) => setKeyword((e.target as HTMLInputElement).value)} className="flex-1" /><Button variant="ghost" onClick={() => void load()}>搜索</Button></div>

      {showForm && (
        <GlassPanel className="rounded-window p-md">
          <Field label="员工ID"><Input value={newEmployee} onChange={(e) => setNewEmployee((e.target as HTMLInputElement).value)} /></Field>
          <Field label="记忆内容"><Input value={newContent} onChange={(e) => setNewContent((e.target as HTMLInputElement).value)} /></Field>
          <div className="mt-sm">
            <Button variant="primary" size="sm" onClick={async () => { if (newEmployee && newContent) { await api.create({ employee_id: newEmployee, content: newContent }); setNewContent(""); setNewEmployee(""); setShowForm(false); await load(); } }}>保存</Button>
            <Button variant="ghost" size="sm" onClick={() => setShowForm(false)}>取消</Button>
          </div>
        </GlassPanel>
      )}

      {loading ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel> :
        items.length === 0 ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无记忆条目</GlassPanel> :
        <div className="space-y-sm">{items.map((m) => (
          <GlassPanel key={m.memory_id} className="rounded-window p-md">
            <div className="flex items-start justify-between">
              <div className="flex-1"><p className="m-0 text-sm text-text-primary">{m.content}</p><p className="m-0 mt-xs text-xs text-text-muted">{m.category} · 重要度 {m.importance}/5 · {m.source} · {m.created_at?.slice(0, 10)}</p></div>
              <Button variant="ghost" size="sm" onClick={() => { void api.delete(m.memory_id).then(load); }}>删除</Button>
            </div>
          </GlassPanel>
        ))}</div>}
    </section>
  );
}
