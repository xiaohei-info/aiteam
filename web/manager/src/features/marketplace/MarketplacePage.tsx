/**
 * 人才市场页（AITEAM-290 / GH#404）。
 *
 * Manager 端唯一的人才招募入口：浏览可招募专家模板 + 一键招募为 tenant 实例。
 * 招募无需手填实例标识（slug）—— 由后端自动生成（PRD P03/P04，AITEAM-356）。
 *
 * 注意：原旧 /experts 页的招募/方案段已迁移拆分：
 *   - 人才市场（本入口）：仅需 template_id 即可完成招募；
 *   - 方案目录 /solutions：行业方案「查看详情 + 一键应用」，Manager 不可编辑（PRD B06）。
 *
 * 设计对齐 PRD P03/P04：招募无需手工填写实例标识（slug），服务端按模板自动创建实例；
 * 招募动作为一键按钮，入参仅 template_id。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button } from "@aiteam/shared/ui";
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
          <p className="m-0 text-sm text-text-muted">
            {i18n.t("manager.experts.templates_empty")}
          </p>
        ) : (
          <ul className="m-0 flex flex-col gap-sm p-0" data-testid="template-list">
            {templates.map((t) => (
              <li key={`${t.template_id}@${t.version}`} data-testid="template-row"
                className="flex flex-wrap items-center gap-sm rounded-md border border-gold/15 px-lg py-md">
                <span className="font-medium text-text-primary">{t.display_name}</span>
                <code className="text-xs text-gold-bright">{t.template_id}</code>
                <span className="ml-auto text-xs text-text-muted">{t.persona ?? ""}</span>
                {canWrite && (
                  <Button type="button" size="sm"
                    onClick={() => void runAction(
                      () => api.recruitExpert({ template_id: t.template_id }),
                      "manager.experts.recruit_ok",
                    )}>
                    {i18n.t("manager.experts.recruit")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
