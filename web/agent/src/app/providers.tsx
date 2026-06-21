import type { ReactNode } from "react";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary, QueryProvider } from "@aiteam/shared/app-kit";

import { AppProvider } from "../lib/app-context";

/** 全局 provider 组合：错误边界 → 服务端状态 → 会话/DI → 路由。 */
export function AppProviders({ children }: { children: ReactNode }): ReactNode {
  return (
    <ErrorBoundary fallback={<div className="p-lg text-danger">应用出错，请刷新重试。</div>}>
      <QueryProvider>
        <BrowserRouter>
          <AppProvider>{children}</AppProvider>
        </BrowserRouter>
      </QueryProvider>
    </ErrorBoundary>
  );
}
