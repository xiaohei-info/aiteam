import { useEffect, useState, type ReactNode } from "react";
import { isSelectablePlatformModel } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { useI18n } from "../../i18n/context";
import type { ApiClient } from "../../api";
import { ProvisionForm } from "./ProvisionForm";
import { BootstrapSecretDisplay } from "./BootstrapSecretDisplay";
import { useEnterpriseApi, type ProvisionOutput } from "./useEnterpriseApi";
import { usePlatformProvidersApi } from "../providers/usePlatformProvidersApi";
import type { PlatformModelRef } from "../catalog/types";
import type { EnterpriseModelOption } from "./ProvisionForm";

interface Props {
  apiClient: ApiClient;
}

export function EnterprisePage({ apiClient }: Props): ReactNode {
  const i18n = useI18n();
  const api = useEnterpriseApi(apiClient);
  const providerApi = usePlatformProvidersApi();
  const [modelOptions, setModelOptions] = useState<EnterpriseModelOption[]>([]);
  const [selectedModelValues, setSelectedModelValues] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [provisionResult, setProvisionResult] = useState<ProvisionOutput | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionLoading, setProvisionLoading] = useState(false);

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
          if (!isSelectablePlatformModel(item)) continue;
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

  async function handleProvision(name: string, phone: string, code: string, allowedModelRefs?: PlatformModelRef[] | null, profile?: { industry?: string; tags?: string[] }): Promise<boolean> {
    setProvisionError(null);
    setProvisionLoading(true);
    try {
      const result = await api.provision({
        enterprise_name: name,
        owner_phone: phone,
        ...(code ? { enterprise_code: code } : {}),
        ...(profile?.industry ? { industry: profile.industry } : {}),
        ...(profile?.tags?.length ? { tags: profile.tags } : {}),
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

    </VStack>
  );
}
