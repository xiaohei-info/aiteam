/** 占位：目录治理（W-O.3 接入真实列表/发布/下架）。 */
import { useI18n } from "../i18n/context";

export function CatalogPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("operation.nav.catalog")}</h1>
      <p>{i18n.t("operation.placeholder")}</p>
    </section>
  );
}
