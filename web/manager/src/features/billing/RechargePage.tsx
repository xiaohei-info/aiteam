/** 充值页 — 对齐旧架构 /admin/billing/recharge 入口。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useBillingApi } from "./useBillingApi";
import type { Recharge } from "./types";

const PAYMENT_METHODS = [
  { key: "wechat", label: "微信支付" },
  { key: "alipay", label: "支付宝" },
];

export function RechargePage(): ReactNode {
  const api = useBillingApi();
  const [records, setRecords] = useState<Recharge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("wechat");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listRecharges();
      setRecords(r);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "充值记录加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit() {
    const n = Number(amount);
    if (!n || n <= 0) return;
    setSubmitting(true);
    try {
      await api.createRecharge(n, method);
      setAmount("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "充值失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">充值</h1>

      {error && (
        <GlassPanel className="rounded-window p-md text-sm text-danger">{error}</GlassPanel>
      )}

      <GlassPanel className="rounded-window p-md">
        <div className="flex flex-col gap-sm">
          <Field label="充值金额（元）">
            <Input
              type="number"
              value={amount}
              placeholder="请输入金额"
              onChange={(e) => setAmount((e.target as HTMLInputElement).value)}
            />
          </Field>
          <div className="flex gap-xs">
            {PAYMENT_METHODS.map((p) => (
              <Button
                key={p.key}
                variant={method === p.key ? "metal" : "ghost"}
                size="sm"
                onClick={() => setMethod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <Button variant="gold" size="md" disabled={submitting || !amount} onClick={submit}>
            {submitting ? "提交中…" : "立即充值"}
          </Button>
        </div>
      </GlassPanel>

      <GlassPanel className="rounded-window p-md">
        <h2 className="m-0 mb-sm text-sm font-semibold text-text-secondary">充值记录</h2>
        {loading ? (
          <p className="m-0 text-sm text-text-muted">加载中…</p>
        ) : records.length === 0 ? (
          <p className="m-0 text-sm text-text-muted">暂无充值记录</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted">
                <th className="pb-xs">时间</th>
                <th className="pb-xs">金额</th>
                <th className="pb-xs">到账Token</th>
                <th className="pb-xs">状态</th>
                <th className="pb-xs">订单号</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.recharge_id} className="text-text-secondary">
                  <td className="pb-xs">{r.created_at?.slice(0, 19)}</td>
                  <td className="pb-xs">¥{String(r.amount)}</td>
                  <td className="pb-xs">{r.token_credited.toLocaleString()}</td>
                  <td className="pb-xs">{r.status}</td>
                  <td className="pb-xs">{r.order_no}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </GlassPanel>
    </section>
  );
}
