import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useAccountsApi } from "./useAccountsApi.js";
import type { EnterpriseAccount, EnterpriseStats } from "./types.js";
import { EnterpriseActions } from "./EnterpriseActions.js";

type AccountRow = EnterpriseAccount & Record<string, unknown>;

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "active", label: "正常" },
  { value: "suspended", label: "暂停" },
  { value: "banned", label: "封禁" },
  { value: "closed", label: "注销" },
];

function statusBadge(status: string): { label: string; variant: BadgeVariant } {
  switch (status) {
    case "active":
    case "normal":
      return { label: "正常", variant: "success" };
    case "suspended":
      return { label: "暂停", variant: "warning" };
    case "banned":
      return { label: "封禁", variant: "error" };
    case "closed":
      return { label: "注销", variant: "neutral" };
    default:
      return { label: "欠费", variant: "warning" };
  }
}

function StatCard({ label, value }: { label: string; value: number | string }): ReactNode {
  return (
    <Card>
      <VStack gap={1}>
        <Text color="secondary">{label}</Text>
        <Heading level={2}>{value}</Heading>
      </VStack>
    </Card>
  );
}

export function AccountsPage(): ReactNode {
  const api = useAccountsApi();
  const [list, setList] = useState<EnterpriseAccount[]>([]);
  const [stats, setStats] = useState<EnterpriseStats | null>(null);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("all");
  const [filters, setFilters] = useState({ keyword: "", status: "all" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const [items, nextStats] = await Promise.all([
        api.list({
          keyword: filters.keyword || undefined,
          status: filters.status === "all" ? undefined : filters.status,
        }),
        api.getStats(),
      ]);
      if (sequence === loadSequence.current) {
        setList(items);
        setStats(nextStats);
      }
    } catch (err) {
      if (sequence === loadSequence.current) {
        setError(err instanceof Error ? err.message : "加载失败");
        setList([]);
        setStats(null);
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [api, filters]);

  useEffect(() => { void load(); }, [load]);

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const next = { keyword: keywordDraft.trim(), status: statusDraft };
    if (next.keyword === filters.keyword && next.status === filters.status) {
      void load();
      return;
    }
    setFilters(next);
  }

  const columns = useMemo<TableColumn<AccountRow>[]>(() => [
    { key: "enterprise_name", header: "企业名称", width: proportional(1) },
    {
      key: "contact",
      header: "联系人/手机",
      width: proportional(1),
      renderCell: (enterprise) => `${enterprise.contact_name} / ${enterprise.contact_phone}`,
    },
    {
      key: "registered_at",
      header: "注册时间",
      width: pixel(120),
      renderCell: (enterprise) => enterprise.registered_at?.slice(0, 10) || "—",
    },
    {
      key: "total_recharged",
      header: "累计充值",
      width: pixel(120),
      align: "end",
      renderCell: (enterprise) => `￥${enterprise.total_recharged}`,
    },
    {
      key: "token_consumed",
      header: "Token消耗",
      width: pixel(120),
      align: "end",
      renderCell: (enterprise) => `${((enterprise.token_consumed || 0) / 1e6).toFixed(1)}M`,
    },
    {
      key: "status",
      header: "状态",
      width: pixel(90),
      renderCell: (enterprise) => {
        const badge = statusBadge(enterprise.operation_status ?? enterprise.status);
        return <Badge label={badge.label} variant={badge.variant} />;
      },
    },
    {
      key: "actions",
      header: "操作",
      width: pixel(110),
      align: "end",
      resizable: false,
      renderCell: (enterprise) => (
        <EnterpriseActions api={api} enterprise={enterprise} onDone={() => void load()} />
      ),
    },
  ], [api, load]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>企业账号管理</Heading>

      {stats && (
        <Grid columns={{ minWidth: 180, repeat: "fit" }} gap={3}>
          <StatCard label="总企业数" value={stats.total_enterprises} />
          <StatCard label="活跃企业" value={stats.active_enterprises ?? 0} />
          <StatCard label="封禁企业" value={stats.banned_enterprises ?? 0} />
          <StatCard label="总充值(万)" value={stats.total_recharged} />
        </Grid>
      )}

      <Card>
        <form aria-label="企业账号筛选" onSubmit={submitSearch}>
          <HStack gap={3} align="end" wrap="wrap">
            <TextInput
              label="搜索企业"
              value={keywordDraft}
              onChange={setKeywordDraft}
              placeholder="企业名称或手机号"
              startIcon="search"
              width={320}
            />
            <Selector
              label="企业状态"
              value={statusDraft}
              onChange={setStatusDraft}
              options={STATUS_OPTIONS}
              width={180}
            />
            <Button label="搜索" type="submit" variant="secondary" />
            <Button label="导出" variant="ghost" onClick={() => void api.exportAll()} />
          </HStack>
        </form>
      </Card>

      {error && <Banner status="error" title={error} />}
      {loading ? (
        <Card role="status" aria-label="正在加载企业账号">
          <VStack gap={2}>
            <Skeleton height={36} />
            <Skeleton height={36} index={1} />
            <Skeleton height={36} index={2} />
          </VStack>
        </Card>
      ) : !error ? (
        <Card padding={0}>
          <Table
            aria-label="企业账号"
            tableProps={{ "aria-label": "企业账号" }}
            data={list as AccountRow[]}
            columns={columns}
            idKey="org_id"
            hasHover
            emptyState={<EmptyState title="暂无企业" description="调整搜索条件后重试。" isCompact />}
          />
        </Card>
      ) : null}
    </VStack>
  );
}
