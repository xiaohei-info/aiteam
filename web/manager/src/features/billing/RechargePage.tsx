/** 充值页 — 对齐旧架构 /admin/billing/recharge 入口。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useBillingApi } from "./useBillingApi";
import type { Recharge } from "./types";

const PAYMENT_METHODS = [
  { key: "wechat", label: "微信支付" },
  { key: "alipay", label: "支付宝" },
];

type RechargeRow = Recharge & Record<string, unknown>;
const columns: TableColumn<RechargeRow>[] = [
  { key: "created_at", header: "时间", width: pixel(190), renderCell: (row) => row.created_at?.slice(0, 19) },
  { key: "amount", header: "金额", width: pixel(120), renderCell: (row) => `¥${String(row.amount)}` },
  { key: "token_credited", header: "到账Token", width: pixel(140), renderCell: (row) => row.token_credited.toLocaleString() },
  { key: "status", header: "状态", width: pixel(120) },
  { key: "order_no", header: "订单号", width: proportional(1) },
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
    <VStack gap={4}>
      <Heading level={1}>充值</Heading>
      {error && <Banner status="error" title={error} />}
      <Card padding={4}>
        <VStack gap={3}>
          <TextInput
              label="充值金额（元）"
              value={amount}
              placeholder="请输入金额"
              onChange={setAmount}
              {...({ inputMode: "decimal" } as Record<string, string>)}
              width="100%"
            />
          <HStack gap={1} role="group" aria-label="支付方式">
            {PAYMENT_METHODS.map((p) => (
              <Button
                key={p.key}
                label={p.label}
                variant={method === p.key ? "primary" : "secondary"}
                size="sm"
                aria-pressed={method === p.key}
                onClick={() => setMethod(p.key)}
              />
            ))}
          </HStack>
          <Button label="立即充值" variant="primary" isDisabled={submitting || !amount} isLoading={submitting} onClick={() => void submit()} />
        </VStack>
      </Card>
      <Card padding={4}>
        <VStack gap={3}>
        <Heading level={2}>充值记录</Heading>
        {loading ? (
          <VStack gap={2} role="status" aria-label="充值记录加载中"><Skeleton height={32} /><Skeleton height={64} index={1} /></VStack>
        ) : (
          <Table aria-label="充值记录" tableProps={{ "aria-label": "充值记录" }} data={records as RechargeRow[]} columns={columns} idKey="recharge_id" density="compact" emptyState={<EmptyState title="暂无充值记录" isCompact />} />
        )}
        </VStack>
      </Card>
    </VStack>
  );
}
