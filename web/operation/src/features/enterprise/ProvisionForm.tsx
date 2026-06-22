/**
 * 企业开通表单（W-O.2）。
 *
 * 输入企业名称 + 负责人手机号（必填）+ 企业代码（可选），
 * 调 POST /api/operation/enterprises。
 */
import { type FormEvent, useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";

interface Props {
  onSubmit: (name: string, phone: string, code: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function ProvisionForm({ onSubmit, loading, error }: Props): ReactNode {
  const i18n = useI18n();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setValidationError(null);
    if (!name.trim()) {
      setValidationError(i18n.t("operation.enterprise.name_required"));
      return;
    }
    if (!phone.trim()) {
      setValidationError(i18n.t("operation.enterprise.phone_required"));
      return;
    }
    await onSubmit(name.trim(), phone.trim(), code.trim());
  }

  const displayError = validationError ?? error;

  return (
    <form onSubmit={handleSubmit}>
      <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("operation.enterprise.provision")}
        </h2>
        <Field label={i18n.t("operation.enterprise.name")}>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={i18n.t("operation.enterprise.name")}
            disabled={loading}
          />
        </Field>
        <Field label={i18n.t("operation.enterprise.phone")}>
          <Input
            type="text"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="负责人手机号"
            disabled={loading}
          />
        </Field>
        <Field label={i18n.t("operation.enterprise.code")}>
          <Input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="enterprise_code（可选）"
            disabled={loading}
          />
        </Field>
        {displayError ? (
          <p className="m-0 text-sm text-danger">{displayError}</p>
        ) : null}
        <Button type="submit" disabled={loading} className="self-start">
          {loading
            ? i18n.t("operation.enterprise.submitting")
            : i18n.t("operation.enterprise.submit")}
        </Button>
      </GlassPanel>
    </form>
  );
}
