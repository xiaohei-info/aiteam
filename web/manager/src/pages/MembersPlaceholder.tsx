/** 占位：成员账号管理（owner / enterprise_admin，后续卡接入真实页面）。 */
import { useI18n } from "../i18n/context";

export function MembersPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("manager.nav.members")}</h1>
      <p>{i18n.t("manager.placeholder")}</p>
    </section>
  );
}
