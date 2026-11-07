import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { serviceUrl } from "@aiteam/shared";
import { CapabilitiesDialog } from "./CapabilitiesDialog";
import { ChannelsPanel } from "./ChannelsPanel";
import { formatTokens } from "./channelForm";
import type { GatewayChannel, GatewayChannelType, PlatformModel, PlatformModelWithRate, PlatformProvider } from "./types";
import { usePlatformProvidersApi } from "./usePlatformProvidersApi";

type PageTab = "config" | "pricing";

export function PlatformProvidersPage() {
  const api = usePlatformProvidersApi();
  const [providers, setProviders] = useState<PlatformProvider[]>([]);
  const [selected, setSelected] = useState<PlatformProvider | null>(null);
  const [models, setModels] = useState<PlatformModelWithRate[]>([]);
  const [channels, setChannels] = useState<GatewayChannel[]>([]);
  const [channelTypes, setChannelTypes] = useState<GatewayChannelType[]>([]);
  const [channelError, setChannelError] = useState<string | null>(null);
  const [tab, setTab] = useState<PageTab>("config");
  const [rateModel, setRateModel] = useState<PlatformModelWithRate | null>(null);
  const [capabilityModel, setCapabilityModel] = useState<PlatformModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadChannels = useCallback(async (providerId: string) => {
    try {
      const [items, types] = await Promise.all([api.channels(providerId), api.channelTypes(providerId)]);
      setChannels(items);
      setChannelTypes(types);
      setChannelError(null);
    } catch (cause) {
      setChannels([]);
      setChannelError(cause instanceof Error ? cause.message : "读取上游渠道失败");
    }
  }, [api]);

  const load = useCallback(async () => {
    try {
      const items = await api.list();
      setProviders(items);
      const next = selected ? items.find((item) => item.provider_id === selected.provider_id) ?? items[0] : items[0];
      setSelected(next ?? null);
      setModels(next ? await api.models(next.provider_id) : []);
      if (next) await loadChannels(next.provider_id);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "加载大模型服务失败"); }
  }, [api, loadChannels, selected?.provider_id]);

  useEffect(() => { void load(); }, [load]);

  async function action(run: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(null);
    try { await run(); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败"); }
    finally { setBusy(false); }
  }

  /** Like action(), but rethrows so the open dialog can show the error and stay open. */
  async function dialogAction(run: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    try { await run(); await load(); }
    finally { setBusy(false); }
  }

  async function choose(provider: PlatformProvider) {
    setSelected(provider);
    setModels(await api.models(provider.provider_id));
    await loadChannels(provider.provider_id);
  }

  return (
    <VStack gap={5}>
      <HStack justify="between" align="center">
        <VStack gap={1}><Heading level={1}>大模型服务</Heading><Text color="secondary">统一通过 LLM 网关提供模型：在「模型配置」维护上游渠道与模型能力，在「价格」维护版本化 USD 价格。</Text></VStack>
        <HStack gap={2}>
          <VStack gap={0} align="end">
            <a
              href={serviceUrl(9300)}
              target="_blank"
              rel="noopener noreferrer"
              title="LLM 网关需要使用组件账号登录；管理凭据仅由部署配置保存，不随链接传递。"
            >
              打开 LLM 网关
            </a>
            <Text type="supporting">需使用网关组件账号登录</Text>
          </VStack>
        </HStack>
      </HStack>
      {error && <Banner status="error" title={error} />}
      <HStack gap={4} align="start" width="100%">
        <Card width={320}><VStack gap={2}>
          <Heading level={2}>LLM 网关</Heading>
          {providers.length === 0 ? <EmptyState title="暂无大模型服务" isCompact /> : providers.map((provider) => (
            <Button key={provider.provider_id} label={provider.display_name} variant={selected?.provider_id === provider.provider_id ? "secondary" : "ghost"} onClick={() => void choose(provider)} endContent={<Badge label={`v${provider.version} · ${provider.status}`} />} />
          ))}
        </VStack></Card>
        <Card width="100%"><VStack gap={3}>
          {selected ? <>
            <VStack gap={1}><Heading level={2}>{selected.display_name}</Heading><Text type="code">{selected.relay_base_url}</Text></VStack>
            <TabList aria-label="大模型服务" value={tab} onChange={(value) => setTab(value as PageTab)} hasDivider>
              <Tab value="config" label="模型配置" />
              <Tab value="pricing" label="价格" />
            </TabList>
            {tab === "config" ? <>
              {channelError && <Banner status="error" title={channelError} />}
              <ChannelsPanel
                channels={channels}
                types={channelTypes}
                models={models.map((item) => item.model)}
                busy={busy}
                onSave={(channel, input) => dialogAction(() => channel ? api.updateChannel(selected.provider_id, channel.id, input) : api.createChannel(selected.provider_id, input))}
                onDelete={(channel) => action(() => api.deleteChannel(selected.provider_id, channel.id))}
                onToggle={(channel, enabled) => action(() => api.setChannelEnabled(selected.provider_id, channel.id, enabled))}
                onTest={(channel) => api.testChannel(selected.provider_id, channel.id)}
                onFetchModels={(input) => api.upstreamModels(selected.provider_id, input)}
                onSaveCapabilities={(modelId, input) => dialogAction(() => api.updateModelCapabilities(selected.provider_id, modelId, input))}
              />
              <VStack gap={1}><Heading level={2}>模型能力</Heading><Text type="supporting">上下文窗口、最大输出、思考档位和图片输入会随员工配置下发到本机运行时。</Text></VStack>
              {models.length === 0 ? <EmptyState title="LLM 网关暂无可用模型" description="请先新增并启用上游渠道。" /> : models.map((item) => (
                <Card key={item.model.model_id} variant="muted"><HStack justify="between" align="center" gap={3}>
                  <VStack gap={1}>
                    <Text weight="semibold">{item.model.display_name || item.model.model_id}</Text>
                    <HStack gap={1}>
                      <Badge label={`上下文 ${formatTokens(item.model.capabilities.context_window)}`} />
                      <Badge label={`最大输出 ${formatTokens(item.model.capabilities.max_tokens)}`} />
                      <Badge label={item.model.capabilities.reasoning === true ? "支持思考" : "不思考"} variant={item.model.capabilities.reasoning === true ? "info" : "neutral"} />
                      {Array.isArray(item.model.capabilities.input) && item.model.capabilities.input.includes("image") && <Badge label="图片输入" variant="info" />}
                    </HStack>
                  </VStack>
                  <Button label="配置模型" size="sm" variant="ghost" onClick={() => setCapabilityModel(item.model)} />
                </HStack></Card>
              ))}
            </> : <>
              <HStack justify="between" align="center">
                <Text type="supporting">新模型会自动补齐公开价格并发布；无公开价格的模型请先录入价格再发布。</Text>
                <Button label="同步价格更新" variant="secondary" isLoading={busy} onClick={() => void action(() => api.syncPublicPrices(selected.provider_id))} />
              </HStack>
              {models.length === 0 ? <EmptyState title="LLM 网关暂无可用模型" description="请先在「模型配置」中新增并启用上游渠道。" /> : models.map((item) => (
                <Card key={item.model.model_id} variant="muted"><HStack justify="between" align="center" gap={3}>
                  <VStack gap={1}><Text weight="semibold">{item.model.display_name || item.model.model_id}</Text><HStack gap={1}><Badge label={item.model.status} /><Badge label={item.rate ? `$${item.rate.input_usd_per_million ?? "—"} / $${item.rate.output_usd_per_million ?? "—"} / 1M` : "价格未知"} variant={item.rate ? "info" : "warning"} /></HStack></VStack>
                  <HStack gap={1}>
                    <Button label="设置价格" size="sm" variant="ghost" onClick={() => setRateModel(item)} />
                    {item.model.status !== "published" && item.rate?.pricing_status === "known" && (
                      <Button label="发布模型" size="sm" variant="secondary" isLoading={busy} onClick={() => void action(() => api.publishModel(selected.provider_id, item.model.model_id))} />
                    )}
                  </HStack>
                </HStack></Card>
              ))}
            </>}
          </> : <EmptyState title="LLM 网关尚未就绪" description="请先检查 Operation 的 LLM 网关连接配置。" />}
        </VStack></Card>
      </HStack>
      {selected && rateModel && <RateDialog item={rateModel} busy={busy} onClose={() => setRateModel(null)} onSave={(input) => action(async () => { await api.setRate(selected.provider_id, input); setRateModel(null); })} />}
      {selected && capabilityModel && (
        <CapabilitiesDialog
          model={capabilityModel}
          busy={busy}
          onClose={() => setCapabilityModel(null)}
          onSave={(input) => dialogAction(async () => { await api.updateModelCapabilities(selected.provider_id, capabilityModel.model_id, input); setCapabilityModel(null); })}
        />
      )}
    </VStack>
  );
}

function RateDialog({ item, busy, onClose, onSave }: { item: PlatformModelWithRate; busy: boolean; onClose: () => void; onSave: (input: Record<string, unknown>) => Promise<void> }) {
  const [input, setInput] = useState(item.rate?.input_usd_per_million ?? ""); const [output, setOutput] = useState(item.rate?.output_usd_per_million ?? ""); const [cacheRead, setCacheRead] = useState(item.rate?.cache_read_usd_per_million ?? ""); const [cacheWrite, setCacheWrite] = useState(item.rate?.cache_write_usd_per_million ?? "");
  function submit(event: FormEvent) { event.preventDefault(); void onSave({ model_id: item.model.model_id, pricing_status: "known", billing_mode: "token", input_usd_per_million: input, output_usd_per_million: output, cache_read_usd_per_million: cacheRead || null, cache_write_usd_per_million: cacheWrite || null, source: "manual" }); }
  return <Dialog isOpen purpose="form" width={560} aria-label="设置模型价格" onOpenChange={(open) => { if (!open && !busy) onClose(); }}><form onSubmit={submit}><VStack gap={3}><Heading level={2}>{item.model.model_id} · USD / 1M tokens</Heading><TextInput label="输入价格" value={input} onChange={setInput} isRequired /><TextInput label="输出价格" value={output} onChange={setOutput} isRequired /><TextInput label="缓存读取价格" value={cacheRead} onChange={setCacheRead} isOptional /><TextInput label="缓存写入价格" value={cacheWrite} onChange={setCacheWrite} isOptional /><HStack justify="end" gap={2}><Button label="取消" onClick={onClose} isDisabled={busy} /><Button label="保存价格版本" type="submit" variant="primary" isLoading={busy} /></HStack></VStack></form></Dialog>;
}
