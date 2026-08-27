import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
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
import { Link } from "react-router-dom";
import { useSession } from "../../auth/session";
import { DocumentsPanel } from "./DocumentsPanel";
import type { KnowledgeSpace } from "./types";
import { useKnowledgeApi } from "./useKnowledgeApi";

type KnowledgeSpaceRow = KnowledgeSpace & Record<string, unknown>;

export function KnowledgePage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useKnowledgeApi();
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [documentSpaceId, setDocumentSpaceId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSpaces((await api.list()).slice(0, 1));
    } catch (err) {
      setSpaces([]);
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
        {canWrite && <Link to="/knowledge-console">打开 LightRAG 控制台</Link>}
      </HStack>

      {error && <Banner status="error" title={error} />}
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
          onClose={() => setDocumentSpaceId(null)}
        />
      )}
    </VStack>
  );
}
