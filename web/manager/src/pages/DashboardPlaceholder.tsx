/** 占位：企业概览首页（W-M 只给壳，真实内容由后续卡接入）。 */
import { useI18n } from "../i18n/context";

export function DashboardPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("manager.nav.dashboard")}</h1>
      <p>{i18n.t("manager.placeholder")}</p>
    </section>
  );
}
