import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Field } from "@astryxdesign/core/Field";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useKnowledgeApi } from "./useKnowledgeApi";
import type {
  KnowledgeDocument,
  KnowledgeDocumentBinding,
  KnowledgeDocumentStatus,
  KnowledgeImportUrl,
} from "./types";

const STATUS_LABEL: Record<KnowledgeDocumentStatus, string> = {
  uploaded: "待处理",
  parsing: "解析中",
  indexing: "索引中",
  ready: "已就绪",
  failed: "失败",
};
const STATUS_DESCRIPTION: Record<KnowledgeDocumentStatus, string> = {
  uploaded: "等待开始解析",
  parsing: "正在提取文档内容",
  indexing: "正在建立索引",
  ready: "处理完成；绑定就绪后可由 Agent 引用",
  failed: "摄入失败，请先重试",
};

const STATUS_VARIANT: Record<KnowledgeDocumentStatus, BadgeVariant> = {
  uploaded: "neutral",
  parsing: "info",
  indexing: "warning",
  ready: "success",
  failed: "error",
};
const SOURCE_LABEL: Record<KnowledgeDocument["source_type"], string> = {
  file: "上传",
  url: "URL 导入",
};

function citationId(spaceId: string, documentId: string): string {
  return `citation:${spaceId}:${documentId}`;
}

function citationStatus(document: KnowledgeDocument): {
  label: string;
  description: string;
  variant: BadgeVariant;
} {
  if (document.status === "ready") {
    return {
      label: "文档已就绪",
      description: "需要至少一个已就绪绑定后，Agent 才能获取引用",
      variant: "success",
    };
  }
  if (document.status === "failed") {
    return { label: "引用不可用", description: "摄入失败；请重试后再获取引用", variant: "error" };
  }
  return { label: "等待就绪", description: "文档处理完成后才可获取引用", variant: "neutral" };
}
const BINDING_STATUS_LABEL: Record<KnowledgeDocumentBinding["status"], string> = {
  pending: "同步中",
  ready: "已就绪",
  stale: "需同步",
};
const BINDING_STATUS_VARIANT: Record<KnowledgeDocumentBinding["status"], BadgeVariant> = {
  pending: "warning",
  ready: "success",
  stale: "error",
};

type DocumentRow = KnowledgeDocument & Record<string, unknown>;
type DocumentBindingRow = KnowledgeDocumentBinding & Record<string, unknown>;

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
  const bindingRequestSequence = useRef(0);
  const currentSpaceId = useRef(spaceId);
  currentSpaceId.current = spaceId;

  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [bindingDocument, setBindingDocument] = useState<KnowledgeDocument | null>(null);
  const [documentBindings, setDocumentBindings] = useState<KnowledgeDocumentBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);

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
    bindingRequestSequence.current += 1;
    setBindingDocument(null);
    setDocumentBindings([]);
    setBindingsLoading(false);
    setBindingsError(null);
    void reload();
    return () => {
      requestSequence.current += 1;
      bindingRequestSequence.current += 1;
    };
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

  async function openDocumentBindings(document: KnowledgeDocument): Promise<void> {
    const requestedSpaceId = spaceId;
    const requestId = ++bindingRequestSequence.current;
    setBindingDocument(document);
    setDocumentBindings([]);
    setBindingsLoading(true);
    setBindingsError(null);
    try {
      const nextBindings = await api.listDocumentBindings(requestedSpaceId, document.id);
      if (requestId !== bindingRequestSequence.current || currentSpaceId.current !== requestedSpaceId) return;
      setDocumentBindings(nextBindings);
    } catch (err) {
      if (requestId !== bindingRequestSequence.current || currentSpaceId.current !== requestedSpaceId) return;
      setBindingsError(err instanceof ApiError ? err.message : "加载索引绑定失败");
    } finally {
      if (requestId === bindingRequestSequence.current && currentSpaceId.current === requestedSpaceId) setBindingsLoading(false);
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

  const bindingCitationNotice = useMemo<{
    status: "success" | "info" | "error";
    title: string;
  } | null>(() => {
    if (!bindingDocument || bindingsLoading || bindingsError) return null;
    if (bindingDocument.status === "failed") {
      return { status: "error", title: "文档摄入失败，当前没有可用引用；请先重试摄入。" };
    }
    if (bindingDocument.status !== "ready") {
      return { status: "info", title: "文档尚未就绪，完成解析和索引后才会产生可用引用。" };
    }
    if (documentBindings.some((binding) => binding.status === "ready")) {
      return { status: "success", title: "引用可用；正文请通过 Agent Pi knowledge_get 获取。" };
    }
    if (documentBindings.some((binding) => binding.status === "pending")) {
      return { status: "info", title: "文档已就绪，但索引绑定仍在同步；同步完成后才可获取引用。" };
    }
    return { status: "error", title: "文档已就绪，但暂无可用绑定；请先绑定专家并等待索引同步。" };
  }, [bindingDocument, bindingsError, bindingsLoading, documentBindings]);

  const columns = useMemo<TableColumn<DocumentRow>[]>(() => {
    const result: TableColumn<DocumentRow>[] = [
      { key: "display_name", header: "名称", width: proportional(2) },
      {
        key: "source_type",
        header: "来源",
        width: pixel(150),
        renderCell: (doc) => (
          <VStack gap={1} aria-label={`来源：${SOURCE_LABEL[doc.source_type]}`}>
            <Badge label={SOURCE_LABEL[doc.source_type]} variant="neutral" />
            <Text type="supporting">{doc.file_name || "来源未提供"}</Text>
          </VStack>
        ),
      },
      { key: "file_type", header: "类型", width: pixel(120), renderCell: (doc) => doc.file_type || doc.file_name },
      {
        key: "status",
        header: "状态",
        width: pixel(180),
        renderCell: (doc) => (
          <VStack gap={1} aria-label={`文档状态：${STATUS_LABEL[doc.status]}`}>
            <Badge label={STATUS_LABEL[doc.status]} variant={STATUS_VARIANT[doc.status]} />
            <Text type="supporting">{doc.status === "failed" ? (doc.error_message || doc.error_code || STATUS_DESCRIPTION[doc.status]) : STATUS_DESCRIPTION[doc.status]}</Text>
          </VStack>
        ),
      },
      {
        key: "citation",
        header: "引用",
        width: pixel(220),
        renderCell: (doc) => {
          const status = citationStatus(doc);
          return (
            <VStack gap={1} aria-label={`引用状态：${status.label}。${status.description}`}>
              <Badge label={status.label} variant={status.variant} />
              <Text type="supporting">{status.description}</Text>
              {doc.status === "ready" && <Code>{citationId(spaceId, doc.id)}</Code>}
            </VStack>
          );
        },
      },
      {
        key: "bindings",
        header: "索引绑定",
        width: pixel(140),
        renderCell: (doc) => (
          <Button
            label={`查看${doc.display_name}绑定状态`}
            variant="ghost"
            size="sm"
            isDisabled={busy}
            onClick={() => void openDocumentBindings(doc)}
          />
        ),
      },
    ];
    if (canWrite) {
      result.push({
        key: "actions",
        header: "操作",
        width: pixel(160),
        align: "end",
        resizable: false,
        renderCell: (doc) => doc.status === "failed" || doc.status === "ready"
          ? <Button label={doc.status === "failed" ? `重试${doc.display_name}` : `重建索引${doc.display_name}`} variant="ghost" size="sm" isDisabled={busy} onClick={() => void handleRetry(doc)} />
          : <Text type="supporting">处理中</Text>,
      });
    }
    return result;
  }, [api, busy, canWrite, reload, spaceId]);

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
              <Banner
                status="info"
                title="删除文档暂不可用：Manager OpenAPI 当前没有文档删除 endpoint，本页不展示删除按钮，也不会发送删除请求。"
              />
              <Banner
                status="info"
                title="引用正文不通过 Manager HTTP 页面加载：文档已就绪且绑定同步后，请通过 Agent Pi knowledge_get 获取；本页不直连 MCP 或 LightRAG。"
              />
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

      <Dialog
        isOpen={bindingDocument != null}
        aria-label={bindingDocument ? `索引绑定 · ${bindingDocument.display_name}` : "索引绑定"}
        onOpenChange={(isOpen) => { if (!isOpen && !bindingsLoading) setBindingDocument(null); }}
        width={720}
        maxHeight="80vh"
        purpose="form"
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title={bindingDocument ? `索引绑定 · ${bindingDocument.display_name}` : "索引绑定"}
              onOpenChange={(isOpen) => { if (!isOpen && !bindingsLoading) setBindingDocument(null); }}
            />
          }
          content={
            <LayoutContent>
              <VStack gap={3}>
                {bindingDocument && (
                  <Card>
                    <VStack gap={2}>
                      <Text weight="bold">引用与来源</Text>
                      <Text type="supporting">来源：{SOURCE_LABEL[bindingDocument.source_type]} · {bindingDocument.file_name || "来源未提供"}</Text>
                      <Text type="supporting">文档状态：{STATUS_LABEL[bindingDocument.status]}</Text>
                      <Code>{citationId(spaceId, bindingDocument.id)}</Code>
                      <Text type="supporting">引用正文请通过 Agent Pi knowledge_get 获取；Manager 没有 citation get HTTP API。</Text>
                    </VStack>
                  </Card>
                )}
                {bindingCitationNotice && <Banner status={bindingCitationNotice.status} title={bindingCitationNotice.title} />}
                {bindingsError && <Banner status="error" title={bindingsError} />}
                {bindingsLoading ? (
                  <Card role="status" aria-label="正在加载索引绑定">
                    <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
                  </Card>
                ) : (
                  <Card padding={0}>
                    <Table
                      aria-label="文档索引绑定"
                      tableProps={{ "aria-label": "文档索引绑定" }}
                      data={documentBindings as DocumentBindingRow[]}
                      columns={[
                        { key: "employee_id", header: "专家", width: proportional(1) },
                        {
                          key: "status",
                          header: "状态",
                          width: pixel(140),
                          renderCell: (binding) => (
                            <VStack gap={1} aria-label={`绑定状态：${BINDING_STATUS_LABEL[binding.status]}`}>
                              <Badge label={BINDING_STATUS_LABEL[binding.status]} variant={BINDING_STATUS_VARIANT[binding.status]} />
                              <Text type="supporting">{binding.status === "ready" ? "可参与引用" : binding.status === "pending" ? "等待索引同步" : "需要重新同步"}</Text>
                            </VStack>
                          ),
                        },
                        { key: "rag_document_id", header: "索引来源", width: proportional(1), renderCell: (binding) => binding.rag_document_id || "尚未生成" },
                        { key: "last_synced_at", header: "最近同步", width: pixel(150), renderCell: (binding) => binding.last_synced_at || "尚未同步" },
                      ]}
                      idKey="id"
                      hasHover
                      emptyState={<EmptyState title="暂无索引绑定" description="文档就绪并完成绑定同步后，Agent 才能通过 knowledge_get 获取引用。" isCompact />}
                    />
                  </Card>
                )}
              </VStack>
            </LayoutContent>
          }
          footer={<LayoutFooter hasDivider><HStack justify="end"><Button label="关闭" variant="secondary" isDisabled={bindingsLoading} onClick={() => setBindingDocument(null)} /></HStack></LayoutFooter>}
        />
      </Dialog>
    </Dialog>
  );
}
