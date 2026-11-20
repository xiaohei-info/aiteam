import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@aiteam/shared";
import type { ExternalSkill } from "./types";
import type { useSkillMarketApi } from "./useSkillMarketApi";

type Api = Pick<ReturnType<typeof useSkillMarketApi>, "browseExternal">;

export const SEARCH_DEBOUNCE_MS = 400;

export function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 429) return "ClawHub 请求太频繁，请稍等一会儿再试";
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * ClawHub 外部列表：只在 `enabled` 时请求（内部市场不受外部故障影响），
 * 输入停顿 400ms 后再搜索，浏览模式按 cursor「加载更多」。
 */
export function useExternalSkills(api: Api, query: string, enabled: boolean) {
  const [debounced, setDebounced] = useState(query.trim());
  const [items, setItems] = useState<ExternalSkill[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!enabled) return;
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    api.browseExternal(debounced || undefined)
      .then((page) => {
        if (current !== generation.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
      })
      .catch((err) => {
        if (current !== generation.current) return;
        setItems([]);
        setCursor(null);
        setError(errorText(err, "ClawHub 列表加载失败"));
      })
      .finally(() => { if (current === generation.current) setLoading(false); });
  }, [api, debounced, enabled, attempt]);

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    try {
      const page = await api.browseExternal(undefined, cursor);
      if (current !== generation.current) return;
      setItems((prev) => {
        const seen = new Set(prev.map((item) => `${item.owner}/${item.slug}`));
        return [...prev, ...page.items.filter((item) => !seen.has(`${item.owner}/${item.slug}`))];
      });
      setCursor(page.nextCursor);
    } catch (err) {
      if (current === generation.current) setError(errorText(err, "加载更多失败"));
    } finally {
      setLoadingMore(false);
    }
  }, [api, cursor, loadingMore]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const pending = query.trim() !== debounced;

  return { items, loading: loading || (enabled && pending), loadingMore, error, hasMore: Boolean(cursor) && !debounced, loadMore, retry };
}
