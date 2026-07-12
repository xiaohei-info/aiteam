/** 私聊专家选择：同步失败可离线降级，配置和 readiness 不满足时不可选。 */
import { useEffect, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Heading } from "@astryxdesign/core/Heading";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import type { LoadedExpertProjection } from "../group/useGroupApi";
import { listLoadedExperts, syncGrants } from "../group/useGroupApi";
import type { AgentApiClient } from "../../lib/api-client";
import { useApp } from "../../lib/app-context";
import { getReadinessReport, type ExpertReadiness, type ReadinessState } from "../readiness/useExpertReadinessApi";

export interface RosterPickerProps {
  client: AgentApiClient;
  onPick: (expert: LoadedExpertProjection) => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}

const isConfigured = (expert: LoadedExpertProjection) => !!(expert.model_policy?.model && expert.model_policy?.provider_ref);

export function RosterPicker({ client, onPick, onCancel, busy = false, error }: RosterPickerProps): React.ReactNode {
  const { session } = useApp();
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<Record<string, ExpertReadiness | null>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        if (session) {
          try {
            const result = await syncGrants(client, {
              tenant_id: session.claims.tenant_id ?? "",
              member_id: session.claims.user_id,
            });
            if (!result.ok && !cancelled) setSyncError(result.error ?? "Manager 端同步失败，当前使用本地快照。");
          } catch (err) {
            if (!cancelled) {
              setSyncError(err instanceof Error ? err.message : "Manager 端同步失败，当前使用本地快照。");
            }
          }
        }
        const loaded = await listLoadedExperts(client);
        if (!cancelled) setExperts(loaded);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "加载专家失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    void getReadinessReport(client)
      .then((report) => {
        if (cancelled || report == null) return;
        setReadiness(Object.fromEntries(report.experts.map((expert) => [expert.employee_id, expert])));
      })
      .catch(() => {});

    return () => { cancelled = true; };
  }, [client, session]);

  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onCancel]);

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => { if (!open && !busy) onCancel(); }}
      purpose="info"
      width={560}
      aria-label="选择专家开始私聊"
    >
      <VStack gap={4}>
        <HStack justify="between" align="center">
          <Heading level={2}>选择专家开始私聊</Heading>
          <Button label="关闭" variant="ghost" size="sm" isDisabled={busy} onClick={onCancel} />
        </HStack>
        {loading ? <Text role="status" type="supporting">加载中…</Text> : null}
        {syncError ? <Text role="status" type="supporting">{syncError}</Text> : null}
        {loadError ? <Banner status="error" title={loadError} /> : null}
        {error ? <Banner status="error" title={error} /> : null}
        {!loading && !loadError && experts.length === 0 && !error ? (
          <EmptyState title="暂无可私聊的专家" description="请先在 Manager 端招募专家。" isCompact />
        ) : null}
        {!loading && !loadError && experts.length > 0 ? (
          <VStack gap={2} role="list" aria-label="可私聊专家">
            {experts.map((expert) => {
              const configured = isConfigured(expert);
              const report = readiness[expert.employee_id] ?? undefined;
              const blocked = report?.available === false;
              const disabled = busy || !configured || blocked;
              const reason = blocked ? report?.reasons?.join("；") ?? "专家当前不可用" : undefined;
              return (
                <HStack key={expert.employee_id} role="listitem" justify="between" align="center" gap={3}>
                  <VStack gap={1}>
                    <HStack gap={2} align="center">
                      <Text weight="semibold">{expert.display_name}</Text>
                      {report ? <ReadinessDot status={report.available ? "ready" : "blocked"} label={report.available ? "可用" : "不可用"} /> : null}
                    </HStack>
                    <HStack gap={1} wrap="wrap">
                      {!configured ? <Badge label="待 Manager 配置" variant="warning" /> : null}
                      {expert.runtime_binding ? <Badge label={expert.runtime_binding} variant="neutral" /> : null}
                      {reason ? <Text type="supporting">{reason}</Text> : null}
                    </HStack>
                  </VStack>
                  <Button
                    label={`选择${expert.display_name}`}
                    variant="secondary"
                    isDisabled={disabled}
                    onClick={() => { if (!disabled) onPick(expert); }}
                  />
                </HStack>
              );
            })}
          </VStack>
        ) : null}
      </VStack>
    </Dialog>
  );
}

interface ReadinessDotProps { status: ReadinessState; label: string; }

export function ReadinessDot({ status, label }: ReadinessDotProps): React.ReactNode {
  const variant: StatusDotVariant = status === "ready" ? "success" : status === "degraded" ? "warning" : status === "blocked" ? "error" : "neutral";
  return <StatusDot variant={variant} label={`就绪：${label}`} tooltip={label} />;
}
