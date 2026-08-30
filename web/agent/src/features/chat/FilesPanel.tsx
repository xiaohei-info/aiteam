import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentApiClient } from "../../lib/api-client";
import { downloadLocalFile, listLocalFiles, subscribePiEvents, type LocalFile } from "./useChatApi";

const MAX_TEXT_PREVIEW_BYTES = 128 * 1024;
const IMAGE_MIMES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export interface FilesPanelProps {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
  /** Poll while a prompt is active so generated artifacts appear after the 202 receipt. */
  isPrompting?: boolean;
}

type Preview =
  | { file: LocalFile; kind: "text"; text: string; truncated: boolean }
  | { file: LocalFile; kind: "image" | "pdf"; url: string }
  | { file: LocalFile; kind: "unsupported" };

export function FilesPanel({ client, conversationId, refreshSignal = 0, isPrompting = false }: FilesPanelProps): ReactNode {
  const [files, setFiles] = useState<LocalFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const previewUrl = useRef<string | null>(null);
  const requestGeneration = useRef(0);

  const releasePreview = useCallback(() => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setPreview(null);
  }, []);

  const loadFiles = useCallback((initial = false) => {
    const generation = ++requestGeneration.current;
    if (initial) setLoading(true);
    setError(null);
    void listLocalFiles(client, conversationId)
      .then((items) => { if (generation === requestGeneration.current) setFiles(items); })
      .catch((cause) => { if (generation === requestGeneration.current) setError(cause instanceof Error ? cause.message : "文件列表加载失败"); })
      .finally(() => { if (generation === requestGeneration.current && initial) setLoading(false); });
  }, [client, conversationId]);

  useEffect(() => {
    requestGeneration.current += 1;
    releasePreview();
    return () => { requestGeneration.current += 1; };
  }, [conversationId, releasePreview]);
  useEffect(() => { loadFiles(true); }, [loadFiles, refreshSignal]);

  useEffect(() => {
    if (!isPrompting) return undefined;
    const interval = window.setInterval(() => { loadFiles(false); }, 2_000);
    return () => window.clearInterval(interval);
  }, [isPrompting, loadFiles]);

  // The prompt endpoint acknowledges before the local run finishes. Refresh on
  // the terminal Pi event so generated artifacts become visible without a page reload.
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const subscription = subscribePiEvents(client, conversationId, ({ event }) => {
      if (event.type !== "agent_end" && event.type !== "agent_settled") return;
      for (const delay of [100, 500]) {
        const timer = setTimeout(() => { timers.delete(timer); loadFiles(false); }, delay);
        timers.add(timer);
      }
    });
    return () => {
      subscription.close();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [client, conversationId, loadFiles]);

  useEffect(() => () => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, []);

  async function view(file: LocalFile): Promise<void> {
    releasePreview();
    setPreviewingId(file.id);
    try {
      const response = await downloadLocalFile(client, file);
      const blob = await response.blob();
      if (isTextPreview(file)) {
        const sample = await blob.slice(0, MAX_TEXT_PREVIEW_BYTES + 1).text();
        setPreview({ file, kind: "text", text: sample.slice(0, MAX_TEXT_PREVIEW_BYTES), truncated: sample.length > MAX_TEXT_PREVIEW_BYTES });
      } else if (IMAGE_MIMES.has(file.mime_type) || file.mime_type === "application/pdf") {
        if (typeof URL.createObjectURL !== "function") setPreview({ file, kind: "unsupported" });
        else {
          const url = URL.createObjectURL(blob);
          previewUrl.current = url;
          setPreview({ file, kind: file.mime_type === "application/pdf" ? "pdf" : "image", url });
        }
      } else {
        setPreview({ file, kind: "unsupported" });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "文件预览失败");
    } finally {
      setPreviewingId(null);
    }
  }

  async function download(file: LocalFile): Promise<void> {
    try {
      const response = await downloadLocalFile(client, file);
      const blob = await response.blob();
      if (typeof URL.createObjectURL !== "function") throw new Error("当前浏览器不支持本地下载");
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.rel = "noreferrer";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "文件下载失败");
    }
  }

  return (
    <Card data-testid="conversation-files-panel" role="region" aria-label="会话文件" padding={3}>
      <VStack gap={3}>
        <HStack justify="between" align="center">
          <Heading level={2}>会话文件</Heading>
          <HStack gap={1} align="center">
            <Badge label={`${files.length}`} variant="neutral" />
            <Button label="刷新文件" variant="ghost" size="sm" isLoading={loading} onClick={() => loadFiles(true)} />
          </HStack>
        </HStack>
        {error ? <Banner status="error" title={error} /> : null}
        {loading ? <Text type="supporting">加载中…</Text> : null}
        {!loading && files.length === 0 ? <Text type="supporting">暂无附件或产物</Text> : null}
        <div data-files-list="true">
          {files.map((file) => (
            <div key={file.id} data-file-row="true">
              <div data-file-info="true">
                <strong title={file.filename}>{file.filename}</strong>
                <Text type="supporting" as="span">{file.kind === "artifact" ? "产物" : "附件"} · {formatBytes(file.byte_size)} · {file.mime_type}</Text>
              </div>
              <HStack gap={1} wrap="wrap">
                <Button label={`查看 ${file.filename}`} variant="ghost" size="sm" isLoading={previewingId === file.id} onClick={() => void view(file)} />
                <Button label={`下载 ${file.filename}`} variant="secondary" size="sm" onClick={() => void download(file)} />
              </HStack>
            </div>
          ))}
        </div>
      </VStack>
      {preview ? (
        <Dialog
          isOpen
          purpose="info"
          width={720}
          maxHeight="85vh"
          aria-label={`预览 ${preview.file.filename}`}
          onOpenChange={(open) => { if (!open) releasePreview(); }}
        >
          <VStack gap={3}>
            <HStack justify="between" align="center">
              <Heading level={2}>{preview.file.filename}</Heading>
              <Button label="关闭预览" variant="ghost" size="sm" onClick={releasePreview} />
            </HStack>
            {preview.kind === "text" ? (
              <pre data-file-preview="text">{preview.text}{preview.truncated ? "\n\n[预览已截断，请下载完整文件]" : ""}</pre>
            ) : preview.kind === "image" ? (
              <img data-file-preview="image" data-testid="file-preview-image" src={preview.url} alt={preview.file.filename} />
            ) : preview.kind === "pdf" ? (
              <iframe data-file-preview="pdf" data-testid="file-preview-pdf" title={preview.file.filename} src={preview.url} sandbox="" />
            ) : (
              <Text type="supporting">此文件类型不支持安全预览，请下载后查看。</Text>
            )}
            <Button label={`下载 ${preview.file.filename}`} variant="primary" onClick={() => void download(preview.file)} />
          </VStack>
        </Dialog>
      ) : null}
    </Card>
  );
}

function isTextPreview(file: LocalFile): boolean {
  return file.mime_type.startsWith("text/") || ["application/json", "application/xml", "application/yaml"].includes(file.mime_type);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}
