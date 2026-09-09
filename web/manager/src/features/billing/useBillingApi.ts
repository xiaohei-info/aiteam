import { useMemo } from "react";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";
import type { UsageOverview, UsageRecord, BillingBalance, Recharge, RechargePaymentMethod } from "./types";

export interface BillingApi {
  getOverview: (period?: string) => Promise<UsageOverview | null>;
  getRecords: (period?: string, employeeId?: string) => Promise<UsageRecord[]>;
  getBalance: () => Promise<BillingBalance | null>;
  listRecharges: () => Promise<Recharge[]>;
  createRecharge: (amount: number | string, payment_method: RechargePaymentMethod) => Promise<Recharge | null>;
}

export function useBillingApi(): BillingApi {
  const { token, onUnauthorized } = useSession();
  return useMemo<BillingApi>(() => {
    const client = createManagerApiClient({ getToken: () => token, onUnauthorized });
    return {
      getOverview(period = "month") { return client.get<UsageOverview>(`/api/manager/billing/usage/overview?period=${period}`); },
      async getRecords(period = "month", employeeId?: string) {
        let path = `/api/manager/billing/usage/records?period=${period}`;
        if (employeeId) path += `&employee_id=${employeeId}`;
        const r = await client.listGet<UsageRecord>(path);
        return r.items ?? [];
      },
      getBalance() { return client.get<BillingBalance>("/api/manager/billing/balance"); },
      async listRecharges() { const r = await client.listGet<Recharge>("/api/manager/billing/recharges"); return r.items ?? []; },
      createRecharge(amount, payment_method) { return client.post<Recharge>("/api/manager/billing/recharges", { body: { amount, payment_method } }); },
    };
  }, [token, onUnauthorized]);
}
