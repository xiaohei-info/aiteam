/**
 * timeline-client（08 §12.2，07 §8）。前端消费**归一后的业务时间线**，
 * 通过 numeric cursor 做增量拉取 + 实时订阅去重排序。
 *
 * 红线（D6）：只消费 BusinessTimelineEvent，绝不绑定 runtime-native event。
 * 本 client 不感知 runtime/Driver，只认 cursor + BusinessTimelineEvent。
 */

import type { BusinessTimelineEvent } from "../contracts/events.js";

export type { BusinessTimelineEvent };

/** 历史分页拉取器：给定 conversation_id 与起始 cursor，返回一页事件与下一个 cursor。 */
export interface TimelineHistoryFetcher {
  (params: {
    conversationId: string;
    afterCursor: number | null;
    limit: number;
    signal?: AbortSignal;
  }): Promise<{ events: BusinessTimelineEvent[]; nextCursor: number | null }>;
}

/** 实时订阅源（SSE/WebSocket 由各端封装）：推送已归一的业务事件。 */
export interface TimelineSubscription {
  close(): void;
}

export interface TimelineSubscriber {
  (params: {
    conversationId: string;
    sinceCursor: number | null;
    onEvent: (event: BusinessTimelineEvent) => void;
    onError?: (err: unknown) => void;
  }): TimelineSubscription;
}

export interface TimelineStoreOptions {
  conversationId: string;
  history: TimelineHistoryFetcher;
  subscribe?: TimelineSubscriber;
  /** 单页历史条数，默认 50。 */
  pageSize?: number;
}

/**
 * 有序去重的时间线缓冲。核心数据结构：按 cursor 单调递增的事件数组 + cursor→index 索引。
 *
 * 好品味点：所有进入路径（history / live）都走同一个 ingest()，
 * 用 cursor 去重 + 二分插入，消除「实时事件可能早于历史回填」的特殊情况。
 */
export class TimelineStore {
  private readonly conversationId: string;
  private readonly history: TimelineHistoryFetcher;
  private readonly subscribe?: TimelineSubscriber;
  private readonly pageSize: number;

  private events: BusinessTimelineEvent[] = [];
  private readonly seen = new Set<number>();
  private subscription?: TimelineSubscription;
  private listeners = new Set<(events: readonly BusinessTimelineEvent[]) => void>();

  /** 已知最大 cursor（用于实时订阅起点与「拉新」）。 */
  private highWaterCursor: number | null = null;
  /** 已回填到的最小历史 cursor 之前是否还有更早历史。 */
  private hasMoreHistory = true;

  constructor(options: TimelineStoreOptions) {
    this.conversationId = options.conversationId;
    this.history = options.history;
    if (options.subscribe) this.subscribe = options.subscribe;
    this.pageSize = options.pageSize ?? 50;
  }

  /** 当前有序事件快照（只读）。 */
  get snapshot(): readonly BusinessTimelineEvent[] {
    return this.events;
  }

  get cursor(): number | null {
    return this.highWaterCursor;
  }

  get canLoadMore(): boolean {
    return this.hasMoreHistory;
  }

  /** 订阅 store 变更（返回取消函数）。 */
  onChange(listener: (events: readonly BusinessTimelineEvent[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 加载更早的历史页（向前翻）。返回本页新增条数。 */
  async loadOlder(signal?: AbortSignal): Promise<number> {
    if (!this.hasMoreHistory) return 0;
    const oldest = this.events.length > 0 ? this.events[0]!.cursor : null;
    const result = await this.history({
      conversationId: this.conversationId,
      afterCursor: null,
      limit: this.pageSize,
      ...(signal ? { signal } : {}),
    });
    // 约定：history 返回 cursor 升序；oldest 之前没有更多则 nextCursor 为 null。
    const added = this.ingestMany(result.events.filter((e) => oldest === null || e.cursor < oldest));
    this.hasMoreHistory = result.nextCursor !== null && added > 0;
    return added;
  }

  /** 拉取自 highWater 以来的最新历史（重连补洞）。 */
  async catchUp(signal?: AbortSignal): Promise<number> {
    const result = await this.history({
      conversationId: this.conversationId,
      afterCursor: this.highWaterCursor,
      limit: this.pageSize,
      ...(signal ? { signal } : {}),
    });
    return this.ingestMany(result.events);
  }

  /** 启动实时订阅（自 highWater 之后）。重复调用先关旧订阅。 */
  start(): void {
    if (!this.subscribe) return;
    this.subscription?.close();
    this.subscription = this.subscribe({
      conversationId: this.conversationId,
      sinceCursor: this.highWaterCursor,
      onEvent: (event) => this.ingest(event),
    });
  }

  stop(): void {
    this.subscription?.close();
    delete this.subscription;
  }

  /** 单事件入库：去重 + 有序插入 + 通知。统一入口。 */
  ingest(event: BusinessTimelineEvent): boolean {
    if (this.seen.has(event.cursor)) return false;
    this.seen.add(event.cursor);
    this.insertSorted(event);
    if (this.highWaterCursor === null || event.cursor > this.highWaterCursor) {
      this.highWaterCursor = event.cursor;
    }
    this.emit();
    return true;
  }

  private ingestMany(events: BusinessTimelineEvent[]): number {
    let added = 0;
    for (const event of events) {
      if (this.seen.has(event.cursor)) continue;
      this.seen.add(event.cursor);
      this.insertSorted(event);
      if (this.highWaterCursor === null || event.cursor > this.highWaterCursor) {
        this.highWaterCursor = event.cursor;
      }
      added += 1;
    }
    if (added > 0) this.emit();
    return added;
  }

  /** 二分插入保持 cursor 升序。 */
  private insertSorted(event: BusinessTimelineEvent): void {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid]!.cursor < event.cursor) lo = mid + 1;
      else hi = mid;
    }
    this.events.splice(lo, 0, event);
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.events);
  }
}
