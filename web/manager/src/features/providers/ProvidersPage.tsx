/** Manager read-only view of Operator-published platform Provider/model/rates (D18). */
import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { usePlatformModelsApi, type PlatformCatalog } from "../platform-models/usePlatformModelsApi";

export function ProvidersPage() {
  const api = usePlatformModelsApi();
  const [catalog, setCatalog] = useState<PlatformCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.list().then((value) => { setCatalog(value); setError(null); }).catch((cause) => setError(cause instanceof Error ? cause.message : "平台模型目录加载失败"));
  }, [api]);

  return <VStack gap={5} data-testid="providers-page">
    <VStack gap={1}><Heading level={1}>平台模型目录</Heading><Text color="secondary">Provider、模型和价格由 Operator 统一发布；企业只能为员工选择这里的模型，不能创建 Provider 或修改价格。</Text></VStack>
    {error && <Banner status="error" title={error} />}
    {!catalog ? <Banner status="info" title="加载中…" /> : catalog.models.length === 0 ? <EmptyState title="暂无可用平台模型" description="请联系平台运营人员发布 Provider、模型和价格。" /> : catalog.providers.map((provider) => {
      const models = catalog.models.filter((item) => item.model.provider_id === provider.provider_id);
      return <Card key={provider.provider_id}><VStack gap={3}>
        <HStack gap={2} align="center"><Heading level={2}>{provider.display_name}</Heading><Badge label={`v${provider.version}`} /><Badge label={provider.status} /></HStack>
        {models.map((item) => <Card key={item.model.model_id} variant="muted" padding={3}><HStack justify="between" align="center">
          <VStack gap={1}><Text weight="semibold">{item.model.display_name || item.model.model_id}</Text><Text type="code">{item.model.model_id}</Text></VStack>
          <Badge label={item.rate ? `$${item.rate.input_usd_per_million}/$${item.rate.output_usd_per_million} / 1M tokens · price v${item.rate.pricing_version}` : "价格未知"} variant={item.rate ? "info" : "warning"} />
        </HStack></Card>)}
      </VStack></Card>;
    })}
  </VStack>;
}
