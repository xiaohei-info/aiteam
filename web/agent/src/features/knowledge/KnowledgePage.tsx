/** P08 知识库页 — 列表 + 搜索 + 文档导入 (File/URL) + 摄入状态。 (AITEAM-260) */
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  importUrl,
  listDocuments,
  listIngestions,
  listKnowledgeBases,
  retryDocument,
  searchKnowledge,
  uploadDocument,
} from "./useKnowledgeApi";
import type {
  DocumentStatus,
  KnowledgeBase,
  KnowledgeDocument,
  KnowledgeIngestion,
  KnowledgeSearchResult,
} from "./types";

type Tab = "file" | "url";

const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: "已上传",
  ingesting: "导入中",
  ready: "就绪",
  error: "失败",
};

const STATUS_VARIANT: Record<DocumentStatus, "neutral" | "warning" | "success" | "error"> = {
  uploaded: "neutral", ingesting: "warning", ready: "success", error: "error",
};

export function KnowledgePage() {
  const { client } = useApp();
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [selectedKb, setSelectedKb] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [docs, setDocs] = useState<KnowledgeDocument[]>([]);
  const [ingestions, setIngestions] = useState<KnowledgeIngestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("file");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBases = useCallback(async () => {
    try {
      setBases(await listKnowledgeBases(client));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载知识库失败");
    }
  }, [client]);

  const loadDocs = useCallback(async () => {
    if (!selectedKb) {
      setDocs([]);
      setIngestions([]);
      return;
    }
    try {
      const [d, i] = await Promise.all([
        listDocuments(client, selectedKb),
        listIngestions(client, selectedKb),
      ]);
      setDocs(d);
      setIngestions(i);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "加载文档失败");
    }
  }, [client, selectedKb]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await loadBases();
      await loadDocs();
    } finally {
      setLoading(false);
    }
  }, [loadBases, loadDocs]);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    void loadDocs();
  }, [selectedKb, loadDocs]);

  // 轮询：当存在 ingesting 状态的 job 时自动刷
  useEffect(() => {
    if (!selectedKb) return;
    if (!ingestions.some((j) => j.status === "pending" || j.status === "parsing" || j.status === "inserting")) {
      return;
    }
    const id = window.setTimeout(() => void loadDocs(), 1500);
    return () => window.clearTimeout(id);
  }, [selectedKb, ingestions, loadDocs]);

  const handleSearch = useCallback(async () => {
    if (!selectedKb || !query) return;
    setActionError(null);
    try {
      setSearchResults(await searchKnowledge(client, selectedKb, query));
    } catch (errSearch) {
      setActionError(errSearch instanceof ApiError ? errSearch.message : "搜索失败");
    }
  }, [client, selectedKb, query]);

  const handleUpload = useCallback(async () => {
    if (!selectedKb || !fileRef.current?.files?.[0]) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await uploadDocument(client, selectedKb, fileRef.current.files[0]);
      if (fileRef.current) fileRef.current.value = "";
      await loadDocs();
    } catch (errUpload) {
      setActionError(errUpload instanceof ApiError ? errUpload.message : "上传失败");
    } finally {
      setSubmitting(false);
    }
  }, [client, selectedKb, loadDocs]);

  const handleImportUrl = useCallback(async () => {
    if (!selectedKb || !url.trim()) return;
    setActionError(null);
    setSubmitting(true);
    try {
      await importUrl(client, selectedKb, url.trim());
      setUrl("");
      await loadDocs();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "导入失败");
    } finally {
      setSubmitting(false);
    }
  }, [client, selectedKb, url, loadDocs]);

  const handleRetry = useCallback(
    async (doc: KnowledgeDocument) => {
      if (!selectedKb) return;
      setActionError(null);
      try {
        await retryDocument(client, selectedKb, doc.doc_id);
        await loadDocs();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "重试失败");
      }
    },
    [client, selectedKb, loadDocs],
  );

  if (loading) {
    return <Banner status="info" title="加载中…" />;
  }
  if (error) {
    return <Banner status="error" title={error} />;
  }

  return (
    <VStack gap={4} role="region" aria-label="知识库">
      <Heading level={1}>知识库</Heading>
      {bases.length === 0 ? <EmptyState title="暂无知识库" /> : (
        <HStack gap={3} wrap="wrap">
          {bases.map((kb) => (
            <Button
              key={kb.kb_id}
              label={kb.name}
              variant={selectedKb === kb.kb_id ? "primary" : "secondary"}
              onClick={() => { setSelectedKb(kb.kb_id); setActionError(null); setSearchResults([]); }}
              endContent={<Text type="supporting">{kb.doc_count} 文档 · {(kb.size_kb / 1024).toFixed(1)} MB</Text>}
            />
          ))}
        </HStack>
      )}
      {selectedKb && (
        <Card padding={4}>
          <VStack gap={3}>
            <HStack gap={1} role="tablist" aria-label="导入方式">
              <Button label="本地文件" role="tab" aria-selected={tab === "file"} variant={tab === "file" ? "primary" : "secondary"} onClick={() => setTab("file")} />
              <Button label="从 URL 导入" role="tab" aria-selected={tab === "url"} variant={tab === "url" ? "primary" : "secondary"} onClick={() => setTab("url")} />
            </HStack>
            {actionError && <Banner status="error" title={actionError} />}
            {tab === "file" ? (
              <HStack gap={2} align="center">
                <input ref={fileRef} type="file" hidden onChange={() => void handleUpload()} disabled={submitting} />
                <Button label="选择文件" variant="secondary" onClick={() => fileRef.current?.click()} isDisabled={submitting} />
              </HStack>
            ) : (
              <HStack gap={2} align="end">
                <TextInput label="网页地址" isLabelHidden placeholder="https://example.com/article" value={url} onChange={setUrl} width="100%" isDisabled={submitting} />
                <Button label="导入" variant="primary" onClick={() => void handleImportUrl()} isLoading={submitting} />
              </HStack>
            )}
            <HStack gap={2} align="end">
              <TextInput label="语义搜索" isLabelHidden placeholder="语义搜索…" value={query} onChange={setQuery} width="100%" />
              <Button label="搜索" variant="primary" onClick={() => void handleSearch()} />
            </HStack>
            {searchResults.length > 0 && (
              <VStack gap={2}><Heading level={2}>搜索结果</Heading>{searchResults.map((result) => (
                <Card key={result.doc_id} padding={2} variant="muted"><VStack gap={1}><Text weight="semibold">{result.title}</Text><Text type="supporting">{result.snippet}</Text><Text type="supporting">相关度: {(result.score * 100).toFixed(0)}%</Text></VStack></Card>
              ))}</VStack>
            )}
            <VStack gap={2}>
              <Heading level={2}>文档 ({docs.length})</Heading>
              {docs.length === 0 ? <EmptyState title="暂无文档" headingLevel={3} isCompact /> : docs.map((doc) => (
                <Card key={doc.doc_id} padding={2} variant="muted">
                  <HStack justify="between" align="center" wrap="wrap">
                    <VStack gap={1}><HStack gap={1}><Text weight="semibold">{doc.title}</Text><Badge label={STATUS_LABEL[doc.status]} variant={STATUS_VARIANT[doc.status]} />{doc.source_kind === "url" && <Badge label="URL" />}</HStack>{doc.snippet && <Text type="supporting">{doc.snippet}</Text>}{doc.error_message && <Text type="supporting">{doc.error_message}</Text>}</VStack>
                    <HStack gap={1}>{doc.status === "ready" && <Text type="supporting">{doc.chunk_count} chunks</Text>}{doc.status === "error" && <Button label="重试" variant="secondary" size="sm" onClick={() => void handleRetry(doc)} />}</HStack>
                  </HStack>
                </Card>
              ))}
            </VStack>
          </VStack>
        </Card>
      )}
    </VStack>
  );
}
