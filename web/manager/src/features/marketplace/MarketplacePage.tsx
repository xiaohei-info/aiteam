/**
 * 人才市场页（AITEAM-290 / GH#404）。
 *
 * 独立的人才招募入口：可招募专家模板浏览 + 招募为 tenant 实例。
 *
 * 注意：本入口与旧 /experts 页的招募功能平行；/marketplace 聚焦浏览 + 招募流程，
 * 旧 /experts 保留员工生命周期管理（编辑配置 / 查看状态 / 生命周期流转）。
 * 参照旧架构 admin/templates 人才市场功能形态（仅功能参考，不沿用代码风格）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, GlassPanel, Input } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { ExpertTemplate } from "../experts/types";

export function MarketplacePage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useExpertsApi();

  const [templates, setTemplates] = useState<ExpertTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await api.listTemplates());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.experts.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, successKey: string) => {
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(i18n.t(successKey));
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.experts.action_error"));
      }
    },
    [i18n, load],
  );

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("manager.nav.marketplace")}</h1>
      {notice && <p className="m-0 text-sm text-success" role="status">{notice}</p>}
      {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
      {error && <p className="m-0 text-sm text-danger">{error}</p>}
      {loading && <p className="m-0 text-sm text-text-secondary">{i18n.t("manager.experts.loading")}</p>}

      <div className="flex flex-col gap-md">
        <h2 className="m-0 text-base font-semibold text-text-primary">
          {i18n.t("manager.experts.templates_title")}
        </h2>
        {templates.length === 0 ? (
          <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
            {i18n.t("manager.experts.templates_empty")}
          </GlassPanel>
        ) : (
          <GlassPanel className="flex flex-col divide-y divide-gold/10 overflow-hidden rounded-window">
            {templates.map((t) => (
              <div key={`${t.template_id}@${t.version}`} data-testid="template-row"
                className="flex flex-wrap items-center gap-sm px-lg py-md">
                <span className="font-medium text-text-primary">{t.display_name}</span>
                <code className="text-xs text-gold-bright">{t.template_id}</code>
                {canWrite && (
                  <RecruitInline onRecruit={(slug) =>
                    runAction(
                      () => api.recruitExpert({ template_id: t.template_id, employee_slug: slug }),
                      "manager.experts.recruit_ok",
                    )} />
                )}
              </div>
            ))}
          </GlassPanel>
        )}
      </div>
    </section>
  );
}

function RecruitInline({ onRecruit }: { onRecruit: (slug: string) => void }): ReactNode {
  const i18n = useI18n();
  const [slug, setSlug] = useState("");
  return (
    <span className="ml-auto flex items-center gap-sm">
      <Input className="h-8 py-1" aria-label={i18n.t("manager.experts.slug")}
        placeholder={i18n.t("manager.experts.slug")} value={slug}
        onChange={(e) => setSlug(e.target.value)} />
      <Button type="button" size="sm" disabled={!slug.trim()}
        onClick={() => { onRecruit(slug.trim()); setSlug(""); }}>
        {i18n.t("manager.experts.recruit")}
      </Button>
    </span>
  );
}
