/**
 * 企业开通表单（W-O.2）。
 *
 * 输入企业名称 + enterprise_slug，调 POST /api/operation/enterprises/provision。
 * 黑金玻璃质感，复用 shared 组件（GlassPanel/Field/Input/Button）。
 */
import { type FormEvent, useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";

interface Props {
  onSubmit: (name: string, slug: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}

export function ProvisionForm({
  onSubmit,
  loading,
  error,
}: Props): ReactNode {
  const i18n = useI18n();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setValidationError(null);

    if (!name.trim()) {
      setValidationError(i18n.t("operation.enterprise.name_required"));
      return;
    }
    if (!slug.trim()) {
      setValidationError(i18n.t("operation.enterprise.slug_required"));
      return;
    }

    await onSubmit(name.trim(), slug.trim());
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
        <Field label={i18n.t("operation.enterprise.slug")}>
          <Input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="enterprise_slug"
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
