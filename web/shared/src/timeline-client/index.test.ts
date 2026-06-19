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
    const history = vi.fn(async () => ({ events: [evt(2), evt(3)], nextCursor: null }));
    const store = new TimelineStore({ conversationId: "c1", history });
    store.ingest(evt(1));
    const added = await store.catchUp();
    expect(added).toBe(2);
    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "c1", afterCursor: 1 }),
    );
    expect(store.snapshot.map((e) => e.cursor)).toEqual([1, 2, 3]);
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
