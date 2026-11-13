/** 行业文档生成：草稿列表与新建入口。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PlatformRole, hasRole, newIdempotencyKey } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CreateDraftDialog } from "./CreateDraftDialog";
import { useSession } from "../../auth/session";
import { DraftRowActions, type RowAction } from "./DraftRowActions";
import { draftStatus, formatTime, generationNote } from "./labels";
import type { DraftCreateInput, DraftSummary } from "./types";
import { useSolutionAuthoringApi } from "./useSolutionAuthoringApi";

type DraftRow = DraftSummary & Record<string, unknown>;
type Filter = "open" | "all";

interface PendingAction { action: Exclude<RowAction, "continue">; draft: DraftSummary; }

/** 「未完成」= 还没发布到目录的草稿。 */
const isOpen = (draft: DraftSummary) => draft.status !== "published";

function deleteCopy(draft: DraftSummary): { description: string } {
  return {
    description: draft.status === "generating"
      ? `「${draft.title}」正在生成：会先取消生成，再删除草稿和已上传的资料原件，无法恢复。`
      : `「${draft.title}」会从列表移除，已上传的资料原件会被删除，无法恢复。已发布到目录的方案不受影响。`,
  };
}

export function SolutionAuthoringPage(): ReactNode {
  const api = useSolutionAuthoringApi();
  const navigate = useNavigate();
  const { session } = useSession();
  const isAdmin = hasRole(session, PlatformRole.SYSTEM_ADMIN);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [workerAvailable, setWorkerAvailable] = useState(true);
  const [filter, setFilter] = useState<Filter>("open");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async (silent = false) => {
    const requestId = ++sequence.current;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const next = await api.list();
      if (requestId === sequence.current) { setDrafts(next.drafts); setWorkerAvailable(next.workerAvailable); }
    } catch (err) {
      if (requestId === sequence.current && !silent) setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (requestId === sequence.current && !silent) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  // 有草稿在生成时自动刷新，状态变化不用手动刷页面。
  const anyGenerating = drafts.some((draft) => draft.status === "generating");
  useEffect(() => {
    if (!anyGenerating) return;
    const timer = window.setInterval(() => { void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [anyGenerating, load]);

  /** 执行一个行操作；失败时在列表顶部报错并刷新（状态可能已变）。 */
  const perform = useCallback(async (work: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch (err) {
      setActionError(err instanceof Error && err.message ? err.message : fallback);
    } finally {
      setBusy(false);
      await load(true);
    }
  }, [load]);

  const onRowAction = useCallback((action: RowAction, draft: DraftSummary) => {
    if (action === "continue") {
      void perform(() => api.generate(draft.draft_id, newIdempotencyKey()), "继续生成失败");
    } else {
      setPending({ action, draft });
    }
  }, [api, perform]);

  const confirmPending = useCallback(async () => {
    if (!pending) return;
    const { action, draft } = pending;
    await perform(async () => {
      if (action === "cancel") await api.cancelGeneration(draft.draft_id);
      else {
        // 生成中的草稿不能直接删除：先取消再删除。
        if (draft.status === "generating") await api.cancelGeneration(draft.draft_id);
        await api.archive(draft.draft_id);
      }
    }, action === "cancel" ? "取消生成失败" : "删除失败");
    setPending(null);
  }, [api, pending, perform]);

  const create = useCallback(async (input: DraftCreateInput): Promise<string | null> => {
    try {
      const draft = await api.create(input);
      navigate(`/solution-authoring/${draft.draft_id}`);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : "创建失败";
    }
  }, [api, navigate]);

  const columns = useMemo<TableColumn<DraftRow>[]>(() => [
    { key: "title", header: "标题", width: proportional(2), renderCell: (row) => <Link to={`/solution-authoring/${row.draft_id}`}>{row.title}</Link> },
    {
      key: "status", header: "状态", width: proportional(1.5),
      renderCell: (row) => {
        const status = draftStatus(row.status);
        const note = generationNote(row, workerAvailable);
        return (
          <VStack gap={1}>
            <Badge label={status.label} variant={status.variant} />
            {note && <Text type="supporting" color="secondary">{note.tone === "secondary" ? "" : "⚠ "}{note.text}</Text>}
          </VStack>
        );
      },
    },
    { key: "model", header: "生成模型", width: proportional(1), renderCell: (row) => row.platform_model_ref.model_id },
    { key: "updated_at", header: "最近更新", width: pixel(190), renderCell: (row) => formatTime(row.updated_at) },
    {
      key: "actions", header: "操作", width: pixel(100),
      renderCell: (row) => <DraftRowActions draft={row} isAdmin={isAdmin} isDisabled={busy} onAction={onRowAction} />,
    },
  ], [workerAvailable, isAdmin, busy, onRowAction]);

  const visible = useMemo(() => (filter === "open" ? drafts.filter(isOpen) : drafts), [drafts, filter]);

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={1}>行业文档生成</Heading>
          <Text color="secondary">上传行业资料，由 AI 生成行业解决方案草稿；人工审核通过后发布到行业解决方案目录。</Text>
        </VStack>
        <Button label="新建草稿" onClick={() => setCreating(true)} />
      </HStack>
      <SegmentedControl label="草稿筛选" value={filter} onChange={(value) => setFilter(value as Filter)}>
        <SegmentedControlItem value="open" label="未完成" />
        <SegmentedControlItem value="all" label="全部" />
      </SegmentedControl>
      {!workerAvailable && (
        <Banner status="warning" title="生成服务未启用" description="排队中的生成任务不会被执行。请联系平台运维启用后再生成。" />
      )}
      {actionError && <Banner status="error" title={actionError} isDismissable onDismiss={() => setActionError(null)} />}
      {loading ? (
        <Card role="status" aria-label="草稿加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={() => void load()} />} />
      ) : (
        <Card padding={0}>
          <Table
            aria-label="方案草稿"
            tableProps={{ "aria-label": "方案草稿" }}
            data={visible as DraftRow[]}
            columns={columns}
            idKey="draft_id"
            emptyState={drafts.length > 0
              ? <EmptyState title="没有未完成的草稿" description="切换到「全部」查看已发布的草稿。" isCompact />
              : <EmptyState title="还没有草稿" description="点击「新建草稿」，上传行业资料开始生成。" isCompact />}
          />
        </Card>
      )}
      <AlertDialog
        isOpen={pending !== null}
        onOpenChange={(open) => { if (!open && !busy) setPending(null); }}
        title={pending?.action === "cancel" ? "取消生成" : "删除草稿"}
        description={pending?.action === "cancel"
          ? `取消「${pending.draft.title}」的生成任务？已有正文会保留，之后可以继续生成。`
          : pending ? deleteCopy(pending.draft).description : ""}
        cancelLabel="返回"
        actionLabel={pending?.action === "cancel" ? "确认取消" : "确认删除"}
        actionVariant="destructive"
        isActionLoading={busy}
        onAction={() => void confirmPending()}
      />
      <CreateDraftDialog isOpen={creating} onClose={() => setCreating(false)} onCreate={create} />
    </VStack>
  );
}
