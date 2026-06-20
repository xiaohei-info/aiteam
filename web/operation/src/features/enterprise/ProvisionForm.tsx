/**
 * 企业开通表单（W-O.2）。
 *
 * 输入企业名称 + enterprise_slug，调 POST /api/operation/enterprises/provision。
 */
import { type FormEvent, useState, type ReactNode } from "react";
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
    <form className="enterprise-page__form" onSubmit={handleSubmit}>
      <h2>{i18n.t("operation.enterprise.provision")}</h2>
      <label className="enterprise-page__field">
        <span>{i18n.t("operation.enterprise.name")}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={i18n.t("operation.enterprise.name")}
          disabled={loading}
        />
      </label>
      <label className="enterprise-page__field">
        <span>{i18n.t("operation.enterprise.slug")}</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="enterprise_slug"
          disabled={loading}
        />
      </label>
      {displayError ? (
        <p className="enterprise-page__error">{displayError}</p>
      ) : null}
      <button type="submit" className="enterprise-page__submit" disabled={loading}>
        {loading
          ? i18n.t("operation.enterprise.submitting")
          : i18n.t("operation.enterprise.submit")}
      </button>
    </form>
  );
}
