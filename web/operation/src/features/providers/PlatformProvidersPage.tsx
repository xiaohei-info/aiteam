import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { serviceUrl } from "@aiteam/shared";
import type { PlatformModelWithRate, PlatformProvider } from "./types";
import { usePlatformProvidersApi } from "./usePlatformProvidersApi";

export function PlatformProvidersPage() {
  const api = usePlatformProvidersApi();
  const [providers, setProviders] = useState<PlatformProvider[]>([]);
  const [selected, setSelected] = useState<PlatformProvider | null>(null);
  const [models, setModels] = useState<PlatformModelWithRate[]>([]);
  const [rateModel, setRateModel] = useState<PlatformModelWithRate | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const items = await api.list();
      setProviders(items);
      const next = selected ? items.find((item) => item.provider_id === selected.provider_id) ?? items[0] : items[0];
      setSelected(next ?? null);
      setModels(next ? await api.models(next.provider_id) : []);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "加载大模型服务失败"); }
  }, [api, selected?.provider_id]);

  useEffect(() => { void load(); }, [load]);

  async function action(run: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(null);
    try { await run(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }

  async function choose(provider: PlatformProvider) {
    setSelected(provider);
    setModels(await api.models(provider.provider_id));
  }

  return (
    <VStack gap={5}>
      <HStack justify="between" align="center">
        <VStack gap={1}><Heading level={1}>大模型服务</Heading><Text color="secondary">默认连接内部 NewAPI，展示可用模型与版本化 USD 价格；渠道配置在 NewAPI 管理面完成。</Text></VStack>
        <HStack gap={2}>
          <VStack gap={0} align="end">
            <a
              href={serviceUrl(9300)}
              target="_blank"
              rel="noopener noreferrer"
              title="NewAPI 需要使用组件账号登录；管理 Token 仅由部署配置保存，不随链接传递。"
            >
              打开大模型网关
            </a>
            <Text type="supporting">需使用 NewAPI 组件账号登录</Text>
          </VStack>
        </HStack>
      </HStack>
      {error && <Banner status="error" title={error} />}
      <HStack gap={4} align="start" width="100%">
        <Card width={320}><VStack gap={2}>
          <Heading level={2}>内部 NewAPI</Heading>
          {providers.length === 0 ? <EmptyState title="暂无大模型服务" isCompact /> : providers.map((provider) => (
            <Button key={provider.provider_id} label={provider.display_name} variant={selected?.provider_id === provider.provider_id ? "secondary" : "ghost"} onClick={() => void choose(provider)} endContent={<Badge label={`v${provider.version} · ${provider.status}`} />} />
          ))}
        </VStack></Card>
        <Card width="100%"><VStack gap={3}>
          {selected ? <>
            <HStack justify="between" align="center">
              <VStack gap={1}><Heading level={2}>{selected.display_name}</Heading><Text type="code">{selected.relay_base_url}</Text></VStack>
              <HStack gap={2}>
                <Button label="同步公开价格" variant="secondary" isLoading={busy} onClick={() => void action(() => api.syncPublicPrices(selected.provider_id))} />
                <Button label="发布全部有价格模型" variant="secondary" isLoading={busy} isDisabled={selected.status !== "published" || busy} onClick={() => void action(() => api.publishPricedModels(selected.provider_id))} />
              </HStack>
            </HStack>
            {models.length === 0 ? <EmptyState title="NewAPI 暂无可用模型" description="请先在 NewAPI 管理面配置并启用上游渠道。" /> : models.map((item) => (
              <Card key={item.model.model_id} variant="muted"><HStack justify="between" align="center" gap={3}>
                <VStack gap={1}><Text weight="semibold">{item.model.display_name || item.model.model_id}</Text><HStack gap={1}><Badge label={item.model.status} /><Badge label={item.rate ? `$${item.rate.input_usd_per_million ?? "—"} / $${item.rate.output_usd_per_million ?? "—"} / 1M` : "价格未知"} variant={item.rate ? "info" : "warning"} /></HStack></VStack>
                <HStack gap={1}><Button label="设置价格" size="sm" variant="ghost" onClick={() => setRateModel(item)} /><Button label="发布模型" size="sm" variant="primary" isDisabled={!item.rate || item.model.status === "published" || busy} onClick={() => void action(() => api.publishModel(selected.provider_id, item.model.model_id))} /></HStack>
              </HStack></Card>
            ))}
          </> : <EmptyState title="内部 NewAPI 尚未就绪" description="请先检查 Operation 的 NewAPI 连接配置。" />}
        </VStack></Card>
      </HStack>
      {selected && rateModel && <RateDialog item={rateModel} busy={busy} onClose={() => setRateModel(null)} onSave={(input) => action(async () => { await api.setRate(selected.provider_id, input); setRateModel(null); })} />}
    </VStack>
  );
}

function RateDialog({ item, busy, onClose, onSave }: { item: PlatformModelWithRate; busy: boolean; onClose: () => void; onSave: (input: Record<string, unknown>) => Promise<void> }) {
  const [input, setInput] = useState(item.rate?.input_usd_per_million ?? ""); const [output, setOutput] = useState(item.rate?.output_usd_per_million ?? ""); const [cacheRead, setCacheRead] = useState(item.rate?.cache_read_usd_per_million ?? ""); const [cacheWrite, setCacheWrite] = useState(item.rate?.cache_write_usd_per_million ?? "");
  function submit(event: FormEvent) { event.preventDefault(); void onSave({ model_id: item.model.model_id, pricing_status: "known", billing_mode: "token", input_usd_per_million: input, output_usd_per_million: output, cache_read_usd_per_million: cacheRead || null, cache_write_usd_per_million: cacheWrite || null, source: "manual" }); }
  return <Dialog isOpen purpose="form" width={560} aria-label="设置模型价格" onOpenChange={(open) => { if (!open && !busy) onClose(); }}><form onSubmit={submit}><VStack gap={3}><Heading level={2}>{item.model.model_id} · USD / 1M tokens</Heading><TextInput label="输入价格" value={input} onChange={setInput} isRequired /><TextInput label="输出价格" value={output} onChange={setOutput} isRequired /><TextInput label="缓存读取价格" value={cacheRead} onChange={setCacheRead} isOptional /><TextInput label="缓存写入价格" value={cacheWrite} onChange={setCacheWrite} isOptional /><HStack justify="end" gap={2}><Button label="取消" onClick={onClose} isDisabled={busy} /><Button label="保存价格版本" type="submit" variant="primary" isLoading={busy} /></HStack></VStack></form></Dialog>;
}
