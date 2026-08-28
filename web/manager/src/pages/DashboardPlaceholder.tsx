/**
 * 企业概览首页（W-M.1）。
 * 接 /api/manager/usage/rollup/list + /audits → 企业计量/审计概览。
 * 红线（D13）：只展示脱敏聚合摘要，绝不含会话内容。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, proportional, pixel, type TableColumn } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../i18n/context";
import { useGovernanceApi } from "../features/governance/useGovernanceApi";
import type { UsageRollup, AuditSummary } from "../features/governance/types";

type UsageRollupRow = UsageRollup & { employee_display_name: string } & Record<string, unknown>;
type AuditSummaryRow = AuditSummary & { actor_display_name: string; resource_display_name: string } & Record<string, unknown>;

function fmt(v: number): string { return v.toLocaleString("zh-CN"); }
function fmtUsd(v: number | string): string {
  const usd = Number(v);
  return Number.isFinite(usd) ? `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}` : "—";
}

const rollupColumns: TableColumn<UsageRollupRow>[] = [
  { key: "employee_display_name", header: "员工", width: proportional(1), renderCell: (row) => row.employee_display_name },
  { key: "run_count", header: "执行", width: pixel(100), renderCell: (row) => fmt(row.run_count) },
  { key: "token_total", header: "Token", width: pixel(120), renderCell: (row) => fmt(row.token_total) },
  { key: "cost_total", header: "API 成本（USD）", width: pixel(160), renderCell: (row) => fmtUsd(row.cost_total) },
  { key: "error_count", header: "错误", width: pixel(100), renderCell: (row) => fmt(row.error_count) },
];

const auditColumns: TableColumn<AuditSummaryRow>[] = [
  { key: "actor_display_name", header: "操作者", width: proportional(1), renderCell: (row) => row.actor_display_name },
  { key: "action", header: "动作", width: proportional(1) },
  { key: "resource", header: "资源", width: proportional(1), renderCell: (row) => row.resource_display_name },
  { key: "occurred_at", header: "时间", width: pixel(200) },
];

export function DashboardPlaceholder(): ReactNode {
  const i18n = useI18n();
  const api = useGovernanceApi();
  const { listUsageRollups, listAudits, listEmployees, listMembers } = api;
  const [rollups, setRollups] = useState<UsageRollup[]>([]);
  const [audits, setAudits] = useState<AuditSummary[]>([]);
  const [rollupNames, setRollupNames] = useState<Map<string, string>>(new Map());
  const [auditResourceNames, setAuditResourceNames] = useState<Map<string, string>>(new Map());
  const [memberNames, setMemberNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [r, a] = await Promise.all([listUsageRollups(), listAudits()]);
      setRollups(r); setAudits(a);
      const employees = await (listEmployees ? listEmployees().catch(() => []) : []);
      const members = await (listMembers ? listMembers().catch(() => []) : []);
      const employeeNames = new Map(employees.map((employee) => [employee.employee_id, employee.display_name]));
      setMemberNames(new Map(members.map((member) => [member.id, member.display_name])));
      setRollupNames(employeeNames);
      setAuditResourceNames(new Map(
        a.flatMap((audit) => audit.resource_id && employeeNames.has(audit.resource_id)
          ? [[audit.resource_id, employeeNames.get(audit.resource_id)!] as const]
          : []),
      ));
    } catch (err) { setError(err instanceof Error ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [listAudits, listEmployees, listMembers, listUsageRollups]);

  useEffect(() => { void load(); }, [load]);

  const rollupRows = rollups.slice(0, 5).map((row) => ({
    ...row,
    employee_display_name: row.employee_id ? rollupNames.get(row.employee_id) ?? "已删除专家" : "系统汇总",
  })) as UsageRollupRow[];
  const auditRows = audits.slice(0, 5).map((row) => ({
    ...row,
    actor_display_name: row.actor === "anon" ? "未认证用户" : memberNames.get(row.actor) ?? "企业成员",
    resource_display_name: row.resource_id
      ? auditResourceNames.get(row.resource_id) ?? "管理对象"
      : "—",
  })) as AuditSummaryRow[];


  return (
    <VStack gap={6}>
      <Heading level={1}>{i18n.t("manager.nav.dashboard")}</Heading>
      {loading ? (
        <Card padding={4} role="status" aria-label="企业概览加载中"><VStack gap={2}><Skeleton height={32} /><Skeleton height={120} index={1} /></VStack></Card>
      ) : error ? (
        <Banner status="error" title={error} />
      ) : (
        <>
          <Card padding={4}><VStack gap={4}><Heading level={2}>计量汇总（最近 {rollups.length} 条）</Heading><Table aria-label="计量汇总" tableProps={{ "aria-label": "计量汇总" }} data={rollupRows} columns={rollupColumns} idKey="rollup_id" density="compact" emptyState={<EmptyState title="暂无计量数据" isCompact />} /></VStack></Card>
          <Card padding={4}><VStack gap={4}><Heading level={2}>审计事件（最近 {audits.length} 条）</Heading><Table aria-label="审计事件" tableProps={{ "aria-label": "审计事件" }} data={auditRows} columns={auditColumns} idKey="event_id" density="compact" emptyState={<EmptyState title="暂无审计记录" isCompact />} /></VStack></Card>
        </>
      )}
    </VStack>
  );
}
