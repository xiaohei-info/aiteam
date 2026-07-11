/**
 * 专家实例详情 / LLM 配置抽屉（AITEAM-683）。
 *
 * 列表行点击后打开：展示并修改 display_name / persona / model_policy / runtime_policy；
 * provider 与 model 先从本 tenant 的 provider-credentials 目录中选 provider，
 * 再从该 provider 的 enabled supported_models 中选 model（V1 不提供手输）。
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
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "./useExpertsApi";
import { useProvidersApi } from "../providers/useProvidersApi";
import type { EmployeeConfig, EmployeeConfigIn } from "./types";
import type { ProviderCredential } from "../providers/types";

export interface EmployeeConfigDrawerProps {
  employeeId: string | null;
  /** 由列表页注入已加载的实例，避免抽屉内按 id 重复拉取全表。 */
  employee?: EmployeeConfig | null;
  onClose: () => void;
  onSaved: (updated: EmployeeConfig) => void;
}

const THINKING_LEVELS = ["none", "basic", "deep"] as const;

type Draft = {
  display_name: string;
  persona: string;
  provider_ref: string;
  model: string;
  thinking_level: (typeof THINKING_LEVELS)[number] | "";
  runtime_binding: string;
  timeout_seconds: string;
};

function toDraft(e: EmployeeConfig): Draft {
  const tl = e.model_policy.thinking_level ?? "";
  return {
    display_name: e.display_name,
    persona: e.persona ?? "",
    provider_ref: e.model_policy.provider_ref ?? "",
    model: e.model_policy.model,
    thinking_level: (THINKING_LEVELS as readonly string[]).includes(tl)
      ? (tl as (typeof THINKING_LEVELS)[number])
      : "",
    runtime_binding: e.runtime_policy.runtime_binding ?? "",
    timeout_seconds:
      e.runtime_policy.timeout_seconds != null ? String(e.runtime_policy.timeout_seconds) : "",
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
    ...editable
  } = config;
  void employee_id;
  void employee_slug;
  void version;
  void status;
  void archive_reason;
  void archived_at;
  return editable;
}

export function EmployeeConfigDrawer({
  employeeId,
  employee: injectedEmployee,
  onClose,
  onSaved,
}: EmployeeConfigDrawerProps): ReactNode {
  const i18n = useI18n();
  const experts = useExpertsApi();
  const providersApi = useProvidersApi();

  const [employee, setEmployee] = useState<EmployeeConfig | null>(null);
  const [providers, setProviders] = useState<ProviderCredential[]>([]);
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
    providersApi
      .list()
      .then((items) => {
        if (alive) setProviders(items);
      })
      .finally(() => {
        if (alive) setProvidersLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [providersApi]);

  const selectedProvider = useMemo(
    () => providers.find((p) => p.provider_ref === draft?.provider_ref) ?? null,
    [providers, draft],
  );

  /** V1：仅允许选择 provider 声明为 enabled 的 supported_models。 */
  const availableModels = useMemo(
    () => (selectedProvider?.supported_models ?? []).filter((m) => m.enabled !== false),
    [selectedProvider],
  );

  const providerOptions = useMemo(
    () => providers.map((provider) => ({
      value: provider.provider_ref,
      label: provider.display_name || provider.provider_ref,
    })),
    [providers],
  );

  const modelOptions = useMemo(
    () => availableModels.map((model) => ({
      value: model.model,
      label: model.display_name || model.model,
    })),
    [availableModels],
  );

  if (!employeeId) return null;

  function update<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!employee || !draft) return;
    setSubmitting(true);
    setError(null);

    // 防御：未选 provider 不允许带 model（模型目录归属不明）。
    if (draft.model && !draft.provider_ref) {
      setError(i18n.t("manager.experts.provider_required_for_model"));
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
        provider_ref: draft.provider_ref.trim() === "" ? null : draft.provider_ref,
        thinking_level:
          draft.thinking_level === "" ? null : (draft.thinking_level as NonNullable<EmployeeConfig["model_policy"]["thinking_level"]>),
      },
      runtime_policy: {
        runtime_binding: draft.runtime_binding.trim() === "" ? null : draft.runtime_binding,
        timeout_seconds: timeout,
      },
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
                      <Heading level={3}>{i18n.t("manager.experts.section_model")}</Heading>
                      <FormLayout>
                        <Selector
                          label={i18n.t("manager.experts.provider_ref")}
                          options={providerOptions}
                          value={draft.provider_ref || undefined}
                          placeholder={i18n.t("manager.experts.provider_pick")}
                          isDisabled={submitting}
                          isLoading={providersLoading}
                          data-testid="provider-select"
                          onChange={(next) => {
                            setDraft((current) => {
                              if (!current) return current;
                              const provider = providers.find((item) => item.provider_ref === next) ?? null;
                              const models = (provider?.supported_models ?? []).filter((model) => model.enabled !== false);
                              return {
                                ...current,
                                provider_ref: next,
                                model: models.some((model) => model.model === current.model)
                                  ? current.model
                                  : "",
                              };
                            });
                          }}
                        />

                        {draft.model && !draft.provider_ref && (
                          <Banner status="warning" title={i18n.t("manager.experts.unverified_model_warn")} />
                        )}

                        <Selector
                          label={i18n.t("manager.experts.model")}
                          options={modelOptions}
                          value={modelOptions.some((model) => model.value === draft.model) ? draft.model : undefined}
                          placeholder={draft.provider_ref
                            ? modelOptions.length === 0
                              ? i18n.t("manager.experts.no_models_for_provider")
                              : i18n.t("manager.experts.model_pick")
                            : i18n.t("manager.experts.provider_first")}
                          isDisabled={submitting || !draft.provider_ref}
                          data-testid="model-select"
                          onChange={(value) => update("model", value)}
                        />

                        <Selector
                          label={i18n.t("manager.experts.thinking_level")}
                          options={[
                            { value: "basic", label: i18n.t("manager.experts.thinking_basic") },
                            { value: "deep", label: i18n.t("manager.experts.thinking_deep") },
                          ]}
                          value={draft.thinking_level || undefined}
                          placeholder={i18n.t("manager.experts.thinking_none")}
                          isDisabled={submitting}
                          onChange={(value) => update("thinking_level", value as Draft["thinking_level"])}
                        />
                      </FormLayout>
                    </VStack>

                    <VStack gap={3}>
                      <Heading level={3}>{i18n.t("manager.experts.runtime")}</Heading>
                      <FormLayout>
                        <TextInput
                          label={i18n.t("manager.experts.runtime_binding")}
                          value={draft.runtime_binding}
                          onChange={(value) => update("runtime_binding", value)}
                          isDisabled={submitting}
                        />
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
