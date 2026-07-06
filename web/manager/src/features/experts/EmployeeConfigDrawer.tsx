/**
 * 专家实例详情 / LLM 配置抽屉（AITEAM-683）。
 *
 * 列表行点击后打开：展示并修改 display_name / persona / model_policy / runtime_policy；
 * provider 与 model 先从本 tenant 的 provider-credentials 目录中选 provider，
 * 再从该 provider 的 enabled supported_models 中选 model（V1 不提供手输）。
 *
 * 保存复用 PUT /api/manager/employees/{employee_id}，回传完整载入配置，
 * 仅覆盖被编辑字段，保全 tools/skills/knowledge_refs 等未触达配置。
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Select } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "./useExpertsApi";
import { useProvidersApi } from "../providers/useProvidersApi";
import type { EmployeeConfig } from "./types";
import type { ProviderCredential } from "../providers/types";

export interface EmployeeConfigDrawerProps {
  employeeId: string | null;
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

export function EmployeeConfigDrawer({
  employeeId,
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
  }, [employeeId, experts, i18n]);

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
      const saved = await experts.updateEmployee(employee.employee_id, updated);
      onSaved(saved ?? updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.save_error"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-lg backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <GlassPanel
        className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-md overflow-y-auto rounded-window p-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-md">
          <div>
            <h2 className="m-0 text-lg font-semibold text-text-primary">
              {i18n.t("manager.experts.detail_title")}
            </h2>
            {employee && (
              <code className="text-xs text-gold-bright">{employee.employee_slug}</code>
            )}
          </div>
          <button
            type="button"
            aria-label={i18n.t("manager.common.close")}
            onClick={onClose}
            className="rounded-md px-sm py-xs text-text-muted transition hover:bg-surface hover:text-text-primary"
          >
            ✕
          </button>
        </div>

        {error && (
          <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">
            {error}
          </GlassPanel>
        )}

        {loading || !draft ? (
          <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
            {i18n.t("manager.experts.loading")}
          </GlassPanel>
        ) : (
          <form className="flex flex-col gap-md" onSubmit={handleSubmit}>
            <h3 className="m-0 text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.section_prompt")}
            </h3>
            <Field label={i18n.t("manager.experts.display_name")}>
              <Input
                type="text"
                value={draft.display_name}
                onChange={(e) => update("display_name", e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field label={i18n.t("manager.experts.persona")}>
              <Input
                type="text"
                value={draft.persona}
                onChange={(e) => update("persona", e.target.value)}
                placeholder={i18n.t("manager.experts.persona")}
                disabled={submitting}
              />
            </Field>

            <h3 className="m-0 mt-sm text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.section_model")}
            </h3>
            <Field label={i18n.t("manager.experts.provider_ref")}>
              <Select
                value={draft.provider_ref}
                onChange={(e) => {
                  const next = (e.target as HTMLSelectElement).value;
                  setDraft((d) => {
                    if (!d) return d;
                    // 切换 provider 时，若当前 model 不在新 provider 目录内则清空。
                    const newProvider = providers.find((p) => p.provider_ref === next) ?? null;
                    const models = (newProvider?.supported_models ?? []).filter((m) => m.enabled !== false);
                    const model = models.some((m) => m.model === d.model) ? d.model : "";
                    return { ...d, provider_ref: next, model };
                  });
                }}
                disabled={submitting || providersLoading}
                data-testid="provider-select"
              >
                <option value="">{i18n.t("manager.experts.provider_pick")}</option>
                {providers.map((p) => (
                  <option key={p.credential_id} value={p.provider_ref}>
                    {p.display_name || p.provider_ref}
                  </option>
                ))}
              </Select>
            </Field>

            {draft.model && !draft.provider_ref && (
              <p className="m-0 text-xs text-warning">{i18n.t("manager.experts.unverified_model_warn")}</p>
            )}

            <Field label={i18n.t("manager.experts.model")}>
              <Select
                value={availableModels.some((m) => m.model === draft.model) ? draft.model : ""}
                onChange={(e) => update("model", (e.target as HTMLSelectElement).value)}
                disabled={submitting || !draft.provider_ref}
                data-testid="model-select"
              >
                <option value="">
                  {draft.provider_ref
                    ? availableModels.length === 0
                      ? i18n.t("manager.experts.no_models_for_provider")
                      : i18n.t("manager.experts.model_pick")
                    : i18n.t("manager.experts.provider_first")}
                </option>
                {availableModels.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.display_name || m.model}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={i18n.t("manager.experts.thinking_level")}>
              <Select
                value={draft.thinking_level}
                onChange={(e) =>
                  update("thinking_level", (e.target as HTMLSelectElement).value as Draft["thinking_level"])
                }
                disabled={submitting}
              >
                <option value="">{i18n.t("manager.experts.thinking_none")}</option>
                <option value="basic">{i18n.t("manager.experts.thinking_basic")}</option>
                <option value="deep">{i18n.t("manager.experts.thinking_deep")}</option>
              </Select>
            </Field>

            <h3 className="m-0 mt-sm text-xs font-semibold text-text-secondary">
              {i18n.t("manager.experts.runtime")}
            </h3>
            <Field label={i18n.t("manager.experts.runtime_binding")}>
              <Input
                type="text"
                value={draft.runtime_binding}
                onChange={(e) => update("runtime_binding", e.target.value)}
                disabled={submitting}
              />
            </Field>
            <Field label={i18n.t("manager.experts.timeout_seconds")}>
              <Input
                type="number"
                min="1"
                value={draft.timeout_seconds}
                onChange={(e) => update("timeout_seconds", e.target.value)}
                disabled={submitting}
              />
            </Field>

            <div className="mt-sm flex justify-end gap-sm">
              <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
                {i18n.t("manager.experts.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? i18n.t("manager.experts.saving") : i18n.t("manager.experts.save")}
              </Button>
            </div>
          </form>
        )}
      </GlassPanel>
    </div>
  );
}
