/** 占位：成员级授权（专家·方案的成员可见性授权，owner / enterprise_admin，后续卡接入）。 */
import { useI18n } from "../i18n/context";

export function GrantsPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("manager.nav.grants")}</h1>
      <p>{i18n.t("manager.placeholder")}</p>
    </section>
  );
}
