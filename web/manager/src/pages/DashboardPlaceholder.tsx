/** 企业概览首页（黑金玻璃；真实概览内容由后续卡接入）。 */
import { GlassPanel } from "@aiteam/shared/ui";
import { useI18n } from "../i18n/context";

export function DashboardPlaceholder(): React.ReactNode {
  const i18n = useI18n();
  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">
        {i18n.t("manager.nav.dashboard")}
      </h1>
      <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
        {i18n.t("manager.placeholder")}
      </GlassPanel>
    </section>
  );
}
