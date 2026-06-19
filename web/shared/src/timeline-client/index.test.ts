import { describe, it, expect, vi } from "vitest";
import { TimelineStore, type BusinessTimelineEvent } from "./index.js";

function evt(cursor: number, type = "text"): BusinessTimelineEvent {
  return {
    cursor,
    run_id: "r1",
    conversation_id: "c1",
    type,
    payload: {},
    created_at: "2026-06-19T00:00:00Z",
  };
}

describe("TimelineStore ordering & dedup", () => {
  it("orders by cursor regardless of ingest order", () => {
    const store = new TimelineStore({ conversationId: "c1", history: vi.fn() });
    store.ingest(evt(3));
    store.ingest(evt(1));
    store.ingest(evt(2));
    expect(store.snapshot.map((e) => e.cursor)).toEqual([1, 2, 3]);
  });

  it("dedupes by cursor", () => {
    const store = new TimelineStore({ conversationId: "c1", history: vi.fn() });
    expect(store.ingest(evt(5))).toBe(true);
    expect(store.ingest(evt(5))).toBe(false);
    expect(store.snapshot).toHaveLength(1);
  });

  it("tracks highWater cursor", () => {
    const store = new TimelineStore({ conversationId: "c1", history: vi.fn() });
    store.ingest(evt(1));
    store.ingest(evt(7));
    store.ingest(evt(3));
    expect(store.cursor).toBe(7);
  });

  it("notifies listeners on change only", () => {
    const store = new TimelineStore({ conversationId: "c1", history: vi.fn() });
    const listener = vi.fn();
    store.onChange(listener);
    store.ingest(evt(1));
    store.ingest(evt(1)); // dup → no emit
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("catchUp pulls history after highWater", async () => {
    const history = vi.fn(async () => ({ events: [evt(2), evt(3)], hasMore: false }));
    const store = new TimelineStore({ conversationId: "c1", history });
    store.ingest(evt(1));
    const added = await store.catchUp();
    expect(added).toBe(2);
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", afterCursor: 1 }),
    );
    expect(store.snapshot.map((e) => e.cursor)).toEqual([1, 2, 3]);
  });

  it("loadOlder pages backward across multiple pages via beforeCursor + source hasMore", async () => {
    // 数据源：cursor 1..5 的更早历史，pageSize=2，按 beforeCursor 向前翻。
    const all = [evt(1), evt(2), evt(3), evt(4), evt(5)];
    const history = vi.fn(
      async (params: { beforeCursor?: number | null; limit: number }) => {
        const before = params.beforeCursor ?? Infinity;
        const older = all.filter((e) => e.cursor < before).sort((a, b) => b.cursor - a.cursor);
        const page = older.slice(0, params.limit).sort((a, b) => a.cursor - b.cursor);
        const hasMore = older.length > params.limit;
        return { events: page, hasMore };
      },
    );
    const store = new TimelineStore({ conversationId: "c1", history, pageSize: 2 });
    // 先有最新一页（cursor 4,5）在场，向前回溯更早历史。
    store.ingest(evt(5));
    store.ingest(evt(4));

    const first = await store.loadOlder(); // 取 <4 的最新两条 → 2,3
    expect(first).toBe(2);
    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ beforeCursor: 4 }));
    expect(store.canLoadMore).toBe(true); // 源说还有更早（cursor 1）

    const second = await store.loadOlder(); // 取 <2 的 → 1
    expect(second).toBe(1);
    expect(history).toHaveBeenLastCalledWith(expect.objectContaining({ beforeCursor: 2 }));
    expect(store.canLoadMore).toBe(false); // 源说到底

    expect(store.snapshot.map((e) => e.cursor)).toEqual([1, 2, 3, 4, 5]);
    const third = await store.loadOlder(); // 已到底，不再请求
    expect(third).toBe(0);
  });

  it("live subscription feeds ingest via store.start", () => {
    let push: ((e: BusinessTimelineEvent) => void) | null = null;
    const subscribe = vi.fn((params: { onEvent: (e: BusinessTimelineEvent) => void }) => {
      push = params.onEvent;
      return { close: vi.fn() };
    });
    const store = new TimelineStore({ conversationId: "c1", history: vi.fn(), subscribe });
    store.start();
    push!(evt(10));
    expect(store.snapshot.map((e) => e.cursor)).toEqual([10]);
  });
});
