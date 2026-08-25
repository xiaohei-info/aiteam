/**
 * SolutionApplyRecord 追踪页——方案应用历史/状态（AITEAM-266，upstream #316）。
 *
 * 企业此前无法追踪方案应用历史、查看落地状态、了解每个方案每次是谁/何时/以何版本落到本租户。
 * 本页把这些信息（源自后端 solution_apply_record 审计表）呈现为可扫读的列表：
 * 已落地方案实例 + 某方案的方案应用历史记录（who/when/version/status + 落地专家）。
 *
 * 只读页；写配置仍走「招募专家」页的操作。租户隔离由后端 TenantContext 裁决（D22），
 * 前端不拼 tenant 过滤、不跨端直调。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import { useGrantsApi } from "../grants/useGrantsApi";
import { useSolutionApplyApi } from "./useSolutionApplyApi";
import type { SolutionApplyRecord, SolutionInstanceSummary } from "./types";

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  applied: "success",
  revoked: "error",
};

export function SolutionApplyHistoryPage(): ReactNode {
  const i18n = useI18n();
  const api = useSolutionApplyApi();
  const expertsApi = useExpertsApi();
  const grantsApi = useGrantsApi();
  const [instances, setInstances] = useState<SolutionInstanceSummary[]>([]);
  const [expertNames, setExpertNames] = useState<Map<string, string>>(new Map());
  const [memberNames, setMemberNames] = useState<Map<string, string>>(new Map());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [records, setRecords] = useState<SolutionApplyRecord[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInstances = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextInstances, employees, members] = await Promise.all([
        api.listSolutionInstances(),
        expertsApi.listEmployees().catch(() => []),
        grantsApi.listMembers().catch(() => []),
      ]);
      setInstances(nextInstances);
      setExpertNames(new Map(employees.map((employee) => [employee.employee_id, employee.display_name])));
      setMemberNames(new Map(members.map((member) => [member.id, member.display_name])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, expertsApi, grantsApi, i18n]);

  const setRecordsOpen = useCallback(
    async (isOpen: boolean, instanceId: string, solutionId: string) => {
      if (!isOpen) {
        setActiveId(null);
        return;
      }
      setActiveId(instanceId);
      setRecordsLoading(true);
      try {
        setRecords(await api.listApplyRecords(solutionId));
      } catch {
        setRecords([]);
      } finally {
        setRecordsLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);

  return (
    <VStack as="section" gap={6}>
      <VStack gap={1}>
        <Heading level={1}>{i18n.t("manager.solution_apply.title")}</Heading>
        <Text color="secondary">{i18n.t("manager.solution_apply.description")}</Text>
      </VStack>

      {error && <Banner status="error" title={error} />}

      {loading ? (
        <VStack gap={2} role="status" aria-label={i18n.t("manager.experts.loading")}>
          <Text color="secondary">{i18n.t("manager.experts.loading")}</Text>
          <Skeleton height={84} />
        </VStack>
      ) : instances.length === 0 ? (
        <EmptyState headingLevel={2} title={i18n.t("manager.solution_apply.empty_instances")} />
      ) : (
        <VStack gap={3}>
          {instances.map((instance) => {
            const open = activeId === instance.id;
            const name = instance.display_name || "未命名方案";
            return (
              <Card
                key={instance.id}
                role="article"
                aria-label={name}
                data-testid="instance-row"
              >
                <Collapsible
                  isOpen={open}
                  onOpenChange={(isOpen) => void setRecordsOpen(
                    isOpen,
                    instance.id,
                    instance.solution_id,
                  )}
                  trigger={
                    <HStack gap={2} align="center" wrap="wrap">
                      <Text weight="bold">{name}</Text>
                      <Text type="supporting">版本 {instance.solution_version ? `v${instance.solution_version}` : "—"}</Text>
                      <Badge label={instance.status} variant={STATUS_VARIANT[instance.status] ?? "neutral"} />
                      <Text color="accent">{i18n.t("manager.solution_apply.view_history")}</Text>
                    </HStack>
                  }
                >
                  <ApplyRecords
                    records={records}
                    loading={recordsLoading}
                    i18n={i18n}
                    expertNames={expertNames}
                    memberNames={memberNames}
                  />
                </Collapsible>
              </Card>
            );
          })}
        </VStack>
      )}
    </VStack>
  );
}

function ApplyRecords({
  records,
  loading,
  i18n,
  expertNames,
  memberNames,
}: {
  records: SolutionApplyRecord[];
  loading: boolean;
  i18n: ReturnType<typeof useI18n>;
  expertNames: Map<string, string>;
  memberNames: Map<string, string>;
}): ReactNode {
  if (loading) {
    return <Skeleton height={64} />;
  }
  if (records.length === 0) {
    return <EmptyState isCompact headingLevel={3} title={i18n.t("manager.solution_apply.empty_records")} />;
  }
  return (
    <VStack gap={2}>
      {records.map((record) => {
        return (
          <Card
            key={record.id}
            data-testid="apply-record-row"
            variant="muted"
            padding={3}
          >
            <VStack gap={3}>
              <HStack gap={2} align="center" wrap="wrap">
                <Badge
                  data-testid="apply-record-status"
                  label={i18n.t(`manager.solution_apply.status.${record.status}`)}
                  variant={STATUS_VARIANT[record.status] ?? "neutral"}
                />
                <Text color="secondary">
                  {record.solution_version ? `v${record.solution_version}` : "—"}
                </Text>
              </HStack>
              <MetadataList columns="single">
                <MetadataListItem label={i18n.t("manager.solution_apply.applied_by")}>
                  {record.applied_by ? memberNames.get(record.applied_by) ?? "企业管理员" : "—"}
                </MetadataListItem>
                <MetadataListItem label={i18n.t("manager.solution_apply.applied_at")}>
                  {record.created_at?.slice(0, 19) ?? "—"}
                </MetadataListItem>
                <MetadataListItem label={i18n.t("manager.solution_apply.expert_count")}>
                  <VStack gap={1}>
                    <Text>{record.expert_instance_ids.length}</Text>
                    {record.expert_instance_ids.length > 0 && (
                      <HStack gap={1} wrap="wrap">
                        {record.expert_instance_ids.map((id) => (
                          <Text key={id}>{expertNames.get(id) ?? "已删除专家"}</Text>
                        ))}
                      </HStack>
                    )}
                  </VStack>
                </MetadataListItem>
              </MetadataList>
            </VStack>
          </Card>
        );
      })}
    </VStack>
  );
}
