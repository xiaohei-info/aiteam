/** 行业文档生成：草稿工作台（资料 → 生成 → 处理敏感项 → 审核 → 发布）。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, PlatformRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { FindingsPanel } from "./FindingsPanel";
import { draftStatus, eventAction, formatTime, jobError, jobStatus } from "./labels";
import { PackageEditor } from "./PackageEditor";
import { SourcesPanel } from "./SourcesPanel";
import { CONTENT_STATUSES, EDITABLE_STATUSES, type DraftDetail, type FindingResolution, type GeneratedSolution } from "./types";
import { useSolutionAuthoringApi } from "./useSolutionAuthoringApi";

const LIST_PATH = "/solution-authoring";
const POLL_MS = 2000;

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function DraftDetailPage(): ReactNode {
  const { draft_id: draftId } = useParams<{ draft_id: string }>();
  const navigate = useNavigate();
  const { session } = useSession();
  const api = useSolutionAuthoringApi();
  const isAdmin = hasRole(session, PlatformRole.SYSTEM_ADMIN);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"archive" | "publish" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  // 同一次「开始生成」的重试沿用同一个幂等键：网络失败后再点不会排出第二个任务。
  const generateKey = useRef<string | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!draftId) return;
    const requestId = ++sequence.current;
    if (!silent) { setLoading(true); setLoadError(null); }
    try {
      const next = await api.get(draftId);
      if (requestId === sequence.current) setDetail(next);
    } catch (err) {
      // 轮询失败不打断页面：下一拍再试。
      if (requestId === sequence.current && !silent) setLoadError(message(err, "加载失败"));
    } finally {
      if (requestId === sequence.current && !silent) setLoading(false);
    }
  }, [api, draftId]);

  useEffect(() => { void load(); }, [load]);

  const generating = detail?.status === "generating";
  useEffect(() => {
    if (!generating) return;
    const timer = window.setInterval(() => { void load(true); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [generating, load]);

  /** 执行一个动作；返回错误文案（成功为 null）。动作返回新详情时直接采用，否则重新拉取。 */
  const run = useCallback(async (action: () => Promise<DraftDetail | void>, fallback: string): Promise<string | null> => {
    setBusy(true);
    setActionError(null);
    try {
      const next = await action();
      sequence.current += 1; // 作废在途的轮询结果
      if (next) setDetail(next);
      else await load(true);
      return null;
    } catch (err) {
      const text = message(err, fallback);
      setActionError(text);
      // 版本冲突或状态已变：拿最新数据，让使用者基于它重试。
      if (err instanceof ApiError && err.status === 409) await load(true);
      return text;
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (!draftId) return <EmptyState title="草稿不存在" />;
  if (loading) {
    return <Card role="status" aria-label="草稿加载中"><VStack gap={2}><Skeleton height={36} /><Skeleton height={160} index={1} /></VStack></Card>;
  }
  if (loadError) return <Banner status="error" title={loadError} endContent={<Button label="重试" variant="ghost" onClick={() => void load()} />} />;
  if (!detail) return <EmptyState title="草稿不存在" />;

  const status = draftStatus(detail.status);
  const canEditSources = EDITABLE_STATUSES.includes(detail.status);
  const canEditContent = CONTENT_STATUSES.includes(detail.status) && detail.package !== null;
  const job = detail.latest_job;

  const upload = (files: File[]) => void run(async () => {
    for (const file of files) await api.uploadSource(draftId, file);
  }, "上传失败");

  const generate = () => void run(async () => {
    const key = generateKey.current ?? crypto.randomUUID();
    generateKey.current = key;
    try {
      await api.generate(draftId, key);
      generateKey.current = null;
    } catch (err) {
      // 只有「没收到服务端答复」时才保留键；服务端明确拒绝后下次是一次新请求。
      if (!(err instanceof ApiError && err.status === 0)) generateKey.current = null;
      throw err;
    }
  }, "发起生成失败");

  const savePackage = (next: GeneratedSolution) => run(() => api.updatePackage(draftId, detail.version, next), "保存失败");
  const resolve = (findingId: string, resolution: FindingResolution) => void run(() => api.resolveFinding(draftId, findingId, resolution), "处理失败");

  async function confirmAction() {
    const action = confirm;
    if (action === "archive") {
      const failure = await run(() => api.archive(draftId!), "归档失败");
      setConfirm(null);
      if (!failure) navigate(LIST_PATH);
      return;
    }
    await run(() => api.publish(draftId!), "发布失败");
    setConfirm(null);
  }

  async function submitReject() {
    const failure = await run(() => api.reject(draftId!, rejectNote.trim()), "驳回失败");
    if (!failure) { setRejecting(false); setRejectNote(""); }
  }

  return (
    <VStack as="section" gap={6}>
      <Breadcrumbs label="面包屑" variant="supporting">
        <BreadcrumbItem href={LIST_PATH}>行业文档生成</BreadcrumbItem>
        <BreadcrumbItem isCurrent>{detail.title}</BreadcrumbItem>
      </Breadcrumbs>

      <HStack justify="between" vAlign="center" wrap="wrap" gap={3}>
        <VStack gap={1}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Heading level={1}>{detail.title}</Heading>
            <Badge label={status.label} variant={status.variant} />
          </HStack>
          <Text type="supporting" color="secondary">
            生成模型 {detail.platform_model_ref.model_id} · 图片识别{detail.image_recognition === "vision" ? "已开启" : "未开启"} · 最近更新 {formatTime(detail.updated_at)}
          </Text>
        </VStack>
        <HStack gap={2} wrap="wrap">
          {canEditContent && (
            <Button
              label="提交审核"
              onClick={() => void run(() => api.submitReview(draftId), "提交失败")}
              isDisabled={busy || detail.open_finding_count > 0}
              tooltip={detail.open_finding_count > 0 ? "还有待处理的敏感项" : undefined}
            />
          )}
          {isAdmin && detail.status === "in_review" && (
            <Button label="审核通过" onClick={() => void run(() => api.approve(draftId, ""), "操作失败")} isDisabled={busy} />
          )}
          {isAdmin && (detail.status === "in_review" || detail.status === "approved") && (
            <Button label="驳回" variant="secondary" onClick={() => setRejecting(true)} isDisabled={busy} />
          )}
          {isAdmin && detail.status === "approved" && <Button label="发布到目录" onClick={() => setConfirm("publish")} isDisabled={busy} />}
          {detail.status !== "generating" && detail.status !== "archived" && (
            <Button label="归档" variant="ghost" onClick={() => setConfirm("archive")} isDisabled={busy} />
          )}
        </HStack>
      </HStack>

      {actionError && <Banner status="error" title={actionError} isDismissable onDismiss={() => setActionError(null)} />}
      {detail.status === "generating" && (
        <Banner status="info" title={job ? jobStatus(job.status) : "排队中"} description="生成通常需要几分钟，页面会自动刷新；可以先离开，稍后回来查看。" />
      )}
      {detail.status !== "generating" && job?.status === "failed" && (
        <Banner status="error" title="上一次生成失败" description={jobError(job.error_code)} />
      )}
      {detail.status === "rejected" && detail.review_note && <Banner status="warning" title="审核被驳回" description={detail.review_note} />}
      {!isAdmin && detail.status === "in_review" && <Banner status="info" title="等待管理员审核" />}
      {!isAdmin && detail.status === "approved" && <Banner status="info" title="审核已通过，等待管理员发布" />}
      {detail.status === "published" && detail.published_solution_id && (
        <Banner
          status="success"
          title="已发布到行业解决方案目录"
          endContent={<Link to={`/catalog/solution_template/${detail.published_solution_id}`}>查看目录项</Link>}
        />
      )}

      <SourcesPanel
        sources={detail.sources}
        canEdit={canEditSources}
        hasContent={detail.package !== null}
        busy={busy}
        onUpload={upload}
        onDelete={(sourceId) => void run(() => api.deleteSource(draftId, sourceId), "删除失败")}
        onGenerate={generate}
      />

      {detail.package && (
        <>
          <FindingsPanel findings={detail.findings} solution={detail.package} canResolve={canEditContent} busy={busy} onResolve={resolve} />
          {/* key 带版本：正文被别的动作（脱敏、重新生成）改动后，编辑器丢弃旧的本地草稿。 */}
          <PackageEditor
            key={detail.version}
            solution={detail.package}
            evidenceSources={detail.evidence_sources}
            canEdit={canEditContent}
            busy={busy}
            onSave={savePackage}
          />
        </>
      )}

      <Card>
        <VStack gap={3}>
          <Heading level={2}>操作记录</Heading>
          <VStack as="ol" gap={1} aria-label="操作记录" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {detail.events.map((event, index) => (
              <Text as="div" key={`${event.created_at}-${index}`} type="supporting">
                <li>{formatTime(event.created_at)} · {eventAction(event.action)} · {event.actor_id}</li>
              </Text>
            ))}
          </VStack>
        </VStack>
      </Card>

      <AlertDialog
        isOpen={confirm !== null}
        onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}
        title={confirm === "publish" ? "发布到目录" : "归档草稿"}
        description={confirm === "publish"
          ? "方案和其中的每位专家会写入目录并立即对企业可见。"
          : "归档后草稿从列表移除，已上传的资料原件会被删除。已发布到目录的方案不受影响。"}
        cancelLabel="取消"
        actionLabel={confirm === "publish" ? "确认发布" : "确认归档"}
        actionVariant={confirm === "archive" ? "destructive" : undefined}
        isActionLoading={busy}
        onAction={() => void confirmAction()}
      />

      <Dialog isOpen={rejecting} onOpenChange={(open) => { if (!open && !busy) setRejecting(false); }} purpose="form" width={480} aria-label="驳回草稿">
        <Layout
          header={<DialogHeader title="驳回草稿" onOpenChange={(open) => { if (!open && !busy) setRejecting(false); }} />}
          content={
            <LayoutContent>
              <TextArea label="驳回理由" value={rejectNote} onChange={setRejectNote} rows={4} maxLength={1000} description="提交人会看到这段理由" isRequired isDisabled={busy} />
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} hAlign="end">
                <Button label="取消" variant="ghost" onClick={() => setRejecting(false)} isDisabled={busy} />
                <Button label="确认驳回" variant="destructive" onClick={() => void submitReject()} isLoading={busy} isDisabled={!rejectNote.trim()} />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </VStack>
  );
}
