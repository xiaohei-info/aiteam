/** P09 办公室动态页 — 工位视图 + 状态摘要 + 定时任务 Feed。 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useApp } from "../../lib/app-context";
import { getScene, getFeed } from "./useOfficeApi";
import { ScheduledJobs } from "./ScheduledJobs";
import type { OfficeScene, OfficeFeed } from "./types";

const STATUS_ICONS: Record<string, string> = { working: "⚡", ready: "●", offline: "○", busy: "🔄" };

export function OfficePage() {
  const { client } = useApp();
  const [scene, setScene] = useState<OfficeScene | null>(null);
  const [feed, setFeed] = useState<OfficeFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setScene(await getScene(client)); } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [client]);

  const loadFeed = useCallback(async () => {
    setFeedLoading(true); setFeedError(null);
    try { setFeed(await getFeed(client)); } catch (err) { setFeedError(err instanceof ApiError ? err.message : "动态加载失败"); }
    finally { setFeedLoading(false); }
  }, [client]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadFeed(); }, [loadFeed]);

  if (loading) return <Banner status="info" title="加载中…" />;
  if (error) return <Banner status="error" title={error} />;
  if (!scene) return <EmptyState title="办公室投影不可用" description="Agent 当前没有可用的办公室数据。" />;

  const summaryEntries = Object.entries(scene.summary);

  return (
    <VStack gap={4} role="region" aria-label="办公室动态">
      <Heading level={1}>办公室动态</Heading>

      {summaryEntries.length > 0 ? (
        <HStack gap={3} wrap="wrap" data-testid="office-summary">
          {summaryEntries.map(([key, val]) => (
            <Card key={key} padding={3} width={180}><VStack gap={1}><Text type="supporting">{key}</Text><Text weight="semibold">{val}</Text></VStack></Card>
          ))}
        </HStack>
      ) : <EmptyState title="暂无状态摘要" data-testid="office-summary-empty" />}

      <HStack gap={3} wrap="wrap" data-testid="office-employees">
        {scene.employees.map((emp) => (
          <Card key={emp.employee_id} data-testid="office-employee" padding={3} width={180}><VStack gap={1}><Text>{STATUS_ICONS[emp.status] ?? "●"}</Text><Text weight="semibold">{emp.display_name}</Text><Text type="supporting">{emp.status}</Text><Text type="supporting">{emp.task ?? "当前无任务"}</Text></VStack></Card>
        ))}
      </HStack>

      {scene.employees.length === 0 && <EmptyState title="暂无员工" />}

      <HStack gap={2} align="center"><Heading level={2}>定时任务</Heading><Button label="刷新" variant="secondary" size="sm" isLoading={feedLoading} onClick={() => void loadFeed()} /></HStack>

      {feedError && <Banner status="error" title={feedError} />}

      {feedLoading && <Banner status="info" title="加载中…" />}

      {feed && !feedLoading ? (
        <ScheduledJobs jobs={feed.events.filter((e) => e.type === "conversation_schedule")} />
      ) : !feedLoading && !feedError ? (
        <EmptyState title="办公室动态不可用" description="Agent 当前没有可用的动态 Feed。" data-testid="office-feed-unavailable" />
      ) : null}
    </VStack>
  );
}
