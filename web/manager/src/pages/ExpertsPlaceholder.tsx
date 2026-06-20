/** 占位：招募专家（从模板招募实例，owner / enterprise_admin，后续卡接入）。 */
import { useI18n } from "../i18n/context";

export function ExpertsPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("manager.nav.experts")}</h1>
      <p>{i18n.t("manager.placeholder")}</p>
    </section>
  );
}
