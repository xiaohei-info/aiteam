import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { AgentApiClient } from "../../lib/api-client";
import { getConversationContext, setConversationThinkingLevel, type ConversationContext, type ConversationThinkingLevel } from "./useChatApi";

const THINKING_LEVELS: Array<{ value: ConversationThinkingLevel; label: string }> = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" },
  { value: "max", label: "最大" },
];

export interface ConversationContextHudProps {
  client: AgentApiClient;
  conversationId: string;
  refreshSignal?: number;
  isPrompting?: boolean;
}

export function ConversationContextHud({ client, conversationId, refreshSignal = 0, isPrompting = false }: ConversationContextHudProps): ReactNode {
  const [context, setContext] = useState<ConversationContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setContext(null);
    setLoading(true);
    setError(null);
    void getConversationContext(client, conversationId)
      .then((next) => { if (alive) setContext(next); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, conversationId, refreshSignal]);

  async function changeThinkingLevel(value: string): Promise<void> {
    if (!context || saving || isPrompting || !isThinkingLevel(value)) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setConversationThinkingLevel(client, conversationId, value);
      if (updated) setContext(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "思考档位保存失败");
    } finally {
      setSaving(false);
    }
  }

  if (loading || !context) return null;
  const modelLabel = context.model ? `${context.model.provider}/${context.model.id}` : "未选择模型";
  const used = context.used_tokens === null ? "未知" : formatTokens(context.used_tokens);
  const window = formatTokens(context.context_window);
  const percentage = context.percentage === null ? "未知" : `${context.percentage.toFixed(1)}%`;

  return (
    <Card data-testid="conversation-context-hud" role="region" aria-label="上下文状态" padding={3}>
      <VStack gap={2}>
        <Text as="div" type="supporting">模型：<strong>{modelLabel}</strong></Text>
        <Text as="div" type="supporting">上下文：<strong>{used}</strong> / {window}（{percentage}）</Text>
        {context.percentage !== null ? (
          <progress aria-label="上下文使用百分比" max={100} value={Math.min(100, Math.max(0, context.percentage))} />
        ) : null}
        <Selector
          label="思考档位"
          options={THINKING_LEVELS.map(({ value, label }) => ({ value, label }))}
          value={context.thinking_level}
          onChange={(value) => { void changeThinkingLevel(value); }}
          isDisabled={saving || isPrompting}
        />
        <Badge label={isPrompting ? "执行中" : "本地上下文"} variant={isPrompting ? "info" : "neutral"} />
        {error ? <Banner status="error" title={error} /> : null}
      </VStack>
    </Card>
  );
}

function isThinkingLevel(value: string): value is ConversationThinkingLevel {
  return THINKING_LEVELS.some((item) => item.value === value);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}
