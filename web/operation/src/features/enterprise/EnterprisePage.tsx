import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import type { ApiClient } from "../../api";
import { ProvisionForm } from "./ProvisionForm";
import { BootstrapSecretDisplay } from "./BootstrapSecretDisplay";
import { useEnterpriseApi, type ProvisionOutput, type ResetOutput } from "./useEnterpriseApi";
import { usePlatformProvidersApi } from "../providers/usePlatformProvidersApi";
import type { PlatformModelRef } from "../catalog/types";
import type { EnterpriseModelOption } from "./ProvisionForm";

interface Props {
  apiClient: ApiClient;
}

interface ResetCredentialResult {
  enterpriseId: string;
  output: ResetOutput;
}

export function EnterprisePage({ apiClient }: Props): ReactNode {
  const i18n = useI18n();
  const api = useEnterpriseApi(apiClient);
  const providerApi = usePlatformProvidersApi();
  const [modelOptions, setModelOptions] = useState<EnterpriseModelOption[]>([]);
  const [selectedModelValues, setSelectedModelValues] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [provisionResult, setProvisionResult] = useState<ProvisionOutput | null>(null);
  const [resetResult, setResetResult] = useState<ResetCredentialResult | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionLoading, setProvisionLoading] = useState(false);
  const [resetEnterpriseId, setResetEnterpriseId] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    void providerApi.list().then(async (providers) => {
      const published = providers.filter((provider) => provider.status === "published");
      const groups = await Promise.all(
        published.map(async (provider) => ({ provider, models: await providerApi.models(provider.provider_id) })),
      );
      const options: EnterpriseModelOption[] = [];
      for (const { provider, models } of groups) {
        for (const item of models) {
          if (item.model.status !== "published" || item.rate?.pricing_status !== "known") continue;
          const value = `${provider.provider_id}::${item.model.model_id}`;
          options.push({
            value,
            label: `${provider.display_name} / ${item.model.display_name || item.model.model_id}`,
            ref: {
              provider_id: provider.provider_id,
              provider_version: provider.version,
              model_id: item.model.model_id,
              model_version: item.model.version,
            },
          });
        }
      }
      if (!active) return;
      setModelOptions(options);
      setSelectedModelValues((current) => {
        const valid = new Set(options.map((option) => option.value));
        return current.length ? current.filter((value) => valid.has(value)) : options.map((option) => option.value);
      });
    }).catch(() => {
      if (active) {
        setModelOptions([]);
        setSelectedModelValues([]);
      }
    }).finally(() => {
      if (active) setModelsLoading(false);
    });
    return () => { active = false; };
  }, [providerApi]);

  async function handleProvision(name: string, phone: string, code: string, allowedModelRefs?: PlatformModelRef[] | null): Promise<boolean> {
    setProvisionError(null);
    setProvisionLoading(true);
    try {
      const result = await api.provision({
        enterprise_name: name,
        owner_phone: phone,
        ...(code ? { enterprise_code: code } : {}),
        ...(allowedModelRefs !== undefined ? { allowed_model_refs: allowedModelRefs } : {}),
      });
      setProvisionResult(result);
      return true;
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : i18n.t("operation.enterprise.error"));
      return false;
    } finally {
      setProvisionLoading(false);
    }
  }

  function requestReset(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (resetEnterpriseId.trim()) setConfirmReset(true);
  }

  async function handleReset(): Promise<void> {
    const enterpriseId = resetEnterpriseId.trim();
    if (!enterpriseId) return;
    setResetError(null);
    setResetLoading(true);
    try {
      const output = await api.resetBootstrap(enterpriseId);
      setResetResult({ enterpriseId, output });
      setConfirmReset(false);
    } catch {
      setResetError(i18n.t("operation.enterprise.error"));
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>{i18n.t("operation.nav.enterprises")}</Heading>
      <ProvisionForm
        onSubmit={handleProvision}
        modelOptions={modelOptions}
        selectedModelValues={selectedModelValues}
        onSelectedModelsChange={setSelectedModelValues}
        modelsLoading={modelsLoading}
        loading={provisionLoading}
        error={provisionError}
      />

      {provisionResult && (
        <VStack gap={3}>
          <Banner status="success" title={i18n.t("operation.enterprise.success")} />
          <BootstrapSecretDisplay
            secret={provisionResult.owner_bootstrap_secret}
            enterpriseId={provisionResult.enterprise_id}
            tenantId={provisionResult.tenant_id}
            ownerPhone={provisionResult.owner_phone}
            enterpriseCode={provisionResult.enterprise_code}
            mustReset={provisionResult.must_reset}
            onDismiss={() => setProvisionResult(null)}
          />
        </VStack>
      )}

      <Card>
        <form aria-label={i18n.t("operation.enterprise.reset_title")} onSubmit={requestReset}>
          <VStack gap={4}>
            <Heading level={2}>{i18n.t("operation.enterprise.reset_title")}</Heading>
            <FormLayout>
              <TextInput
                label="enterprise_id"
                value={resetEnterpriseId}
                onChange={setResetEnterpriseId}
                placeholder="企业 ID"
                isRequired
                isDisabled={resetLoading}
              />
            </FormLayout>
            {resetError && <Banner status="error" title={resetError} />}
            <HStack justify="end">
              <Button
                label={resetLoading ? i18n.t("operation.enterprise.reset_submitting") : i18n.t("operation.enterprise.reset_button")}
                type="submit"
                variant="secondary"
                isDisabled={resetLoading || !resetEnterpriseId.trim()}
                isLoading={resetLoading}
              />
            </HStack>
          </VStack>
        </form>
      </Card>

      {resetResult && (
        <VStack gap={3}>
          <Banner status="success" title={i18n.t("operation.enterprise.reset_success")} />
          <BootstrapSecretDisplay
            secret={resetResult.output.owner_bootstrap_secret}
            enterpriseId={resetResult.enterpriseId}
            tenantId={resetResult.output.tenant_id}
            ownerPhone={resetResult.output.owner_phone}
            mustReset={resetResult.output.must_reset}
            onDismiss={() => setResetResult(null)}
          />
        </VStack>
      )}

      <AlertDialog
        isOpen={confirmReset}
        onOpenChange={(isOpen) => { if (!isOpen && !resetLoading) setConfirmReset(false); }}
        title={i18n.t("operation.enterprise.reset_title")}
        description={`将为企业 ${resetEnterpriseId.trim()} 生成新的负责人一次性凭据，旧凭据将立即失效。`}
        cancelLabel="取消"
        actionLabel="确认重置"
        isActionLoading={resetLoading}
        onAction={() => void handleReset()}
      />
    </VStack>
  );
}
