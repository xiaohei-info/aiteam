/** 占位：企业治理（脱敏计量·审计汇总，owner / enterprise_admin / finance_admin，后续卡接入）。 */
import { useI18n } from "../i18n/context";

export function GovernancePlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("manager.nav.governance")}</h1>
      <p>{i18n.t("manager.placeholder")}</p>
    </section>
  );
}
