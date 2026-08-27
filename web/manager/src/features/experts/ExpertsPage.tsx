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
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import { EmployeeConfigDrawer } from "./EmployeeConfigDrawer";
import { useExpertsApi } from "./useExpertsApi";
import type { EmployeeConfig } from "./types";
import "./experts.css";

type ExpertFilter = "all" | "active" | "attention";

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (value.trim().slice(0, 2) || "AI").toUpperCase();
}

function statusPresentation(status: string): { label: string; tone: string } {
  if (status === "active") return { label: "运行中", tone: "is-active" };
  if (status === "paused") return { label: "已暂停", tone: "is-paused" };
  if (status === "draft") return { label: "待上线", tone: "is-draft" };
  if (status === "archived") return { label: "已归档", tone: "is-archived" };
  return { label: status || "未知状态", tone: "is-archived" };
}

export function ExpertsPage(): ReactNode {
  const i18n = useI18n();
  const api = useExpertsApi();

  const [items, setItems] = useState<EmployeeConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [transitioningId, setTransitioningId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExpertFilter>("all");

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

  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return items.filter((employee) => {
      const configured = Boolean(employee.model_policy.provider_ref && employee.model_policy.model);
      const matchesFilter = filter === "all"
        || (filter === "active" && employee.status === "active")
        || (filter === "attention" && (employee.status !== "active" || !configured));
      const searchable = [employee.display_name, employee.persona, employee.model_policy.model]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return matchesFilter && (!normalized || searchable.includes(normalized));
    });
  }, [filter, items, query]);

  const summaryStats = [
    { key: "all" as const, label: "全部专家", value: items.length },
    { key: "active" as const, label: "运行中", value: items.filter((employee) => employee.status === "active").length },
    {
      key: "attention" as const,
      label: "待处理",
      value: items.filter((employee) => employee.status !== "active" || !employee.model_policy.provider_ref || !employee.model_policy.model).length,
    },
  ];

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

  return (
    <VStack as="section" gap={6} data-ui="expert-page">
      <div data-ui="expert-page-header">
        <VStack gap={1}>
          <Heading level={1}>{i18n.t("manager.experts.instances_title")}</Heading>
          <Text color="secondary">集中管理企业已启用的数字员工，保持每个岗位随时可用。</Text>
        </VStack>
      </div>

      <div data-ui="expert-summary" aria-label="专家实例概览">
        {summaryStats.map((stat) => (
          <button
            key={stat.key}
            type="button"
            data-ui="expert-summary-item"
            data-active={filter === stat.key ? "true" : "false"}
            aria-pressed={filter === stat.key}
            onClick={() => setFilter(stat.key)}
          >
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </button>
        ))}
      </div>

      <div data-ui="expert-toolbar">
        <TextInput
          label="搜索专家"
          isLabelHidden
          value={query}
          onChange={setQuery}
          placeholder="搜索专家名称、岗位或模型"
          startIcon="search"
          width="100%"
        />
        <div data-ui="expert-filter-tabs" role="group" aria-label="专家实例筛选">
          {summaryStats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              data-active={filter === stat.key ? "true" : "false"}
              aria-pressed={filter === stat.key}
              onClick={() => setFilter(stat.key)}
            >
              {stat.label}
            </button>
          ))}
        </div>
      </div>

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
        <div data-ui="expert-grid" data-testid="employee-list">
          {filteredItems.map((employee) => {
            const action = employee.status === "active" ? "pause" : employee.status === "paused" ? "resume" : employee.status === "draft" ? "activate" : null;
            const configured = Boolean(employee.model_policy.provider_ref && employee.model_policy.model);
            const status = statusPresentation(employee.status);
            const displayName = employee.display_name || "未命名专家";
            return (
              <article key={employee.employee_id} data-ui="expert-card" role="article" aria-label={displayName}>
                <div data-ui="expert-card-hero">
                  <div data-ui="expert-card-avatar" aria-hidden="true">{initials(displayName)}</div>
                  <div data-ui="expert-card-identity">
                    <Heading level={3}><span data-testid="employee-row">{displayName}</span></Heading>
                    <Text type="supporting">{employee.persona || "企业数字员工"}</Text>
                  </div>
                  <span data-ui="expert-card-status" data-status-tone={status.tone}>{status.label}</span>
                </div>

                <div data-ui="expert-card-meta">
                  <span><strong>模型</strong>{employee.model_policy.model || "待配置"}</span>
                  <span><strong>技能</strong>{employee.skills.length} 项</span>
                  <span><strong>知识</strong>{employee.knowledge_refs.length} 项</span>
                </div>

                <div data-ui="expert-card-config">
                  <span>运行配置</span>
                  <Badge
                    data-testid="config-status"
                    label={configured ? i18n.t("manager.experts.configured") : i18n.t("manager.experts.unconfigured")}
                    variant={configured ? "success" : "warning"}
                  />
                </div>

                <div data-ui="expert-card-footer">
                  <HStack gap={1} wrap="wrap" data-ui="expert-card-actions">
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
                </div>
              </article>
            );
          })}
          {!filteredItems.length && (
            <div data-ui="expert-grid-empty">
              <EmptyState headingLevel={2} title="没有匹配的专家" description="换个关键词或切换筛选条件再试试。" isCompact />
            </div>
          )}
        </div>
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
