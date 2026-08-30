import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  const requestId = useRef(0);

  const load = useCallback(async (reset = false): Promise<void> => {
    const id = ++requestId.current;
    if (reset) {
      setContext(null);
      setLoading(true);
      setError(null);
    }
    try {
      const next = await getConversationContext(client, conversationId);
      if (id !== requestId.current) return;
      setContext(next);
      if (!next) setError("上下文状态暂不可用");
      else setError(null);
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : "上下文状态暂不可用");
    } finally {
      if (id === requestId.current && reset) setLoading(false);
    }
  }, [client, conversationId]);

  useEffect(() => {
    void load(true);
  }, [load, refreshSignal]);

  useEffect(() => {
    if (!isPrompting) return undefined;
    const interval = window.setInterval(() => { void load(); }, 2_500);
    return () => window.clearInterval(interval);
  }, [isPrompting, load]);

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

  if (loading && !context) {
    return <Card data-testid="conversation-context-hud" role="status" aria-label="上下文状态加载中" padding={3}><Text type="supporting">上下文状态加载中…</Text></Card>;
  }
  if (!context) {
    return <Card data-testid="conversation-context-hud" role="region" aria-label="上下文状态" padding={3}><Banner status="info" title={error ?? "上下文状态暂不可用"} /></Card>;
  }
  const modelLabel = context.model ? `${context.model.provider}/${context.model.id}` : "未选择模型";
  const used = context.used_tokens === null ? "未知" : formatTokens(context.used_tokens);
  const contextWindow = formatTokens(context.context_window);
  const percentage = context.percentage === null ? "未知" : `${context.percentage.toFixed(1)}%`;
  const availableLevels = context.available_thinking_levels.filter(isThinkingLevel);
  const thinkingOptions = (availableLevels.length > 0 ? availableLevels : THINKING_LEVELS.map((item) => item.value)).map((value) => ({
    value,
    label: THINKING_LEVELS.find((item) => item.value === value)?.label ?? value,
  }));

  return (
    <Card data-testid="conversation-context-hud" role="region" aria-label="上下文状态" padding={3}>
      <VStack gap={2}>
        <Text as="div" type="supporting">模型：<strong>{modelLabel}</strong></Text>
        <Text as="div" type="supporting">上下文：<strong>{used}</strong> / {contextWindow}（{percentage}）</Text>
        {context.percentage !== null ? (
          <progress aria-label="上下文使用百分比" max={100} value={Math.min(100, Math.max(0, context.percentage))} />
        ) : null}
        <Selector
          label="思考档位"
          options={thinkingOptions}
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
