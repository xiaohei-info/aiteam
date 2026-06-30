/** P08 知识库页 — 列表 + 搜索 + 文档导入 (File/URL) + 摄入状态。 (AITEAM-260) */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel, Input } from "@aiteam/shared/ui";
import { useApp } from "../../lib/app-context";
import {
  importUrl,
  listDocuments,
  listIngestions,
  listKnowledgeBases,
  retryDocument,
  searchKnowledge,
  uploadDocument,
} from "./useKnowledgeApi";
import type {
  DocumentStatus,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeIngestion,
  KnowledgeSearchResult,
} from "./types";

type Tab = "file" | "url";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "已上传",
  ingesting: "导入中",
  ready: "就绪",
  error: "失败",
};

const STATUS_BADGE: Record<DocumentStatus, string> = {
  uploaded: "text-text-muted border border-metal/40",
  ingesting: "text-gold-bright border border-gold/40",
  ready: "text-success border border-success/40",
  error: "text-danger border border-danger/40",
};

export function KnowledgePage() {
  const { client } = useApp();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [ingestions, setIngestions] = useState<KnowledgeIngestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("file");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBases = useCallback(async () => {
    try {
      setBases(await listKnowledgeBases(client));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载知识库失败");
    }
  }, [client]);

  const loadDocs = useCallback(async () => {
    if (!selectedKb) {
      setDocs([]);
      setIngestions([]);
      return;
    }
    try {
      const [d, i] = await Promise.all([
        listDocuments(client, selectedKb),
        listIngestions(client, selectedKb),
      ]);
      setDocs(d);
      setIngestions(i);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "加载文档失败");
    }
  }, [client, selectedKb]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadBases();
      await loadDocs();
    } finally {
      setLoading(false);
    }
  }, [loadBases, loadDocs]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    void loadDocs();
  }, [selectedKb, loadDocs]);

  // 轮询：当存在 ingesting 状态的 job 时自动刷
  useEffect(() => {
    if (!selectedKb) return;
    if (!ingestions.some((j) => j.status === "pending" || j.status === "parsing" || j.status === "inserting")) {
      return;
    }
    const id = window.setTimeout(() => void loadDocs(), 1500);
    return () => window.clearTimeout(id);
  }, [selectedKb, ingestions, loadDocs]);

  const handleSearch = useCallback(async () => {
    if (!selectedKb || !query) return;
    setActionError(null);
    try {
      setSearchResults(await searchKnowledge(client, selectedKb, query));
    } catch (errSearch) {
      setActionError(errSearch instanceof ApiError ? errSearch.message : "搜索失败");
    }
  }, [client, selectedKb, query]);

  const handleUpload = useCallback(async () => {
    if (!selectedKb || !fileRef.current?.files?.[0]) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await uploadDocument(client, selectedKb, fileRef.current.files[0]);
      if (fileRef.current) fileRef.current.value = "";
      await loadDocs();
    } catch (errUpload) {
      setActionError(errUpload instanceof ApiError ? errUpload.message : "上传失败");
    } finally {
      setSubmitting(false);
    }
  }, [client, selectedKb, loadDocs]);

  const handleImportUrl = useCallback(async () => {
    if (!selectedKb || !url.trim()) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await importUrl(client, selectedKb, url.trim());
      setUrl("");
      await loadDocs();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "导入失败");
    } finally {
      setSubmitting(false);
    }
  }, [client, selectedKb, url, loadDocs]);

  const handleRetry = useCallback(
    async (doc: KnowledgeDocument) => {
      if (!selectedKb) return;
      setActionError(null);
      try {
        await retryDocument(client, selectedKb, doc.doc_id);
        await loadDocs();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "重试失败");
      }
    },
    [client, selectedKb, loadDocs],
  );

  if (loading) {
    return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;
  }
  if (error) {
    return (
      <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger">
        {error}
      </GlassPanel>
    );
  }

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">知识库</h1>

      {bases.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
          暂无知识库
        </GlassPanel>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-md">
            {bases.map((kb) => (
              <GlassPanel
                key={kb.kb_id}
                className={`rounded-window cursor-pointer p-md ${
                  selectedKb === kb.kb_id ? "border border-gold/50" : ""
                }`}
                onClick={() => {
                  setSelectedKb(kb.kb_id);
                  setActionError(null);
                  setSearchResults([]);
                }}
              >
                <p className="m-0 text-sm font-bold text-text-primary">{kb.name}</p>
                <p className="m-0 mt-xs text-xs text-text-muted">
                  {kb.doc_count} 文档 · {(kb.size_kb / 1024).toFixed(1)} MB
                </p>
                <p className="m-0 mt-xs text-xs text-text-muted">
                  {kb.source_type} · {kb.sync_status}
                </p>
              </GlassPanel>
            ))}
          </div>

          {selectedKb && (
            <GlassPanel className="rounded-window p-md">
              <div className="flex gap-sm border-b border-gold/10 pb-sm">
                <button
                  type="button"
                  onClick={() => setTab("file")}
                  className={`rounded-2 px-sm py-xs text-xs font-semibold transition ${
                    tab === "file" ? "bg-gold/20 text-gold-bright" : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  本地文件
                </button>
                <button
                  type="button"
                  onClick={() => setTab("url")}
                  className={`rounded-2 px-sm py-xs text-xs font-semibold transition ${
                    tab === "url" ? "bg-gold/20 text-gold-bright" : "text-text-muted hover:text-text-primary"
                  }`}
                >
                  从 URL 导入
                </button>
              </div>

              <div className="mt-sm flex flex-col gap-sm">
                {actionError && (
                  <p className="m-0 rounded-2 border border-danger/30 px-sm py-xs text-xs text-danger">
                    {actionError}
                  </p>
                )}

                {tab === "file" ? (
                  <div className="flex items-center gap-sm">
                    <input
                      ref={fileRef}
                      type="file"
                      className="block w-full max-w-md text-xs text-text-secondary file:mr-sm file:rounded-2 file:border-none file:bg-metal/40 file:px-sm file:py-xs file:text-xs file:text-text-primary hover:file:bg-metal/60"
                      onChange={() => void handleUpload()}
                      disabled={submitting}
                    />
                    <Button variant="ghost" size="sm" onClick={() => fileRef.current?.click()} disabled={submitting}>
                      选择文件
                    </Button>
                  </div>
                ) : (
                  <div className="flex gap-sm">
                    <Input
                      type="url"
                      placeholder="https://example.com/article"
                      value={url}
                      onChange={(e) => setUrl((e.target as HTMLInputElement).value)}
                      className="flex-1"
                      disabled={submitting}
                    />
                    <Button variant="metal" size="sm" onClick={() => void handleImportUrl()} disabled={submitting}>
                      {submitting ? "导入中…" : "导入"}
                    </Button>
                  </div>
                )}
              </div>

              <div className="mt-md flex gap-sm border-t border-gold/10 pt-sm">
                <Input
                  placeholder="语义搜索…"
                  value={query}
                  onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
                  className="flex-1"
                />
                <Button variant="metal" size="sm" onClick={() => void handleSearch()}>
                  搜索
                </Button>
              </div>

              {searchResults.length > 0 && (
                <div className="mt-md space-y-sm">
                  <p className="m-0 text-xs font-semibold text-text-muted">搜索结果</p>
                  {searchResults.map((r) => (
                    <div key={r.doc_id} className="border-b border-gold/5 pb-sm">
                      <p className="m-0 text-sm font-bold text-text-primary">{r.title}</p>
                      <p className="m-0 mt-xs text-xs text-text-secondary">{r.snippet}</p>
                      <p className="m-0 mt-xs text-xs text-text-muted">
                        相关度: {(r.score * 100).toFixed(0)}%
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-md space-y-sm">
                <p className="m-0 text-xs font-semibold text-text-muted">
                  文档 ({docs.length})
                </p>
                {docs.length === 0 ? (
                  <p className="m-0 text-xs text-text-muted">暂无文档</p>
                ) : (
                  docs.map((d) => (
                    <div key={d.doc_id} className="flex items-center justify-between border-b border-gold/5 pb-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-sm">
                          <p className="m-0 truncate text-sm font-semibold text-text-primary">{d.title}</p>
                          <span
                            className={`inline-flex rounded-2 px-xs py-0.5 text-2xs font-medium ${STATUS_BADGE[d.status]} shrink-0`}
                          >
                            {STATUS_LABEL[d.status]}
                          </span>
                          {d.source_kind === "url" && (
                            <span className="text-2xs text-text-muted shrink-0">URL</span>
                          )}
                        </div>
                        {d.snippet && (
                          <p className="m-0 mt-xs truncate text-xs text-text-muted">{d.snippet}</p>
                        )}
                        {d.error_message && (
                          <p className="m-0 mt-xs truncate text-xs text-danger">{d.error_message}</p>
                        )}
                      </div>
                      <div className="ml-sm shrink-0 flex items-center gap-xs">
                        {d.status === "ready" && (
                          <span className="text-2xs text-text-muted">{d.chunk_count} chunks</span>
                        )}
                        {d.status === "error" && (
                          <Button variant="ghost" size="sm" onClick={() => void handleRetry(d)}>
                            重试
                          </Button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </GlassPanel>
          )}
        </>
      )}
    </section>
  );
}
