/**
 * 企业治理页（W-M.5，08 §12.1，D13/D24）。
 *
 * 只展示脱敏聚合计量与审计摘要；配额评估只给出建议/告警，不阻断本地执行。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { NumberInput } from "@astryxdesign/core/NumberInput";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useGovernanceApi } from "./useGovernanceApi";
import type {
  AuditSummary,
  CreateQuotaInput,
  EnforcementAction,
  QuotaPolicy,
  UsageRollup,
} from "./types";

type UsageRollupRow = UsageRollup & Record<string, unknown>;
type AuditSummaryRow = AuditSummary & Record<string, unknown>;
type QuotaPolicyRow = QuotaPolicy & Record<string, unknown>;

const ENFORCEMENT_OPTIONS = [
  { value: "soft", label: "soft" },
  { value: "hard", label: "hard" },
];

function badgeVariant(value: string): BadgeVariant {
  if (value === "active" || value === "info" || value === "within_budget") return "success";
  if (value === "warning" || value === "soft") return "warning";
  if (value === "error" || value === "hard") return "error";
  return "neutral";
}

function quotaDimensions(dimensions: Record<string, unknown>): string {
  const entries = [
    typeof dimensions.cost_cap_usd === "number" ? `成本上限 ${dimensions.cost_cap_usd}` : null,
    typeof dimensions.run_cap === "number" ? `运行数上限 ${dimensions.run_cap}` : null,
  ].filter((item): item is string => item !== null);
  return entries.join(" · ") || "—";
}

export function GovernancePage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(
    session,
    EnterpriseRole.OWNER,
    EnterpriseRole.ENTERPRISE_ADMIN,
    EnterpriseRole.FINANCE_ADMIN,
  );
  const api = useGovernanceApi();

  const [rollups, setRollups] = useState<UsageRollup[]>([]);
  const [audits, setAudits] = useState<AuditSummary[]>([]);
  const [quotas, setQuotas] = useState<QuotaPolicy[]>([]);
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [auditActionFilter, setAuditActionFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<EnforcementAction | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setEvaluation(null);
    try {
      const [nextRollups, nextAudits, nextQuotas] = await Promise.all([
        api.listUsageRollups(),
        api.listAudits(),
        api.listQuotas(),
      ]);
      setRollups(nextRollups);
      setAudits(nextAudits);
      setQuotas(nextQuotas);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.gov.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await action();
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.gov.action_error"));
      }
    },
    [i18n, load],
  );

  const handleEvaluate = useCallback(
    async (quota: QuotaPolicy) => {
      setActionError(null);
      setEvaluation(null);
      try {
        setEvaluation(await api.evaluateQuota(quota.policy_id, quota.window_start, quota.window_end));
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.gov.action_error"));
      }
    },
    [api, i18n],
  );

  const employeeOptions = useMemo(
    () => [
      { value: "all", label: "全部员工" },
      ...Array.from(new Set(rollups.map((rollup) => rollup.employee_id).filter(Boolean))).map((employeeId) => ({
        value: employeeId!,
        label: employeeId!,
      })),
    ],
    [rollups],
  );
  const auditActionOptions = useMemo(
    () => [
      { value: "all", label: "全部动作" },
      ...Array.from(new Set(audits.map((audit) => audit.action))).map((action) => ({ value: action, label: action })),
    ],
    [audits],
  );
  const visibleRollups = useMemo(
    () => rollups.filter((rollup) => employeeFilter === "all" || rollup.employee_id === employeeFilter),
    [employeeFilter, rollups],
  );
  const visibleAudits = useMemo(
    () => audits.filter((audit) => auditActionFilter === "all" || audit.action === auditActionFilter),
    [auditActionFilter, audits],
  );

  const rollupColumns = useMemo<TableColumn<UsageRollupRow>[]>(
    () => [
      {
        key: "window",
        header: i18n.t("manager.gov.window"),
        width: proportional(2),
        renderCell: (rollup) => <Text data-testid="rollup-row">{rollup.window_start} ~ {rollup.window_end}</Text>,
      },
      { key: "run_count", header: i18n.t("manager.gov.runs"), width: pixel(100) },
      { key: "token_total", header: i18n.t("manager.gov.tokens"), width: pixel(120) },
      { key: "cost_total", header: i18n.t("manager.gov.cost"), width: pixel(120), renderCell: (rollup) => String(rollup.cost_total) },
      { key: "error_count", header: i18n.t("manager.gov.errors"), width: pixel(100) },
    ],
    [i18n],
  );
  const auditColumns = useMemo<TableColumn<AuditSummaryRow>[]>(
    () => [
      { key: "actor", header: i18n.t("manager.gov.actor"), width: proportional(1), renderCell: (audit) => <Text data-testid="audit-row">{audit.actor}</Text> },
      { key: "action", header: i18n.t("manager.gov.action"), width: proportional(1) },
      {
        key: "resource",
        header: i18n.t("manager.gov.resource"),
        width: proportional(1),
        renderCell: (audit) => audit.resource_type ? `${audit.resource_type}:${audit.resource_id ?? ""}` : "—",
      },
      { key: "occurred_at", header: i18n.t("manager.gov.time"), width: pixel(200) },
    ],
    [i18n],
  );
  const quotaColumns = useMemo<TableColumn<QuotaPolicyRow>[]>(
    () => [
      {
        key: "policy_slug",
        header: "策略",
        width: proportional(1),
        renderCell: (quota) => <Text data-testid="quota-row" weight="bold">{quota.display_name || quota.policy_slug}</Text>,
      },
      { key: "dimensions", header: "阈值", width: proportional(2), renderCell: (quota) => quotaDimensions(quota.dimensions) },
      { key: "enforcement", header: i18n.t("manager.gov.enforcement"), width: pixel(120), renderCell: (quota) => <Badge label={quota.enforcement} variant={badgeVariant(quota.enforcement)} /> },
      { key: "status", header: "状态", width: pixel(110), renderCell: (quota) => <Badge label={quota.status} variant={badgeVariant(quota.status)} /> },
      {
        key: "actions",
        header: "操作",
        width: pixel(canWrite ? 180 : 88),
        align: "end",
        resizable: false,
        renderCell: (quota) => (
          <HStack gap={1} justify="end">
            <Button label={i18n.t("manager.gov.evaluate")} variant="ghost" size="sm" onClick={() => void handleEvaluate(quota)} />
            {canWrite && (
              <Button
                label={i18n.t("manager.gov.delete")}
                variant="destructive"
                size="sm"
                onClick={() => void runAction(() => api.deleteQuota(quota.policy_id))}
              />
            )}
          </HStack>
        ),
      },
    ],
    [api, canWrite, handleEvaluate, i18n, runAction],
  );

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>{i18n.t("manager.nav.governance")}</Heading>
      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label="治理数据加载中" padding={4}>
          <VStack gap={2}>
            <Skeleton height={32} />
            <Skeleton height={120} index={1} />
            <Skeleton height={120} index={2} />
          </VStack>
        </Card>
      ) : (
        <>
          <Grid columns={{ minWidth: 360, repeat: "fit" }} gap={4}>
            <Card padding={4}>
              <VStack gap={4}>
                <HStack justify="between" align="center" wrap="wrap" gap={3}>
                  <Heading level={2}>{i18n.t("manager.gov.usage_title")}</Heading>
                  <Selector
                    label="员工筛选"
                    isLabelHidden
                    options={employeeOptions}
                    value={employeeFilter}
                    onChange={setEmployeeFilter}
                    width={180}
                  />
                </HStack>
                <Table
                  aria-label="计量汇总"
                  tableProps={{ "aria-label": "计量汇总" }}
                  data={visibleRollups as UsageRollupRow[]}
                  columns={rollupColumns}
                  idKey="rollup_id"
                  density="compact"
                  hasHover
                  textOverflow="truncate"
                  emptyState={<EmptyState headingLevel={3} title={i18n.t("manager.gov.usage_empty")} isCompact />}
                />
              </VStack>
            </Card>

            <Card padding={4}>
              <VStack gap={4}>
                <HStack justify="between" align="center" wrap="wrap" gap={3}>
                  <Heading level={2}>{i18n.t("manager.gov.audit_title")}</Heading>
                  <Selector
                    label="审计动作筛选"
                    isLabelHidden
                    options={auditActionOptions}
                    value={auditActionFilter}
                    onChange={setAuditActionFilter}
                    width={180}
                  />
                </HStack>
                <Table
                  aria-label="审计事件摘要"
                  tableProps={{ "aria-label": "审计事件摘要" }}
                  data={visibleAudits as AuditSummaryRow[]}
                  columns={auditColumns}
                  idKey="event_id"
                  density="compact"
                  hasHover
                  textOverflow="truncate"
                  emptyState={<EmptyState headingLevel={3} title={i18n.t("manager.gov.audit_empty")} isCompact />}
                />
              </VStack>
            </Card>
          </Grid>

          <VStack gap={4}>
            <Heading level={2}>{i18n.t("manager.gov.quota_title")}</Heading>
            {canWrite && <QuotaForm onCreate={(input) => runAction(() => api.createQuota(input))} />}
            {evaluation && (
              <Card role="status" aria-label="配额评估结果" padding={3}>
                <HStack gap={2} wrap="wrap" align="center">
                  <Text weight="bold">{evaluation.policy_slug}</Text>
                  <Badge label={evaluation.severity} variant={badgeVariant(evaluation.severity)} />
                  {evaluation.actions.map((action) => <Badge key={action} label={action} />)}
                  {evaluation.detail && <Text color="secondary">{evaluation.detail}</Text>}
                </HStack>
              </Card>
            )}
            <Card padding={0}>
              <Table
                aria-label="配额策略"
                tableProps={{ "aria-label": "配额策略" }}
                data={quotas as QuotaPolicyRow[]}
                columns={quotaColumns}
                idKey="policy_id"
                density="compact"
                hasHover
                textOverflow="truncate"
                emptyState={<EmptyState headingLevel={3} title={i18n.t("manager.gov.quota_empty")} isCompact />}
              />
            </Card>
          </VStack>
        </>
      )}
    </VStack>
  );
}

function QuotaForm({ onCreate }: { onCreate: (input: CreateQuotaInput) => void | Promise<void> }): ReactNode {
  const i18n = useI18n();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [enforcement, setEnforcement] = useState<"soft" | "hard">("soft");
  const [costCap, setCostCap] = useState<number | null>(null);
  const [runCap, setRunCap] = useState<number | null>(null);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!slug.trim()) return;
    const dimensions: Record<string, number> = {};
    if (costCap !== null) dimensions.cost_cap_usd = costCap;
    if (runCap !== null) dimensions.run_cap = runCap;
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    void onCreate({
      policy_slug: slug.trim(),
      display_name: displayName.trim(),
      scope: "tenant",
      window_start: now.toISOString(),
      window_end: end.toISOString(),
      dimensions,
      enforcement,
      status: "active",
    });
    setSlug("");
    setDisplayName("");
    setEnforcement("soft");
    setCostCap(null);
    setRunCap(null);
  }

  return (
    <Card padding={4}>
      <form onSubmit={submit}>
        <VStack gap={4}>
          <Heading level={3}>{i18n.t("manager.gov.quota_create")}</Heading>
          <FormLayout direction="horizontal">
            <TextInput
              label={i18n.t("manager.gov.slug")}
              value={slug}
              onChange={setSlug}
              isRequired
            />
            <TextInput
              label={i18n.t("manager.gov.display_name")}
              value={displayName}
              onChange={setDisplayName}
              isOptional
            />
            <Selector
              label={i18n.t("manager.gov.enforcement")}
              options={ENFORCEMENT_OPTIONS}
              value={enforcement}
              onChange={(value) => setEnforcement(value as "soft" | "hard")}
            />
            <NumberInput
              label={i18n.t("manager.gov.cost_cap")}
              value={costCap}
              onChange={setCostCap}
              hasClear
              min={0}
              step={0.01}
            />
            <NumberInput
              label={i18n.t("manager.gov.run_cap")}
              value={runCap}
              onChange={setRunCap}
              hasClear
              min={0}
              isIntegerOnly
            />
          </FormLayout>
          <Button
            label={i18n.t("manager.gov.quota_submit")}
            type="submit"
            variant="primary"
            size="sm"
            isDisabled={!slug.trim()}
          />
        </VStack>
      </form>
    </Card>
  );
}
