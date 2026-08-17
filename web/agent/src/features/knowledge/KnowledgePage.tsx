/** Read-only projection of enterprise knowledge; ingestion is managed by Manager. */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { listDocuments, listIngestions, listKnowledgeBases, searchKnowledge } from "./useKnowledgeApi";
import type { DocumentStatus, KnowledgeBase, KnowledgeDocument, KnowledgeIngestion, KnowledgeSearchResult } from "./types";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "已上传", ingesting: "导入中", ready: "就绪", error: "失败",
};

export function KnowledgePage() {
  const { client } = useApp();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [ingestions, setIngestions] = useState<KnowledgeIngestion[]>([]);
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadBases = useCallback(async () => {
    setBases(await listKnowledgeBases(client));
  }, [client]);

  const loadProjection = useCallback(async (kbId: string | null) => {
    if (!kbId) {
      setDocs([]);
      setIngestions([]);
      return;
    }
    const [documents, jobs] = await Promise.all([listDocuments(client, kbId), listIngestions(client, kbId)]);
    setDocs(documents);
    setIngestions(jobs);
  }, [client]);

  useEffect(() => {
    void loadBases()
      .then(() => loadProjection(selectedKb))
      .catch((cause) => setError(cause instanceof ApiError ? cause.message : "加载知识库失败"))
      .finally(() => setLoading(false));
  }, [loadBases]);

  useEffect(() => {
    void loadProjection(selectedKb).catch((cause) => setActionError(cause instanceof ApiError ? cause.message : "加载文档失败"));
  }, [loadProjection, selectedKb]);

  async function handleSearch(): Promise<void> {
    if (!selectedKb || !query.trim()) return;
    setActionError(null);
    try {
      setResults(await searchKnowledge(client, selectedKb, query.trim()));
    } catch (cause) {
      setActionError(cause instanceof ApiError ? cause.message : "搜索失败");
    }
  }

  if (loading) return <Banner status="info" title="加载中…" />;
  if (error) return <Banner status="error" title={error} />;

  return (
    <VStack gap={4} role="region" aria-label="知识库">
      <HStack justify="between" align="center" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>知识库</Heading>
          <Text type="supporting">企业知识由 Manager 管理；用户端仅查看授权投影。</Text>
        </VStack>
      </HStack>
      {bases.length === 0 ? <EmptyState title="暂无授权知识库" /> : (
        <HStack gap={3} wrap="wrap">
          {bases.map((base) => (
            <Button key={base.kb_id} label={base.name} variant={selectedKb === base.kb_id ? "primary" : "secondary"}
              onClick={() => { setSelectedKb(base.kb_id); setResults([]); setActionError(null); }}
              endContent={<Text type="supporting">{base.doc_count} 文档</Text>} />
          ))}
        </HStack>
      )}
      {selectedKb && (
        <Card padding={4}>
          <VStack gap={3}>
            {actionError && <Banner status="error" title={actionError} />}
            <HStack gap={2} align="end">
              <TextInput label="语义搜索" isLabelHidden placeholder="语义搜索…" value={query} onChange={setQuery} width="100%" />
              <Button label="搜索" variant="primary" onClick={() => void handleSearch()} />
            </HStack>
            {results.length > 0 && <VStack gap={2}><Heading level={2}>搜索结果</Heading>{results.map((result) => (
              <Card key={result.doc_id} padding={2} variant="muted"><VStack gap={1}><Text weight="semibold">{result.title}</Text><Text type="supporting">{result.snippet}</Text></VStack></Card>
            ))}</VStack>}
            <VStack gap={2}>
              <Heading level={2}>授权文档 ({docs.length})</Heading>
              {docs.length === 0 ? <EmptyState title="暂无授权文档" headingLevel={3} isCompact /> : docs.map((doc) => (
                <Card key={doc.doc_id} padding={2} variant="muted"><HStack justify="between" align="center"><Text weight="semibold">{doc.title}</Text><Badge label={STATUS_LABEL[doc.status]} /></HStack></Card>
              ))}
            </VStack>
            {ingestions.length > 0 && <Text type="supporting">最近导入任务：{ingestions.length}（只读）</Text>}
          </VStack>
        </Card>
      )}
    </VStack>
  );
}
