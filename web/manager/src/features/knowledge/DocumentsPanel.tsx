import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
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
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
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
  reindex_requested: "重建索引中",
  deleting: "删除处理中",
  deleted: "已删除",
};
const STATUS_DESCRIPTION: Record<KnowledgeDocumentStatus, string> = {
  uploaded: "等待开始解析",
  parsing: "正在提取文档内容",
  indexing: "正在建立索引",
  ready: "处理完成；授权员工可由 Agent 引用",
  failed: "摄入失败，请先重试",
  reindex_requested: "已请求重建索引，旧引用暂不可用",
  deleting: "删除请求已接受，文档和引用暂不可用",
  deleted: "文档已删除，引用不可用",
};

const STATUS_VARIANT: Record<KnowledgeDocumentStatus, BadgeVariant> = {
  uploaded: "neutral",
  parsing: "info",
  indexing: "warning",
  ready: "success",
  failed: "error",
  reindex_requested: "warning",
  deleting: "warning",
  deleted: "neutral",
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
  if (document.status === "deleting") {
    return { label: "引用不可用", description: "文档删除处理中，当前不能获取引用", variant: "warning" };
  }
  if (document.status === "deleted") {
    return { label: "引用不可用", description: "文档已删除，当前不能获取引用", variant: "error" };
  }
  if (document.status === "reindex_requested") {
    return { label: "引用不可用", description: "索引重建中，旧引用暂不可用", variant: "warning" };
  }
  if (document.status === "ready") {
    return {
      label: "文档已就绪",
      description: "企业知识库已就绪；授权员工可通过 Agent Pi knowledge_get 获取引用",
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
  revoked: "已撤销",
};
const BINDING_STATUS_VARIANT: Record<KnowledgeDocumentBinding["status"], BadgeVariant> = {
  pending: "warning",
  ready: "success",
  stale: "error",
  revoked: "error",
};
const BINDING_STATUS_DESCRIPTION: Record<KnowledgeDocumentBinding["status"], string> = {
  pending: "等待索引同步",
  ready: "可参与引用",
  stale: "需要重新同步",
  revoked: "已撤销，不能参与引用",
};

type DocumentRow = KnowledgeDocument & Record<string, unknown>;
type DocumentBindingRow = KnowledgeDocumentBinding & Record<string, unknown>;

interface Props {
  spaceId: string;
  spaceName: string;
  canWrite: boolean;
  onClose: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.problem?.detail ?? error.message;
  return fallback;
}

function retryableMessage(error: unknown, fallback: string): string {
  const message = errorMessage(error, fallback);
  return error instanceof ApiError && (error.status === 409 || error.status === 503)
    ? `${message}；可重试`
    : message;
}

export function DocumentsPanel({ spaceId, spaceName, canWrite, onClose }: Props): ReactNode {
  const api = useKnowledgeApi();
  const { token, onUnauthorized } = useSession();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);
  const bindingRequestSequence = useRef(0);
  const currentSpaceId = useRef(spaceId);
  currentSpaceId.current = spaceId;

  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionNoticeStatus, setActionNoticeStatus] = useState<"success" | "info">("success");
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeDocument | null>(null);
  const [bindingDocument, setBindingDocument] = useState<KnowledgeDocument | null>(null);
  const [documentBindings, setDocumentBindings] = useState<KnowledgeDocumentBinding[]>([]);
  const [employeeNames, setEmployeeNames] = useState<Map<string, string>>(new Map());
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
      setError(errorMessage(err, "加载文档失败"));
    } finally {
      if (requestId === requestSequence.current && currentSpaceId.current === requestedSpaceId) setLoading(false);
    }
  }, [api, spaceId]);

  useEffect(() => {
    setBusy(false);
    setError(null);
    setActionNotice(null);
    setActionNoticeStatus("success");
    setSelectedFile(null);
    setUrl("");
    setPendingDelete(null);
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
      if (currentSpaceId.current === actionSpaceId) setError(errorMessage(err, "上传失败"));
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
      if (currentSpaceId.current === actionSpaceId) setError(errorMessage(err, "导入失败"));
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
      const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
      const [nextBindings, employeePage] = await Promise.all([
        api.listDocumentBindings(requestedSpaceId, document.id),
        client.listGet<{ employee_id?: string; display_name?: string }>("/api/manager/employees"),
      ]);
      if (requestId !== bindingRequestSequence.current || currentSpaceId.current !== requestedSpaceId) return;
      setDocumentBindings(nextBindings);
      setEmployeeNames(new Map((employeePage.items ?? [])
        .map((employee) => [employee.employee_id ?? "", employee.display_name ?? "未命名专家"] as const)
        .filter(([id]) => id)));
    } catch (err) {
      if (requestId !== bindingRequestSequence.current || currentSpaceId.current !== requestedSpaceId) return;
      setBindingsError(errorMessage(err, "加载索引绑定失败"));
    } finally {
      if (requestId === bindingRequestSequence.current && currentSpaceId.current === requestedSpaceId) setBindingsLoading(false);
    }
  }

  async function handleDelete(): Promise<void> {
    const document = pendingDelete;
    if (!document) return;
    const actionSpaceId = spaceId;
    setBusy(true);
    setError(null);
    setActionNotice(null);
    setActionNoticeStatus("info");
    try {
      const operation = await api.deleteDocument(actionSpaceId, document.id);
      if (currentSpaceId.current !== actionSpaceId) return;
      setPendingDelete(null);
      if (operation.status === "failed") {
        setError(`${operation.error_message || "删除失败"}；可重试`);
        return;
      }
      setActionNoticeStatus(operation.status === "completed" ? "success" : "info");
      setActionNotice(operation.status === "completed" ? "删除已完成" : "删除请求已接受，处理中");
      await reload();
    } catch (err) {
      if (currentSpaceId.current === actionSpaceId) {
        setPendingDelete(null);
        setError(retryableMessage(err, "删除失败"));
      }
    } finally {
      if (currentSpaceId.current === actionSpaceId) setBusy(false);
    }
  }

  async function handleReconcile(document: KnowledgeDocument): Promise<void> {
    const actionSpaceId = spaceId;
    setBusy(true);
    setError(null);
    setActionNotice(null);
    setActionNoticeStatus("info");
    try {
      const operation = await api.reconcileDeleteDocument(actionSpaceId, document.id);
      if (currentSpaceId.current !== actionSpaceId) return;
      setActionNotice(operation.status === "completed" ? "删除已完成" : "删除仍在处理中");
      setActionNoticeStatus(operation.status === "completed" ? "success" : "info");
      await reload();
    } catch (err) {
      if (currentSpaceId.current === actionSpaceId) setError(retryableMessage(err, "删除核对失败"));
    } finally {
      if (currentSpaceId.current === actionSpaceId) setBusy(false);
    }
  }

  async function handleReindex(document: KnowledgeDocument): Promise<void> {
    const actionSpaceId = spaceId;
    setBusy(true);
    setError(null);
    setActionNotice(null);
    setActionNoticeStatus("info");
    try {
      const operation = await api.reindexDocument(actionSpaceId, document.id);
      if (currentSpaceId.current !== actionSpaceId) return;
      if (operation.status === "failed") {
        setError(`${operation.error_message || "重建索引失败"}；可重试`);
        return;
      }
      setActionNoticeStatus(operation.status === "completed" ? "success" : "info");
      setActionNotice(operation.status === "completed" ? "索引重建已完成" : "重建索引请求已接受，处理中");
      await reload();
    } catch (err) {
      if (currentSpaceId.current === actionSpaceId) setError(retryableMessage(err, "重建索引失败"));
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
    if (bindingDocument.status === "deleting") {
      return { status: "error", title: "文档删除处理中，当前没有可用引用。" };
    }
    if (bindingDocument.status === "deleted") {
      return { status: "error", title: "文档已删除，当前没有可用引用。" };
    }
    if (bindingDocument.status === "reindex_requested") {
      return { status: "info", title: "索引重建中，旧引用暂不可用。" };
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
    if (documentBindings.some((binding) => binding.status === "revoked")) {
      return { status: "error", title: "索引绑定已撤销，不能参与引用；请重新绑定专家并等待同步。" };
    }
    if (documentBindings.some((binding) => binding.status === "stale")) {
      return { status: "error", title: "索引绑定需要重新同步，当前不能参与引用。" };
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
    ];
    if (canWrite) {
      result.push({
        key: "actions",
        header: "操作",
        width: pixel(300),
        align: "end",
        resizable: false,
        renderCell: (doc) => (
          <HStack gap={2} justify="end">
            {doc.status === "failed" || doc.status === "ready" ? (
              <Button
                label={doc.status === "failed" ? `重试${doc.display_name}` : `重建索引${doc.display_name}`}
                variant="ghost"
                size="sm"
                isDisabled={busy}
                onClick={() => void handleReindex(doc)}
              />
            ) : doc.status === "deleting" ? (
              <Button
                label={`检查删除状态${doc.display_name}`}
                variant="ghost"
                size="sm"
                isLoading={busy}
                isDisabled={busy}
                clickAction={() => handleReconcile(doc)}
              />
            ) : doc.status === "deleted" ? (
              <Text type="supporting">已删除</Text>
            ) : (
              <Text type="supporting">处理中</Text>
            )}
            {(doc.status === "ready" || doc.status === "failed") && (
              <Button
                label={`删除${doc.display_name}`}
                variant="destructive"
                size="sm"
                isDisabled={busy}
                onClick={() => setPendingDelete(doc)}
              />
            )}
          </HStack>
        ),
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
              {actionNotice && <Banner status={actionNoticeStatus} title={actionNotice} />}
              <Banner
                status="info"
                title="引用正文不通过 Manager HTTP 页面加载：文档已就绪后，请通过 Agent Pi knowledge_get 获取；本页不直连 MCP 或 LightRAG。"
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
                      {bindingDocument.status === "ready" && <Code>{citationId(spaceId, bindingDocument.id)}</Code>}
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
                        {
                          key: "employee_id",
                          header: "专家",
                          width: proportional(1),
                          renderCell: (binding) => employeeNames.get(binding.employee_id) ?? "已删除专家",
                        },
                        {
                          key: "status",
                          header: "状态",
                          width: pixel(140),
                          renderCell: (binding) => (
                            <VStack gap={1} aria-label={`绑定状态：${BINDING_STATUS_LABEL[binding.status]}`}>
                              <Badge label={BINDING_STATUS_LABEL[binding.status]} variant={BINDING_STATUS_VARIANT[binding.status]} />
                              <Text type="supporting">{BINDING_STATUS_DESCRIPTION[binding.status]}</Text>
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

      <AlertDialog
        isOpen={pendingDelete != null}
        onOpenChange={(isOpen) => { if (!isOpen && !busy) setPendingDelete(null); }}
        title="删除文档"
        description={pendingDelete ? `确定删除“${pendingDelete.display_name}”？删除后索引和引用将不可用，且不能恢复。` : "删除文档后索引和引用将不可用，且不能恢复。"}
        cancelLabel="取消"
        actionLabel="确认删除"
        isActionLoading={busy}
        onAction={() => void handleDelete()}
      />
    </Dialog>
  );
}
