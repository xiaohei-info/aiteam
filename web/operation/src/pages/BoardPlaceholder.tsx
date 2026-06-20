/** 占位：跨企业治理看板（W-O.4 接入真实 rollup）。 */
import { useI18n } from "../i18n/context";

export function BoardPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="placeholder-page">
      <h1>{i18n.t("operation.nav.board")}</h1>
      <p>{i18n.t("operation.placeholder")}</p>
    </section>
  );
}
