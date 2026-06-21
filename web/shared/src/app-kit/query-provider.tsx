import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "./query.js";

/** 包裹应用以提供统一 QueryClient；client 经 useState 惰性单例，避免重渲染重建。 */
export function QueryProvider({ children }: { children: ReactNode }): ReactNode {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
