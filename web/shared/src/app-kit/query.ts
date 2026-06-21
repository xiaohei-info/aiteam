import { QueryClient } from "@tanstack/react-query";

/** 跨端统一的 QueryClient 默认策略——消灭各端手写 useEffect+fetch 的样板与边界 if。 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30_000,
      },
    },
  });
}
