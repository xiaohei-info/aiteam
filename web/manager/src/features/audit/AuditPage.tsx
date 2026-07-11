/** 审计事件页 — 事件列表。 */
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, proportional, pixel, type TableColumn } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { ApiError } from "@aiteam/shared";
import { useAuditApi } from "./useAuditApi";
import type { AuditEvent } from "./types";

const columns: TableColumn<AuditEvent>[] = [
  { key: "event_type", header: "事件类型", width: proportional(1) },
  { key: "actor_id", header: "操作者", width: proportional(1), renderCell: (event) => event.actor_id ?? "—" },
  { key: "target", header: "目标", width: proportional(1), renderCell: (event) => `${event.target_type ?? "—"}/${event.target_id ?? "—"}` },
  { key: "created_at", header: "时间", width: pixel(190), renderCell: (event) => event.created_at.slice(0, 19) },
];

export function AuditPage(): ReactNode {
  const api = useAuditApi();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [eventType, setEventType] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const items = await api.list({ event_type: eventType || undefined, page });
        if (!cancelled) setEvents(items);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "审计事件加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [api, eventType, page]);

  const queryEvents = () => {
    setEventType(query);
    setPage(1);
  };

  return (
    <VStack gap={4}>
      <Heading level={1}>审计事件</Heading>
      <Card padding={4}>
        <VStack gap={4}>
          <HStack gap={2} align="end">
            <TextInput
              label="事件类型筛选"
              value={query}
              onChange={setQuery}
              placeholder="例如 member.created"
              width="100%"
              onEnter={queryEvents}
            />
            <Button label="查询" onClick={queryEvents} />
          </HStack>

          {loading ? (
            <VStack gap={2} role="status" aria-label="审计事件加载中">
              <Skeleton height={32} />
              <Skeleton height={32} index={1} />
              <Skeleton height={32} index={2} />
            </VStack>
          ) : error ? (
            <div role="alert">{error}</div>
          ) : (
            <Table
              aria-label="审计事件"
              tableProps={{ "aria-label": "审计事件" }}
              data={events}
              columns={columns}
              idKey="event_id"
              density="compact"
              hasHover
              textOverflow="truncate"
              emptyState={<EmptyState title="暂无审计事件" isCompact />}
            />
          )}

          <HStack gap={2} justify="end">
            <Button label="上一页" isDisabled={page === 1 || loading} onClick={() => setPage((value) => value - 1)} />
            <Button label="下一页" isDisabled={loading || events.length === 0} onClick={() => setPage((value) => value + 1)} />
          </HStack>
        </VStack>
      </Card>
    </VStack>
  );
}
