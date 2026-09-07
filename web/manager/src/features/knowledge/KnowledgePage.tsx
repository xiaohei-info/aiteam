import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole, serviceUrl } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { DocumentsPanel } from "./DocumentsPanel";
import type { KnowledgeAnalytics, KnowledgeSpace } from "./types";
import { useKnowledgeApi } from "./useKnowledgeApi";

export function KnowledgePage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useKnowledgeApi();
  const [spaces, setSpaces] = useState<KnowledgeSpace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<KnowledgeAnalytics | null>(null);
  const [analyticsError, setAnalyticsError] = useState<string | null>(null);

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

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" align="center">
        <VStack gap={1}>
          <Heading level={1}>企业知识库</Heading>
          <Text type="supporting">此页面管理企业文档及 LightRAG 索引状态；引用正文请由用户端 Agent Pi 通过 knowledge_get 获取。</Text>
          <Text type="supporting">删除文档影响整个企业；仅限制某位专家请在专家配置的知识访问策略中禁用或撤销。重建索引不会恢复管理员已拒绝的权限。</Text>
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
      {loading ? (
        <Card role="status" aria-label="正在加载企业知识库">
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={36} index={1} /></VStack>
        </Card>
      ) : !enterpriseSpace ? (
        <Card><EmptyState title="企业知识库尚未初始化" description="当前 Manager 尚未配置企业 LightRAG workspace。" isCompact /></Card>
      ) : (
        <VStack gap={3}>
          <VStack gap={1}>
            <Heading level={2}>企业文档</Heading>
            <Text type="supporting">文档、索引状态和摄入进度直接显示在本页；引用正文由 Agent Pi 通过 knowledge_get 获取。</Text>
          </VStack>
          <DocumentsPanel
            embedded
            spaceId={enterpriseSpace.knowledge_space_id}
            spaceName="企业知识库"
            canWrite={canWrite}
            analytics={analytics}
            onChanged={() => void load()}
          />
        </VStack>
      )}
    </VStack>
  );
}
