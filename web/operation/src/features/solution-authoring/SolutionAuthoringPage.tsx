/** 行业文档生成：草稿列表与新建入口。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CreateDraftDialog } from "./CreateDraftDialog";
import { draftStatus, formatTime } from "./labels";
import type { DraftCreateInput, DraftSummary } from "./types";
import { useSolutionAuthoringApi } from "./useSolutionAuthoringApi";

type DraftRow = DraftSummary & Record<string, unknown>;

export function SolutionAuthoringPage(): ReactNode {
  const api = useSolutionAuthoringApi();
  const navigate = useNavigate();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++sequence.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.list();
      if (requestId === sequence.current) setDrafts(next);
    } catch (err) {
      if (requestId === sequence.current) setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      if (requestId === sequence.current) setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

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
    { key: "status", header: "状态", width: pixel(120), renderCell: (row) => { const status = draftStatus(row.status); return <Badge label={status.label} variant={status.variant} />; } },
    { key: "model", header: "生成模型", width: proportional(1), renderCell: (row) => row.platform_model_ref.model_id },
    { key: "updated_at", header: "最近更新", width: pixel(190), renderCell: (row) => formatTime(row.updated_at) },
  ], []);

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={1}>行业文档生成</Heading>
          <Text color="secondary">上传行业资料，由 AI 生成行业解决方案草稿；人工审核通过后发布到行业解决方案目录。</Text>
        </VStack>
        <Button label="新建草稿" onClick={() => setCreating(true)} />
      </HStack>
      {loading ? (
        <Card role="status" aria-label="草稿加载中"><Skeleton height={120} /></Card>
      ) : error ? (
        <Banner status="error" title={error} endContent={<Button label="重试" variant="ghost" onClick={() => void load()} />} />
      ) : (
        <Card padding={0}>
          <Table
            aria-label="方案草稿"
            tableProps={{ "aria-label": "方案草稿" }}
            data={drafts as DraftRow[]}
            columns={columns}
            idKey="draft_id"
            emptyState={<EmptyState title="还没有草稿" description="点击「新建草稿」，上传行业资料开始生成。" isCompact />}
          />
        </Card>
      )}
      <CreateDraftDialog isOpen={creating} onClose={() => setCreating(false)} onCreate={create} />
    </VStack>
  );
}
