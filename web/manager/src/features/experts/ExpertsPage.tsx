/**
 * 专家实例列表页（AITEAM-683）。
 *
 * Manager 端查看本 tenant 已招募/落地的专家实例，点击行打开
 * {@link EmployeeConfigDrawer} 修改 LLM/provider 配置。
 *
 * 原占位（Deprecated）被本实现替代（AITEAM-356 时招募/实例入口收口到
 * /marketplace + /solutions；本卡恢复实例列表 + 详情配置能力）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Code } from "@astryxdesign/core/CodeBlock";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import { EmployeeConfigDrawer } from "./EmployeeConfigDrawer";
import { useExpertsApi } from "./useExpertsApi";
import type { EmployeeConfig } from "./types";

type EmployeeRow = EmployeeConfig & Record<string, unknown>;

export function ExpertsPage(): ReactNode {
  const i18n = useI18n();
  const api = useExpertsApi();

  const [items, setItems] = useState<EmployeeConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listEmployees());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  // 直接定位已加载实例，注入抽屉以避免抽屉内再次按 id 线性查找。
  const detailEmployee = useMemo(
    () => (detailId ? items.find((e) => e.employee_id === detailId) ?? null : null),
    [detailId, items],
  );

  const onSaved = useCallback(
    (updated: EmployeeConfig) => {
      setItems((prev) => prev.map((e) => (e.employee_id === updated.employee_id ? updated : e)));
      setDetailId(null);
    },
    [],
  );

  const transition = useCallback(async (employee: EmployeeConfig, action: "activate" | "pause" | "resume") => {
    setTransitioningId(employee.employee_id);
    setError(null);
    try {
      const updated = await api.transitionEmployee(employee.employee_id, action);
      if (updated) setItems((current) => current.map((item) => item.employee_id === updated.employee_id ? updated : item));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.action_error"));
    } finally {
      setTransitioningId(null);
    }
  }, [api, i18n]);

  const columns = useMemo<TableColumn<EmployeeRow>[]>(() => [
    {
      key: "display_name",
      header: i18n.t("manager.experts.display_name"),
      width: proportional(1),
      renderCell: (employee) => (
        <Text weight="bold" data-testid="employee-row">{employee.display_name}</Text>
      ),
    },
    {
      key: "employee_slug",
      header: "slug",
      width: proportional(1),
      renderCell: (employee) => <Code>{employee.employee_slug}</Code>,
    },
    {
      key: "status",
      header: i18n.t("manager.experts.status_active"),
      width: pixel(110),
      renderCell: (employee) => (
        <Badge
          label={employee.status}
          variant={employee.status === "active" ? "success" : "neutral"}
        />
      ),
    },
    {
      key: "provider_ref",
      header: i18n.t("manager.experts.provider_ref"),
      width: proportional(1),
      renderCell: (employee) => employee.model_policy.provider_ref ?? "—",
    },
    {
      key: "model",
      header: i18n.t("manager.experts.model"),
      width: proportional(1),
      renderCell: (employee) => employee.model_policy.model || "—",
    },
    {
      key: "config_status",
      header: i18n.t("manager.experts.config_status"),
      width: pixel(120),
      renderCell: (employee) => {
        const configured = Boolean(employee.model_policy.provider_ref && employee.model_policy.model);
        return (
          <Badge
            data-testid="config-status"
            label={configured
              ? i18n.t("manager.experts.configured")
              : i18n.t("manager.experts.unconfigured")}
            variant={configured ? "success" : "warning"}
          />
        );
      },
    },
    {
      key: "actions",
      header: "",
      width: pixel(200),
      align: "end",
      resizable: false,
      renderCell: (employee) => {
        const action = employee.status === "active" ? "pause" : employee.status === "paused" ? "resume" : employee.status === "draft" ? "activate" : null;
        const configured = Boolean(employee.model_policy.provider_ref && employee.model_policy.model);
        return (
          <HStack gap={1} justify="end">
            <Button
              label={i18n.t("manager.experts.edit_config")}
              variant="ghost"
              size="sm"
              data-testid="edit-config"
              onClick={() => setDetailId(employee.employee_id)}
            />
            {action ? (
              <Button
                label={i18n.t(`manager.experts.transition_${action}`)}
                variant="secondary"
                size="sm"
                isLoading={transitioningId === employee.employee_id}
                isDisabled={transitioningId !== null || action === "activate" && !configured}
                onClick={() => void transition(employee, action)}
              />
            ) : null}
          </HStack>
        );
      },
    },
  ], [i18n, transition, transitioningId]);

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>
        {i18n.t("manager.experts.instances_title")}
      </Heading>

      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.experts.loading")}>
          <VStack gap={2}>
            <Text color="secondary">{i18n.t("manager.experts.loading")}</Text>
            <Skeleton height={36} />
            <Skeleton height={36} index={1} />
          </VStack>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState headingLevel={2} title={i18n.t("manager.experts.instances_empty")} />
      ) : (
        <Card padding={0}>
          <Table
            aria-label={i18n.t("manager.experts.instances_title")}
            tableProps={{ "aria-label": i18n.t("manager.experts.instances_title") }}
            data={items as EmployeeRow[]}
            columns={columns}
            idKey="employee_id"
            hasHover
            textOverflow="truncate"
          />
        </Card>
      )}

      {detailId && (
        <EmployeeConfigDrawer
          employeeId={detailId}
          employee={detailEmployee}
          onClose={() => setDetailId(null)}
          onSaved={onSaved}
        />
      )}
    </VStack>
  );
}
