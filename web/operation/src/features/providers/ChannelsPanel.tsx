import { useState } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ChannelDialog } from "./ChannelDialog";
import { channelStatusLabel } from "./channelForm";
import type { GatewayChannel, GatewayChannelInput, GatewayChannelTestResult, GatewayChannelType, UpstreamModelPreviewInput } from "./types";

interface Props {
  channels: GatewayChannel[];
  types: GatewayChannelType[];
  busy: boolean;
  onSave: (channel: GatewayChannel | null, input: GatewayChannelInput) => Promise<void>;
  onDelete: (channel: GatewayChannel) => Promise<void>;
  onToggle: (channel: GatewayChannel, enabled: boolean) => Promise<void>;
  onTest: (channel: GatewayChannel) => Promise<GatewayChannelTestResult | null>;
  onFetchModels: (input: UpstreamModelPreviewInput) => Promise<string[]>;
}

type Editing = { channel: GatewayChannel | null } | null;

/** Upstream channels of the LLM gateway: URL, key (write-only), models and compatibility overrides. */
export function ChannelsPanel({ channels, types, busy, onSave, onDelete, onToggle, onTest, onFetchModels }: Props) {
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<GatewayChannel | null>(null);
  const [testing, setTesting] = useState<number | null>(null);
  const [results, setResults] = useState<Record<number, GatewayChannelTestResult>>({});

  async function test(channel: GatewayChannel) {
    setTesting(channel.id);
    try {
      const result = await onTest(channel);
      if (result) setResults((current) => ({ ...current, [channel.id]: result }));
    } finally {
      setTesting(null);
    }
  }

  return (
    <VStack gap={3}>
      <HStack justify="between" align="center">
        <VStack gap={1}>
          <Heading level={2}>上游渠道</Heading>
          <Text type="supporting">上游地址和 API Key 只保存在 LLM 网关，不下发给企业端和员工本机；Key 保存后不再显示。</Text>
        </VStack>
        <Button label="新增渠道" variant="primary" isDisabled={busy} onClick={() => setEditing({ channel: null })} />
      </HStack>
      {channels.length === 0 ? <EmptyState title="暂无上游渠道" description="新增渠道并填写上游地址、API Key 和模型后，模型会自动出现在下方。" isCompact /> : channels.map((channel) => {
        const status = channelStatusLabel(channel.status);
        const result = results[channel.id];
        const enabled = channel.status === "enabled";
        return (
          <Card key={channel.id} variant="muted">
            <VStack gap={2}>
              <HStack justify="between" align="center" gap={3}>
                <VStack gap={1}>
                  <HStack gap={1} align="center">
                    <Text weight="semibold">{channel.name}</Text>
                    <Badge label={status.label} variant={status.variant} />
                    <Badge label={channel.channel_type_label} />
                  </HStack>
                  <Text type="code">{channel.base_url || "官方地址"}</Text>
                  <Text type="supporting">{channel.models.length} 个模型：{channel.models.slice(0, 6).join("、")}{channel.models.length > 6 ? " 等" : ""}</Text>
                </VStack>
                <HStack gap={1}>
                  <Button label="测试连接" size="sm" variant="secondary" isLoading={testing === channel.id} isDisabled={busy} onClick={() => void test(channel)} />
                  <Button label="编辑" size="sm" variant="ghost" isDisabled={busy} onClick={() => setEditing({ channel })} />
                  <Button label={enabled ? "停用" : "启用"} size="sm" variant="ghost" isDisabled={busy} onClick={() => void onToggle(channel, !enabled)} />
                  <Button label="删除" size="sm" variant="ghost" isDisabled={busy} onClick={() => setDeleting(channel)} />
                </HStack>
              </HStack>
              {result && (result.ok
                ? <Banner status="success" title={`连接正常${result.seconds !== null ? `，耗时 ${result.seconds.toFixed(2)} 秒` : ""}`} />
                : <Banner status="error" title={`连接失败：${result.message || "上游没有返回原因"}`} />)}
            </VStack>
          </Card>
        );
      })}
      {editing && (
        <ChannelDialog
          channel={editing.channel}
          types={types}
          busy={busy}
          onClose={() => setEditing(null)}
          onFetchModels={onFetchModels}
          onSave={async (input) => { await onSave(editing.channel, input); setEditing(null); }}
        />
      )}
      <AlertDialog
        isOpen={deleting !== null}
        onOpenChange={(isOpen) => { if (!isOpen && !busy) setDeleting(null); }}
        title="删除上游渠道"
        description={`将从 LLM 网关删除渠道「${deleting?.name ?? ""}」及其 API Key，只在该渠道上的模型会从可选模型中移除。此操作不可撤销。`}
        cancelLabel="取消"
        actionLabel="确认删除"
        actionVariant="destructive"
        isActionLoading={busy}
        onAction={() => { if (deleting) void onDelete(deleting).finally(() => setDeleting(null)); }}
      />
    </VStack>
  );
}
