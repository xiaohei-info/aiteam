/**
 * 专家实例详情 / LLM 配置抽屉（AITEAM-683）。
 *
 * 列表行点击后打开：展示并修改 display_name / persona / department_ids / model_policy / execution_policy；
 * provider 与 model 只能从 Operator 对本 tenant 发布的平台模型目录选择（V1 不提供手输）。
 *
 * 保存复用 PUT /api/manager/employees/{employee_id}，回传完整载入配置，
 * 仅覆盖被编辑字段，保全 tools/skills/knowledge_refs 等未触达配置。
 *
 * 优先由调用方注入已加载的 `employee`，避免抽屉内重复 GET 全表 + 线性查找；
 * 未注入时（如未来独立进入）回退到按 employeeId 从列表拉取。
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import { DepartmentSelector } from "./DepartmentSelector";
import { KnowledgePolicyPanel } from "./KnowledgePolicyPanel";
import { MemoryPolicyPanel } from "./MemoryPolicyPanel";
import { useExpertsApi } from "./useExpertsApi";
import { usePlatformModelsApi, type PlatformModelItem, type ThinkingLevel } from "../platform-models/usePlatformModelsApi";
import { useCapabilityApi } from "../capability/useCapabilityApi";
import type { Department, EmployeeConfig, EmployeeConfigIn } from "./types";
import type { PlatformCatalog } from "../platform-models/usePlatformModelsApi";
import type { SkillCatalog } from "../capability/types";

export interface EmployeeConfigDrawerProps {
  employeeId: string | null;
  /** 由列表页注入已加载的实例，避免抽屉内按 id 重复拉取全表。 */
  employee?: EmployeeConfig | null;
  departments?: Department[];
  onClose: () => void;
  onSaved: (updated: EmployeeConfig) => void;
}

const DEFAULT_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Draft = {
  display_name: string;
  persona: string;
  provider_ref: string;
  provider_version: number | null;
  model: string;
  model_version: number | null;
  thinking_level: string;
  timeout_seconds: string;
  skills: string[];
  department_ids: string[];
};

function normalizeLegacyThinkingLevel(value: string | null | undefined): string {
  if (!value || value === "none") return "";
  if (value === "basic") return "low";
  if (value === "deep") return "high";
  return value;
}

function thinkingLevelsForModel(item: PlatformModelItem | null): ThinkingLevel[] {
  const configured = item?.model.capabilities?.thinking_levels;
  if (configured?.length) return [...new Set(configured)];
  const mapped = item?.model.capabilities?.thinking_level_map;
  if (mapped) {
    const levels = ALL_THINKING_LEVELS.filter((level) =>
      mapped[level] !== null && (level === "off" || mapped[level] !== undefined),
    );
    if (levels.length) return levels;
  }
  return item?.model.capabilities?.reasoning === false ? ["off"] : DEFAULT_THINKING_LEVELS;
}

function toDraft(e: EmployeeConfig): Draft {
  return {
    display_name: e.display_name,
    persona: e.persona ?? "",
    provider_ref: e.model_policy.provider_ref ?? "",
    provider_version: e.model_policy.provider_version ?? null,
    model: e.model_policy.model,
    model_version: e.model_policy.model_version ?? null,
    thinking_level: normalizeLegacyThinkingLevel(e.model_policy.thinking_level),
    timeout_seconds:
      e.execution_policy.timeout_seconds != null ? String(e.execution_policy.timeout_seconds) : "",
    skills: e.skills,
    department_ids: e.department_ids ?? [],
  };
}

/** 从 EmployeeConfig 中剔除服务端托管字段，得到 PUT 请求的 EmployeeConfigIn 负载。 */
export function toEmployeeConfigIn(config: EmployeeConfig): EmployeeConfigIn {
  const {
    employee_id,
    employee_slug,
    version,
    status,
    archive_reason,
    archived_at,
    memory_policy,
    ...editable
  } = config;
  void employee_id;
  void employee_slug;
  void version;
  void status;
  void archive_reason;
  void archived_at;
  // Memory is edited independently and immediately. Never echo a stale drawer snapshot.
  void memory_policy;
  return editable;
}

export function EmployeeConfigDrawer({
  employeeId,
  employee: injectedEmployee,
  departments = [],
  onClose,
  onSaved,
}: EmployeeConfigDrawerProps): ReactNode {
  const i18n = useI18n();
  const experts = useExpertsApi();
  const platformModelsApi = usePlatformModelsApi();
  const capabilityApi = useCapabilityApi();

  const [employee, setEmployee] = useState<EmployeeConfig | null>(null);
  const [catalog, setCatalog] = useState<PlatformCatalog>({ providers: [], models: [] });
  const [skills, setSkills] = useState<SkillCatalog[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!employeeId) {
      setEmployee(null);
      setDraft(null);
      return;
    }
    // 已注入 employee 时直接使用，避免全表 GET + 线性查找。
    if (injectedEmployee && injectedEmployee.employee_id === employeeId) {
      setEmployee(injectedEmployee);
      setDraft(toDraft(injectedEmployee));
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    experts
      .listEmployees()
      .then((items) => {
        if (!alive) return;
        const found = items.find((e) => e.employee_id === employeeId) ?? null;
        setEmployee(found);
        setDraft(found ? toDraft(found) : null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [employeeId, injectedEmployee, experts, i18n]);

  useEffect(() => {
    let alive = true;
    setProvidersLoading(true);
    platformModelsApi
      .list()
      .then((items) => {
        if (alive) setCatalog(items);
      })
      .finally(() => {
        if (alive) setProvidersLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [platformModelsApi]);

  useEffect(() => {
    let alive = true;
    capabilityApi.listSkills().then((items) => { if (alive) setSkills(items); }).catch(() => undefined);
    return () => { alive = false; };
  }, [capabilityApi]);

  /** D18：选择 Operator 发布且有生效价格的模型；旧配置即使价格失效也保留可见。 */
  const availableModels = useMemo(
    () => catalog.models.filter((item) =>
      item.model.status === "published"
      && (item.rate?.pricing_status === "known" || item.model.model_id === draft?.model)
    ),
    [catalog.models, draft?.model],
  );

  const selectedModel = useMemo(
    () => catalog.models.find((item) =>
      item.model.model_id === draft?.model
      && (!draft?.provider_ref || item.model.provider_id === draft.provider_ref)
    ) ?? null,
    [catalog.models, draft?.model, draft?.provider_ref],
  );

  const modelOptions = useMemo(
    () => availableModels.map((item) => ({
      value: item.model.model_id,
      label: `${item.model.display_name && item.model.display_name !== item.model.model_id
        ? `${item.model.display_name} · `
        : ""}${item.model.model_id || "未命名模型"}${item.rate?.pricing_status === "known"
        ? ` · $${item.rate.input_usd_per_million}/$${item.rate.output_usd_per_million}`
        : " · 价格待确认"}`,
    })),
    [availableModels],
  );

  const thinkingOptions = useMemo(() => {
    const levels = thinkingLevelsForModel(selectedModel);
    const current = draft?.thinking_level;
    if (current && !levels.includes(current as ThinkingLevel) && ALL_THINKING_LEVELS.includes(current as ThinkingLevel)) {
      levels.push(current as ThinkingLevel);
    }
    return levels.map((level) => ({
      value: level,
      label: selectedModel?.model.capabilities?.thinking_mode === "toggle" && level === "high"
        ? i18n.t("manager.experts.thinking_enabled")
        : i18n.t(`manager.experts.thinking_${level}`),
    }));
  }, [draft?.thinking_level, i18n, selectedModel]);

  if (!employeeId) return null;

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!employee || !draft) return;
    setSubmitting(true);
    setError(null);

    const selected = availableModels.find((item) => item.model.model_id === draft.model) ?? selectedModel;
    const selectedProvider = selected
      ? catalog.providers.find((provider) => provider.provider_id === selected.model.provider_id)
      : null;
    const providerRef = selected?.model.provider_id ?? (draft.provider_ref.trim() || null);
    if (draft.model && !providerRef) {
      setError("模型尚未关联平台服务，请刷新目录后重试");
      setSubmitting(false);
      return;
    }

    const timeoutRaw = draft.timeout_seconds.trim();
    let timeout: number | null = null;
    if (timeoutRaw !== "") {
      const n = Number(timeoutRaw);
      if (!Number.isFinite(n) || n <= 0) {
        setError(i18n.t("manager.experts.timeout_invalid"));
        setSubmitting(false);
        return;
      }
      timeout = n;
    }

    const updated: EmployeeConfig = {
      ...employee,
      display_name: draft.display_name.trim() || employee.display_name,
      persona: draft.persona.trim() === "" ? null : draft.persona,
      model_policy: {
        model: draft.model,
        provider_ref: providerRef,
        provider_version: selectedProvider?.version ?? draft.provider_version,
        model_version: selected?.model.version ?? draft.model_version,
        pricing: null,
        thinking_level:
          draft.thinking_level === "" || draft.thinking_level === "off" ? null : draft.thinking_level,
      },
      execution_policy: {
        timeout_seconds: timeout,
      },
      skills: draft.skills,
      department_ids: draft.department_ids,
    };

    try {
      const saved = await experts.updateEmployee(
        employee.employee_id,
        toEmployeeConfigIn(updated),
      );
      onSaved(saved ?? updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.save_error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      isOpen
      purpose="form"
      width={720}
      maxHeight="90vh"
      aria-label={i18n.t("manager.experts.detail_title")}
      onOpenChange={(isOpen) => { if (!isOpen && !submitting) onClose(); }}
    >
      <Layout
        height="auto"
        header={
          <DialogHeader
            title={i18n.t("manager.experts.detail_title")}
            subtitle={employee?.employee_slug}
            onOpenChange={(isOpen) => { if (!isOpen && !submitting) onClose(); }}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={4}>
              {error && <Banner status="error" title={error} />}
              {loading || !draft ? (
                <VStack gap={2} role="status" aria-label={i18n.t("manager.experts.loading")}>
                  <Text color="secondary">{i18n.t("manager.experts.loading")}</Text>
                  <Skeleton height={36} />
                  <Skeleton height={36} index={1} />
                </VStack>
              ) : (
                <form id="employee-config-form" onSubmit={handleSubmit}>
                  <VStack gap={5}>
                    <VStack gap={3}>
                      <Heading level={3}>{i18n.t("manager.experts.section_prompt")}</Heading>
                      <FormLayout>
                        <TextInput
                          label={i18n.t("manager.experts.display_name")}
                          value={draft.display_name}
                          onChange={(value) => update("display_name", value)}
                          isDisabled={submitting}
                        />
                        <TextInput
                          label={i18n.t("manager.experts.persona")}
                          value={draft.persona}
                          onChange={(value) => update("persona", value)}
                          placeholder={i18n.t("manager.experts.persona")}
                          isDisabled={submitting}
                        />
                      </FormLayout>
                    </VStack>

                    <VStack gap={3}>
                      <Heading level={3}>组织归属</Heading>
                      <DepartmentSelector
                        departments={departments}
                        value={draft.department_ids}
                        onChange={(value) => update("department_ids", value)}
                        label="所属部门"
                        isDisabled={submitting}
                        dataTestId="employee-departments-selector"
                      />
                    </VStack>

                    <VStack gap={3}>
                      <Heading level={3}>{i18n.t("manager.experts.section_model")}</Heading>
                      <FormLayout>
                        <Selector
                          label={i18n.t("manager.experts.model")}
                          options={modelOptions}
                          value={modelOptions.some((model) => model.value === draft.model) ? draft.model : undefined}
                          placeholder={modelOptions.length === 0
                            ? "暂无可用模型"
                            : i18n.t("manager.experts.model_pick")}
                          isDisabled={submitting || providersLoading || modelOptions.length === 0}
                          isLoading={providersLoading}
                          data-testid="model-select"
                          onChange={(value) => {
                            const selected = availableModels.find((item) => item.model.model_id === value) ?? null;
                            const provider = selected
                              ? catalog.providers.find((item) => item.provider_id === selected.model.provider_id)
                              : null;
                            const levels = thinkingLevelsForModel(selected);
                            setDraft((current) => current ? {
                              ...current,
                              provider_ref: selected?.model.provider_id ?? "",
                              provider_version: provider?.version ?? null,
                              model: value,
                              model_version: selected?.model.version ?? null,
                              thinking_level: current.thinking_level && levels.includes(current.thinking_level as ThinkingLevel)
                                ? current.thinking_level
                                : "",
                            } : current);
                          }}
                        />

                        <Selector
                          label={i18n.t("manager.experts.thinking_level")}
                          options={thinkingOptions}
                          value={thinkingOptions.some((option) => option.value === draft.thinking_level) ? draft.thinking_level : undefined}
                          placeholder={i18n.t("manager.experts.thinking_none")}
                          isDisabled={submitting || !draft.model || thinkingOptions.length === 0}
                          onChange={(value) => update("thinking_level", value)}
                        />
                      </FormLayout>
                    </VStack>

                    <VStack gap={3}>
                      <Heading level={3}>技能</Heading>
                      <MultiSelector
                        label="企业已安装技能"
                        description={skills.length ? "选择此专家可使用的技能" : "暂无已安装技能，请先前往技能市场安装"}
                        options={skills.map((skill) => ({ value: skill.skill_id, label: `${skill.display_name || "未命名技能"} · v${skill.version}` }))}
                        value={draft.skills}
                        onChange={(value) => update("skills", value)}
                        placeholder="选择技能"
                        triggerDisplay="labels"
                        isDisabled={submitting || skills.length === 0}
                      />
                    </VStack>

                    <KnowledgePolicyPanel key={employeeId} employeeId={employeeId} tools={employee?.tools ?? []} />
                    <MemoryPolicyPanel key={`memory-${employeeId}`} employeeId={employeeId} />

                    <VStack gap={3}>
                      <Heading level={3}>{i18n.t("manager.experts.execution_policy")}</Heading>
                      <FormLayout>
                        <TextInput
                          label={i18n.t("manager.experts.timeout_seconds")}
                          value={draft.timeout_seconds}
                          onChange={(value) => update("timeout_seconds", value)}
                          isDisabled={submitting}
                        />
                      </FormLayout>
                    </VStack>
                  </VStack>
                </form>
              )}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <HStack gap={2} justify="end">
              <Button
                label={i18n.t("manager.experts.cancel")}
                variant="ghost"
                isDisabled={submitting}
                onClick={onClose}
              />
              <Button
                label={i18n.t("manager.experts.save")}
                variant="primary"
                type="submit"
                form="employee-config-form"
                isDisabled={loading || !draft}
                isLoading={submitting}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
