/**
 * 企业开通页主组件（W-O.2）。
 *
 * F01: ProvisionForm → POST /api/operation/enterprises → 展示 owner_bootstrap_secret
 * F02: enterprise_id → POST /enterprises/{id}/owner-bootstrap/reset → 展示新凭据
 */
import { useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import type { ApiClient } from "../../api";
import { ProvisionForm } from "./ProvisionForm";
import { BootstrapSecretDisplay } from "./BootstrapSecretDisplay";
import { useEnterpriseApi, type ProvisionOutput, type ResetOutput } from "./useEnterpriseApi";

interface Props {
  apiClient: ApiClient;
}

export function EnterprisePage({ apiClient }: Props): ReactNode {
  const i18n = useI18n();
  const api = useEnterpriseApi(apiClient);

  const [provisionResult, setProvisionResult] = useState<ProvisionOutput | null>(null);
  const [resetResult, setResetResult] = useState<ResetOutput | null>(null);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionLoading, setProvisionLoading] = useState(false);

  const [resetEnterpriseId, setResetEnterpriseId] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetLoading, setResetLoading] = useState(false);

  async function handleProvision(name: string, phone: string, code: string): Promise<void> {
    setProvisionError(null);
    setProvisionLoading(true);
    try {
      const result = await api.provision({
        enterprise_name: name,
        owner_phone: phone,
        ...(code ? { enterprise_code: code } : {}),
      });
      setProvisionResult(result);
    } catch {
      setProvisionError(i18n.t("operation.enterprise.error"));
    } finally {
      setProvisionLoading(false);
    }
  }

  async function handleReset(): Promise<void> {
    if (!resetEnterpriseId.trim()) return;
    setResetError(null);
    setResetLoading(true);
    try {
      const result = await api.resetBootstrap(resetEnterpriseId.trim());
      setResetResult(result);
    } catch {
      setResetError(i18n.t("operation.enterprise.error"));
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">
        {i18n.t("operation.nav.enterprises")}
      </h1>

      <ProvisionForm
        onSubmit={handleProvision}
        loading={provisionLoading}
        error={provisionError}
      />

      {provisionResult ? (
        <div className="flex flex-col gap-md">
          <p className="m-0 text-sm text-success">
            {i18n.t("operation.enterprise.success")}
          </p>
          <BootstrapSecretDisplay
            secret={provisionResult.owner_bootstrap_secret}
            enterpriseId={provisionResult.enterprise_id}
            tenantId={provisionResult.tenant_id}
            ownerPhone={provisionResult.owner_phone}
            enterpriseCode={provisionResult.enterprise_code}
            mustReset={provisionResult.must_reset}
          />
        </div>
      ) : null}

      <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("operation.enterprise.reset_title")}
        </h2>
        <Field label="enterprise_id">
          <Input
            type="text"
            value={resetEnterpriseId}
            onChange={(e) => setResetEnterpriseId(e.target.value)}
            placeholder="企业 ID"
            disabled={resetLoading}
          />
        </Field>
        {resetError ? (
          <p className="m-0 text-sm text-danger">{resetError}</p>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          onClick={handleReset}
          disabled={resetLoading || !resetEnterpriseId.trim()}
          className="self-start"
        >
          {resetLoading
            ? i18n.t("operation.enterprise.reset_submitting")
            : i18n.t("operation.enterprise.reset_button")}
        </Button>
      </GlassPanel>

      {resetResult ? (
        <div className="flex flex-col gap-md">
          <p className="m-0 text-sm text-success">
            {i18n.t("operation.enterprise.reset_success")}
          </p>
          <BootstrapSecretDisplay
            secret={resetResult.owner_bootstrap_secret}
            enterpriseId={resetEnterpriseId.trim()}
            tenantId={resetResult.tenant_id}
            ownerPhone={resetResult.owner_phone}
            mustReset={resetResult.must_reset}
          />
        </div>
      ) : null}
    </section>
  );
}
