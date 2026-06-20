/**
 * 企业开通页 client 注入（W-O.2）。
 *
 * 从 SessionContext 取 token，创建 operation tier 的 ApiClient 注入 EnterprisePage。
 * 与 App.tsx 同目录：仅作为路由工厂组件，不属于 features/enterprise 内部。
 */
import { useMemo, type ReactNode } from "react";
import { createOperationApiClient } from "./api";
import { useSession } from "./auth/session";
import { EnterprisePage } from "./features/enterprise";

export function EnterprisePageWired(): ReactNode {
  const { token } = useSession();
  const client = useMemo(
    () =>
      createOperationApiClient({
        getToken: () => token,
      }),
    [token],
  );
  return <EnterprisePage apiClient={client} />;
}
