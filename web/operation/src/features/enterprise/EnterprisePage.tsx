import { useState, type FormEvent, type ReactNode } from "react";
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
  const [provisionResult, setProvisionResult] = useState<ProvisionOutput | null>(null);
  const [resetResult, setResetResult] = useState<ResetCredentialResult | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionLoading, setProvisionLoading] = useState(false);
  const [resetEnterpriseId, setResetEnterpriseId] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  async function handleProvision(name: string, phone: string, code: string): Promise<boolean> {
    setProvisionError(null);
    setProvisionLoading(true);
    try {
      const result = await api.provision({
        enterprise_name: name,
        owner_phone: phone,
        ...(code ? { enterprise_code: code } : {}),
      });
      setProvisionResult(result);
      return true;
    } catch {
      setProvisionError(i18n.t("operation.enterprise.error"));
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
      <ProvisionForm onSubmit={handleProvision} loading={provisionLoading} error={provisionError} />

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
