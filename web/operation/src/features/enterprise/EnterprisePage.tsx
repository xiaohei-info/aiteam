/**
 * 企业开通页主组件（W-O.2）。
 *
 * 承载两种操作：
 * - F01 开通企业：ProvisionForm → POST /api/operation/enterprises/provision → 展示 bootstrap_secret
 * - F02 负责人凭据重置：enterprise_id 输入 → POST /api/operation/enterprises/{id}/owner/bootstrap/reset → 展示新 secret
 *
 * 红线：bootstrap_secret 仅本次展示，不缓存不重发，不用 localStorage/sessionStorage。
 */
import { useState, type ReactNode } from "react";
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

  async function handleProvision(name: string, slug: string): Promise<void> {
    setProvisionError(null);
    setProvisionLoading(true);
    try {
      const result = await api.provision({
        enterprise_name: name,
        enterprise_slug: slug,
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
    <div className="enterprise-page">
      <ProvisionForm
        onSubmit={handleProvision}
        loading={provisionLoading}
        error={provisionError}
      />

      {provisionResult ? (
        <>
          <p className="enterprise-page__success-msg">
            {i18n.t("operation.enterprise.success")}
          </p>
          <BootstrapSecretDisplay
            secret={provisionResult.bootstrap_secret}
            enterpriseId={provisionResult.enterprise_id}
          />
        </>
      ) : null}

      <section className="enterprise-page__reset">
        <h2>{i18n.t("operation.enterprise.reset_title")}</h2>
        <label className="enterprise-page__field">
          <span>enterprise_id</span>
          <input
            type="text"
            value={resetEnterpriseId}
            onChange={(e) => setResetEnterpriseId(e.target.value)}
            placeholder="企业 ID"
            disabled={resetLoading}
          />
        </label>
        {resetError ? (
          <p className="enterprise-page__error">{resetError}</p>
        ) : null}
        <button
          type="button"
          className="enterprise-page__submit"
          onClick={handleReset}
          disabled={resetLoading || !resetEnterpriseId.trim()}
        >
          {resetLoading
            ? i18n.t("operation.enterprise.reset_submitting")
            : i18n.t("operation.enterprise.reset_button")}
        </button>
      </section>

      {resetResult ? (
        <>
          <p className="enterprise-page__success-msg">
            {i18n.t("operation.enterprise.reset_success")}
          </p>
          <BootstrapSecretDisplay
            secret={resetResult.bootstrap_secret}
            enterpriseId={resetEnterpriseId.trim()}
          />
        </>
      ) : null}
    </div>
  );
}
