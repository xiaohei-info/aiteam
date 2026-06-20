/** 占位：企业开通（W-O.2 接入真实表单）。 */
import { useI18n } from "../i18n/context";

export function EnterprisePlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("operation.nav.enterprises")}</h1>
      <p>{i18n.t("operation.placeholder")}</p>
    </section>
  );
}
