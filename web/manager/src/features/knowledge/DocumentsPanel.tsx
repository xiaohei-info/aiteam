import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Table } from "@aiteam/shared/ui";
import { useKnowledgeApi } from "./useKnowledgeApi";
import type { KnowledgeDocument, KnowledgeDocumentStatus, KnowledgeImportUrl } from "./types";

const STATUS_LABEL: Record<KnowledgeDocumentStatus, string> = {
  uploaded: "待处理",
  parsing: "解析中",
  indexing: "索引中",
  ready: "完成",
  failed: "失败",
};

function statusClass(s: KnowledgeDocumentStatus): string {
  if (s === "ready") return "text-success";
  if (s === "failed") return "text-danger";
  if (s === "uploaded") return "text-text-muted";
  return "text-text-secondary";
}

interface Props { spaceId: string; canWrite: boolean; onClose: () => void }

export function DocumentsPanel({ spaceId, canWrite, onClose }: Props): ReactNode {
  const api = useKnowledgeApi();
    // owns write flag for parity with KnowledgePage (props already computed there)
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true); setError(null);
    try { setDocs(await api.listDocuments(spaceId)); }
    catch (e) { setError(e instanceof ApiError ? e.message : "加载文档失败"); }
    finally { setLoading(false); }
  }, [api, spaceId]);

  useEffect(() => { void reload(); }, [reload]);

  async function handleUpload(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const file = form.get("file") as File | null;
    if (!file || file.size === 0) { setError("请选择要上传的文件"); return; }
    setBusy(true); setError(null);
    try {
      await api.uploadDocument(spaceId, file);
      (e.target as HTMLFormElement).reset();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "上传失败");
    } finally { setBusy(false); }
  }

  async function handleImportUrl(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const url = String(form.get("url") ?? "").trim();
    if (!url) { setError("请输入 URL"); return; }
    setBusy(true); setError(null);
    try {
      const body: KnowledgeImportUrl = { url };
      await api.importUrl(spaceId, body);
      (e.target as HTMLFormElement).reset();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "导入失败");
    } finally { setBusy(false); }
  }

  async function handleRetry(docId: string): Promise<void> {
    setBusy(true); setError(null);
    try { await api.retryDocument(spaceId, docId); await reload(); }
    catch (err) { setError(err instanceof ApiError ? err.message : "重试失败"); }
    finally { setBusy(false); }
  }

  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-base font-semibold text-text-primary">文档摄入</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>关闭</Button>
      </div>

      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {loading ? (
        <p className="m-0 text-sm text-text-secondary">加载中…</p>
      ) : docs.length === 0 ? (
        <p className="m-0 text-sm text-text-muted">暂无文档。上传文件或导入 URL 以开始。</p>
      ) : (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead><tr><th>名称</th><th>来源</th><th>类型</th><th>状态</th><th>分词数</th>{canWrite && <th></th>}</tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td>{d.display_name}</td>
                  <td>{d.source_type === "url" ? "URL" : "上传"}</td>
                  <td>{d.file_type || d.file_name}</td>
                  <td className={statusClass(d.status)}>{STATUS_LABEL[d.status]}</td>
                  <td>{d.text_chars ?? "—"}</td>
                  {canWrite && d.status === "failed" && (
                    <td><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void handleRetry(d.id)}>重试</Button></td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        </GlassPanel>
      )}

      {canWrite && (
        <>
          <form className="flex flex-col gap-md" onSubmit={handleUpload}>
            <span className="text-xs text-text-secondary">上传文件（文本 / Word / PDF / URL 页面）</span>
            <div className="flex flex-wrap items-end gap-md">
              <Field label="文件">
                <Input type="file" name="file" disabled={busy} />
              </Field>
              <Button type="submit" disabled={busy} className="self-start">{busy ? "上传中…" : "上传"}</Button>
            </div>
          </form>

          <form className="flex flex-col gap-md" onSubmit={handleImportUrl}>
            <span className="text-xs text-text-secondary">从 URL 导入</span>
            <div className="flex flex-wrap items-end gap-md">
              <Field label="URL"><Input type="url" name="url" placeholder="https://..." disabled={busy} /></Field>
              <Button type="submit" disabled={busy} className="self-start">导入</Button>
            </div>
          </form>
        </>
      )}
    </GlassPanel>
  );
}
