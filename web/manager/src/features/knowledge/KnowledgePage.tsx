import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole, serviceUrl } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { DocumentsPanel } from "./DocumentsPanel";
import type { KnowledgeAnalytics, KnowledgeSpace } from "./types";
import { useKnowledgeApi } from "./useKnowledgeApi";

type KnowledgeSpaceRow = KnowledgeSpace & Record<string, unknown>;

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function KnowledgePage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useKnowledgeApi();
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<KnowledgeAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);
  const [documentSpaceId, setDocumentSpaceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextSpaces = (await api.list()).slice(0, 1);
      setSpaces(nextSpaces);
      setAnalytics(null);
      setAnalyticsError(null);
      const enterprise = nextSpaces[0];
      if (enterprise && api.getAnalytics) {
        try {
          setAnalytics(await api.getAnalytics(enterprise.knowledge_space_id));
        } catch (err) {
          setAnalyticsError(err instanceof ApiError ? err.message : "LightRAG 统计暂不可用");
        }
      }
    } catch (err) {
      setSpaces([]);
      setAnalytics(null);
      setError(err instanceof ApiError ? err.message : "加载企业知识库失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const enterpriseSpace = spaces[0] ?? null;
  const documentSpace = enterpriseSpace?.knowledge_space_id === documentSpaceId ? enterpriseSpace : null;
  const columns: TableColumn<KnowledgeSpaceRow>[] = [
    { key: "display_name", header: "知识库", width: proportional(1), renderCell: () => <Text weight="bold">企业知识库</Text> },
    {
      key: "actions",
      header: "操作",
      width: pixel(240),
      align: "end",
      resizable: false,
      renderCell: (space) => (
        <Button
          label="管理企业知识库文档"
          variant="ghost"
          size="sm"
          onClick={() => setDocumentSpaceId(space.knowledge_space_id)}
        />
      ),
    },
  ];

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" align="center">
        <VStack gap={1}>
          <Heading level={1}>企业知识库</Heading>
          <Text type="supporting">此页面管理企业文档及 LightRAG 索引状态；引用正文请由用户端 Agent Pi 通过 knowledge_get 获取。</Text>
        </VStack>
        {canWrite && (
          <VStack gap={0} align="end">
            <a
              href={serviceUrl(9621, "/webui/")}
              target="_blank"
              rel="noopener noreferrer"
              title="LightRAG 需要使用 LIGHTRAG_AUTH_ACCOUNTS 中配置的账号密码登录；密码不显示在页面中。"
            >
              打开 LightRAG 控制台
            </a>
            <Text type="supporting">账号由 LIGHTRAG_AUTH_ACCOUNTS 配置</Text>
          </VStack>
        )}
      </HStack>

      {error && <Banner status="error" title={error} />}
      {analyticsError && <Banner status="info" title={analyticsError} />}
      {analytics?.status === "unavailable" && (
        <Banner status="info" title="LightRAG 统计暂不可用；仍可查看 Manager 文档状态与操作。" />
      )}
      {analytics && analytics.status !== "unavailable" && (
        <VStack gap={3} aria-label="知识库统计">
          <Grid columns={{ minWidth: 180, repeat: "fit" }} gap={3}>
            <Card><VStack gap={1}><Text type="supporting">文档总数</Text><Heading level={2}>{analytics.document_count}</Heading><Text type="supporting">就绪 {analytics.ready_count} · 处理中 {analytics.processing_count}</Text></VStack></Card>
            <Card><VStack gap={1}><Text type="supporting">索引失败</Text><Heading level={2}>{analytics.failed_count}</Heading><Text type="supporting">已删除 {analytics.deleted_count}</Text></VStack></Card>
            <Card><VStack gap={1}><Text type="supporting">内容规模</Text><Heading level={2}>{formatBytes(analytics.total_bytes)}</Heading><Text type="supporting">文本 {analytics.total_text_chars.toLocaleString()} 字符 · 分块 {analytics.total_chunks.toLocaleString()}</Text></VStack></Card>
            <Card><VStack gap={1}><Text type="supporting">LightRAG 索引</Text><Heading level={2}>{analytics.upstream_document_count == null ? "—" : "已同步"}</Heading><Text type="supporting">文档 {analytics.upstream_document_count ?? "—"} · 已处理 {analytics.upstream_ready_count ?? "—"} · 失败 {analytics.upstream_failed_count ?? "—"}</Text></VStack></Card>
          </Grid>
          {analytics.daily_activity.length > 0 && (
            <Card>
              <VStack gap={2}>
                <Text weight="bold">最近文档活动</Text>
                <HStack gap={4} wrap="wrap">
                  {analytics.daily_activity.slice(-7).map((day) => (
                    <Text key={day.date} type="supporting">{day.date} · {day.activity_count} 次（新增 {day.documents_created} · 摄入 {day.ingestions}）</Text>
                  ))}
                </HStack>
              </VStack>
            </Card>
          )}
        </VStack>
      )}
      {loading ? (
        <Card role="status" aria-label="正在加载企业知识库">
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : (
        <Card padding={0}>
          <Table
            aria-label="企业知识库"
            tableProps={{ "aria-label": "企业知识库" }}
            data={(enterpriseSpace ? [enterpriseSpace] : []) as KnowledgeSpaceRow[]}
            columns={columns}
            idKey="knowledge_space_id"
            hasHover
            emptyState={<EmptyState title="企业知识库尚未初始化" description="当前 Manager 尚未配置企业 LightRAG workspace。" isCompact />}
          />
        </Card>
      )}

      {documentSpace && (
        <DocumentsPanel
          spaceId={documentSpace.knowledge_space_id}
          spaceName="企业知识库"
          canWrite={canWrite}
          analytics={analytics}
          onChanged={() => void load()}
          onClose={() => setDocumentSpaceId(null)}
        />
      )}
    </VStack>
  );
}
