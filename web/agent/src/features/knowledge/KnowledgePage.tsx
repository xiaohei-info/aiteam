/** P08 知识库页 — 列表 + 搜索 + 上传。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel, Input } from "@aiteam/shared/ui";
import { useApp } from "../../lib/app-context";
import { listKnowledgeBases, searchKnowledge, type KnowledgeBase, type KnowledgeSearchResult } from "./useKnowledgeApi";

export function KnowledgePage() {
  const { client, i18n } = useApp();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setBases(await listKnowledgeBases(client)); } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [client]);

  useEffect(() => { void load(); }, [load]);

  const handleSearch = useCallback(async () => {
    if (!selectedKb || !query) return;
    try { setSearchResults(await searchKnowledge(client, selectedKb, query)); } catch { /* ignore */ }
  }, [client, selectedKb, query]);

  const handleUpload = useCallback(async () => {
    if (!selectedKb || !fileRef.current?.files?.[0]) return;
    try { await import("../../lib/api-client").then(({ AgentApiClient }) => void 0); /* noop type guard */ await client.post(`/api/agent/knowledge-bases/${selectedKb}/documents`, { body: (() => { const fd = new FormData(); fd.append("file", fileRef.current!.files![0]); return fd; })() }); await load(); } catch { /* ignore */ }
  }, [client, selectedKb, load]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;
  if (error) return <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger">{error}</GlassPanel>;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">知识库</h1>

      {bases.length === 0 ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无知识库</GlassPanel> : (
        <>
          <div className="grid grid-cols-3 gap-md">
            {bases.map((kb) => (
              <GlassPanel key={kb.kb_id} className={`rounded-window p-md cursor-pointer ${selectedKb === kb.kb_id ? "border-gold/50" : ""}`} onClick={() => setSelectedKb(kb.kb_id)}>
                <p className="m-0 text-sm font-bold text-text-primary">{kb.name}</p>
                <p className="m-0 mt-xs text-xs text-text-muted">{kb.doc_count} 文档 · {(kb.size_kb / 1024).toFixed(1)} MB</p>
                <p className="m-0 mt-xs text-xs text-text-muted">{kb.source_type} · {kb.sync_status}</p>
              </GlassPanel>
            ))}
          </div>

          {selectedKb && (
            <GlassPanel className="rounded-window p-md">
              <div className="flex gap-sm">
                <Input placeholder="语义搜索…" value={query} onChange={(e) => setQuery((e.target as HTMLInputElement).value)} className="flex-1" />
                <Button variant="primary" size="sm" onClick={() => void handleSearch()}>搜索</Button>
                <input ref={fileRef} type="file" className="hidden" onChange={() => void handleUpload()} />
                <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()}>上传文档</Button>
              </div>

              {searchResults.length > 0 && (
                <div className="mt-md space-y-sm">
                  {searchResults.map((r) => (
                    <div key={r.doc_id} className="border-b border-gold/5 pb-sm">
                      <p className="m-0 text-sm font-bold text-text-primary">{r.title}</p>
                      <p className="m-0 mt-xs text-xs text-text-secondary">{r.snippet}</p>
                      <p className="m-0 mt-xs text-xs text-text-muted">相关度: {(r.score * 100).toFixed(0)}%</p>
                    </div>
                  ))}
                </div>
              )}
            </GlassPanel>
          )}
        </>
      )}
    </section>
  );
}
