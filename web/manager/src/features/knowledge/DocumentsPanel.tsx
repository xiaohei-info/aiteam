import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Field } from "@astryxdesign/core/Field";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useKnowledgeApi } from "./useKnowledgeApi";
import type { KnowledgeDocument, KnowledgeDocumentStatus, KnowledgeImportUrl } from "./types";

const STATUS_LABEL: Record<KnowledgeDocumentStatus, string> = {
  uploaded: "待处理",
  parsing: "解析中",
  indexing: "索引中",
  ready: "完成",
  failed: "失败",
};

const STATUS_VARIANT: Record<KnowledgeDocumentStatus, BadgeVariant> = {
  uploaded: "neutral",
  parsing: "info",
  indexing: "warning",
  ready: "success",
  failed: "error",
};

type DocumentRow = KnowledgeDocument & Record<string, unknown>;

interface Props {
  spaceId: string;
  spaceName: string;
  canWrite: boolean;
  onClose: () => void;
}

export function DocumentsPanel({ spaceId, spaceName, canWrite, onClose }: Props): ReactNode {
  const api = useKnowledgeApi();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);
  const currentSpaceId = useRef(spaceId);
  currentSpaceId.current = spaceId;

  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const reload = useCallback(async () => {
    const requestedSpaceId = spaceId;
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextDocs = await api.listDocuments(requestedSpaceId);
      if (requestId !== requestSequence.current || currentSpaceId.current !== requestedSpaceId) return;
      setDocs(nextDocs);
    } catch (err) {
      if (requestId !== requestSequence.current || currentSpaceId.current !== requestedSpaceId) return;
      setDocs([]);
      setError(err instanceof ApiError ? err.message : "加载文档失败");
    } finally {
      if (requestId === requestSequence.current && currentSpaceId.current === requestedSpaceId) setLoading(false);
    }
  }, [api, spaceId]);

  useEffect(() => {
    setBusy(false);
    setSelectedFile(null);
    setUrl("");
    void reload();
    return () => { requestSequence.current += 1; };
  }, [reload]);

  async function handleUpload(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedFile || selectedFile.size === 0) {
      setError("请选择要上传的文件");
      return;
    }
    const actionSpaceId = spaceId;
    setBusy(true);
    setError(null);
    try {
      await api.uploadDocument(actionSpaceId, selectedFile);
      if (currentSpaceId.current !== actionSpaceId) return;
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await reload();
    } catch (err) {
      if (currentSpaceId.current === actionSpaceId) setError(err instanceof ApiError ? err.message : "上传失败");
    } finally {
      if (currentSpaceId.current === actionSpaceId) setBusy(false);
    }
  }

  async function handleImportUrl(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedUrl = url.trim();
    if (!normalizedUrl) {
      setError("请输入 URL");
      return;
    }
    const actionSpaceId = spaceId;
    setBusy(true);
    setError(null);
    try {
      const body: KnowledgeImportUrl = { url: normalizedUrl };
      await api.importUrl(actionSpaceId, body);
      if (currentSpaceId.current !== actionSpaceId) return;
      setUrl("");
      await reload();
    } catch (err) {
      if (currentSpaceId.current === actionSpaceId) setError(err instanceof ApiError ? err.message : "导入失败");
    } finally {
      if (currentSpaceId.current === actionSpaceId) setBusy(false);
    }
  }

  async function handleRetry(document: KnowledgeDocument): Promise<void> {
    const actionSpaceId = spaceId;
    setBusy(true);
    setError(null);
    try {
      await api.retryDocument(actionSpaceId, document.id);
      if (currentSpaceId.current === actionSpaceId) await reload();
    } catch (err) {
      if (currentSpaceId.current === actionSpaceId) setError(err instanceof ApiError ? err.message : "重试失败");
    } finally {
      if (currentSpaceId.current === actionSpaceId) setBusy(false);
    }
  }

  const columns = useMemo<TableColumn<DocumentRow>[]>(() => {
    const result: TableColumn<DocumentRow>[] = [
      { key: "display_name", header: "名称", width: proportional(2) },
      { key: "source_type", header: "来源", width: pixel(90), renderCell: (doc) => doc.source_type === "url" ? "URL" : "上传" },
      { key: "file_type", header: "类型", width: pixel(100), renderCell: (doc) => doc.file_type || doc.file_name },
      { key: "status", header: "状态", width: pixel(100), renderCell: (doc) => <Badge label={STATUS_LABEL[doc.status]} variant={STATUS_VARIANT[doc.status]} /> },
      { key: "text_chars", header: "分词数", width: pixel(100), renderCell: (doc) => doc.text_chars ?? "—" },
    ];
    if (canWrite) {
      result.push({
        key: "actions",
        header: "操作",
        width: pixel(100),
        align: "end",
        resizable: false,
        renderCell: (doc) => doc.status === "failed"
          ? <Button label={`重试${doc.display_name}`} variant="ghost" size="sm" isDisabled={busy} onClick={() => void handleRetry(doc)} />
          : null,
      });
    }
    return result;
  }, [busy, canWrite]);

  return (
    <Dialog
      isOpen
      aria-label={`文档摄入 · ${spaceName}`}
      onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}
      width={960}
      maxHeight="90vh"
      purpose="form"
    >
      <Layout
        height="auto"
        header={<DialogHeader title={`文档摄入 · ${spaceName}`} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }} />}
        content={
          <LayoutContent>
            <VStack gap={4}>
              {error && <Banner status="error" title={error} />}
              {loading ? (
                <Card role="status" aria-label="正在加载文档">
                  <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
                </Card>
              ) : (
                <Card padding={0}>
                  <Table
                    aria-label="文档列表"
                    tableProps={{ "aria-label": "文档列表" }}
                    data={docs as DocumentRow[]}
                    columns={columns}
                    idKey="id"
                    hasHover
                    emptyState={<EmptyState title="暂无文档" description="上传文件或导入 URL 以开始。" isCompact />}
                  />
                </Card>
              )}

              {canWrite && (
                <Grid columns={{ minWidth: 300, repeat: "fit" }} gap={4}>
                  <Card>
                    <form aria-label="上传文件" onSubmit={(event) => void handleUpload(event)}>
                      <VStack gap={3}>
                        <Field label="文件" inputID={fileInputId} isRequired isDisabled={busy}>
                          <input
                            ref={fileInputRef}
                            id={fileInputId}
                            name="file"
                            type="file"
                            disabled={busy}
                            onChange={(event) => setSelectedFile(event.currentTarget.files?.[0] ?? null)}
                          />
                        </Field>
                        <HStack justify="end"><Button label="上传" type="submit" variant="primary" isLoading={busy} isDisabled={!selectedFile} /></HStack>
                      </VStack>
                    </form>
                  </Card>
                  <Card>
                    <form aria-label="从 URL 导入" onSubmit={(event) => void handleImportUrl(event)}>
                      <VStack gap={3}>
                        <FormLayout>
                          <TextInput label="URL" value={url} onChange={setUrl} placeholder="https://..." isRequired isDisabled={busy} />
                        </FormLayout>
                        <HStack justify="end"><Button label="导入" type="submit" variant="primary" isLoading={busy} /></HStack>
                      </VStack>
                    </form>
                  </Card>
                </Grid>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={<LayoutFooter hasDivider><HStack justify="end"><Button label="关闭" variant="secondary" onClick={onClose} /></HStack></LayoutFooter>}
      />
    </Dialog>
  );
}
