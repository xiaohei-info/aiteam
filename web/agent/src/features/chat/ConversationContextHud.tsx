import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { HStack } from "@astryxdesign/core/HStack";
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
    return <HStack data-testid="conversation-context-hud" data-context-hud="true" role="status" aria-label="上下文状态加载中" gap={2} align="center"><span data-context-loading="true" aria-hidden="true" /><Text type="supporting">上下文加载中…</Text></HStack>;
  }
  if (!context) {
    return <HStack data-testid="conversation-context-hud" data-context-hud="true" role="region" aria-label="上下文状态" gap={2} align="center"><Banner status="info" title={error ?? "上下文状态暂不可用"} /></HStack>;
  }
  const modelLabel = context.model?.name?.trim() || context.model?.id || "未选择模型";
  const providerDetail = context.model ? `${context.model.provider}/${context.model.id}` : undefined;
  const used = context.used_tokens === null ? "未知" : formatTokens(context.used_tokens);
  const contextWindow = formatTokens(context.context_window);
  const availableLevels = context.available_thinking_levels.filter(isThinkingLevel);
  const thinkingValues = availableLevels.length > 0 ? [...availableLevels] : THINKING_LEVELS.map((item) => item.value);
  if (!thinkingValues.includes(context.thinking_level)) thinkingValues.push(context.thinking_level);
  const thinkingOptions = thinkingValues.map((value) => ({
    value,
    label: THINKING_LEVELS.find((item) => item.value === value)?.label ?? value,
  }));

  return (
    <HStack
      data-testid="conversation-context-hud"
      data-context-hud="true"
      role="region"
      aria-label="上下文状态"
      gap={2}
      align="center"
    >
      <ContextRing percentage={context.percentage} used={used} contextWindow={contextWindow} />
      <VStack gap={0} data-context-summary="true">
        <Text
          as="div"
          data-context-model="true"
          aria-label={providerDetail ? `${modelLabel}（${providerDetail}）` : modelLabel}
        >
          {modelLabel}
        </Text>
        <Text as="div" type="supporting" data-context-usage="true" aria-label={`上下文：${used} / ${contextWindow}`}>
          {used} / {contextWindow}
        </Text>
      </VStack>
      <Selector
        label="思考档位"
        isLabelHidden
        size="sm"
        placement="above"
        width={104}
        options={thinkingOptions}
        value={context.thinking_level}
        onChange={(value) => { void changeThinkingLevel(value); }}
        isDisabled={saving || isPrompting}
        data-testid="conversation-thinking-level"
      />
      {isPrompting ? <span data-context-running="true" aria-label="执行中" title="执行中" /> : null}
      {error ? <Banner status="error" title={error} /> : null}
    </HStack>
  );
}

function ContextRing({ percentage, used, contextWindow }: { percentage: number | null; used: string; contextWindow: string }): ReactNode {
  const value = percentage === null ? null : Math.min(100, Math.max(0, percentage));
  const radius = 15;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = value === null ? circumference : circumference * (1 - value / 100);
  const level = value === null ? "unknown" : value >= 90 ? "critical" : value >= 70 ? "warning" : "normal";
  const label = value === null ? "上下文使用率未知" : `上下文使用率 ${value.toFixed(1)}%`;
  return (
    <span
      data-context-ring="true"
      data-level={level}
      role="img"
      aria-label={label}
      title={`${label}；${used} / ${contextWindow}`}
    >
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle data-context-ring-track="true" cx="20" cy="20" r={radius} />
        <circle
          data-context-ring-value="true"
          cx="20"
          cy="20"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <strong>{value === null ? "—" : `${Math.round(value)}%`}</strong>
    </span>
  );
}

function isThinkingLevel(value: string): value is ConversationThinkingLevel {
  return THINKING_LEVELS.some((item) => item.value === value);
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(Math.max(0, Math.round(value)));
}
