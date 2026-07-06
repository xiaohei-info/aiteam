/** P03 人才市场页 — 专家浏览/招募 + 发布需求/上架智能体入口（demo 对齐：AI-Team-Demo.html:1265-1266）。 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { Button, GlassPanel, Input } from "@aiteam/shared/ui";
import { useApp } from "../../lib/app-context";
import { listTemplates, recruit } from "./useMarketplaceApi";
import type { MarketTemplate } from "./types";

export function MarketplacePage() {
  const { client, i18n } = useApp();
  const [templates, setTemplates] = useState<MarketTemplate[]>([]);
  const [categories, setCategories] = useState<string[]>(["全部"]);
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState("全部");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [recruiting, setRecruiting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const list = await listTemplates(client, { keyword: keyword || undefined, category: category !== "全部" ? category : undefined });
      setTemplates(list);
      // 分类来自后端真实模板（Manager 端招募到的专家分类），不再写死。
      // 仅在全量视图（无分类、无关键字过滤）刷新分类栏，保证选中某分类后栏位稳定。
      if (category === "全部" && !keyword) {
        const cats = Array.from(new Set(list.map((t) => t.category).filter(Boolean)));
        setCategories(["全部", ...cats]);
      }
    } catch (err) { setError(err instanceof ApiError ? err.message : i18n.t("agent.workspace.load_error")); }
    finally { setLoading(false); }
  }, [client, i18n, keyword, category]);

  useEffect(() => { void load(); }, [load]);

  const handleRecruit = useCallback(async (templateId: string) => {
    setRecruiting(templateId); setActionError(null);
    try { await recruit(client, templateId); await load(); } catch (errRecruit) { setActionError(errRecruit instanceof ApiError ? errRecruit.message : "招募失败"); } finally { setRecruiting(null); }
  }, [client, load]);

  const handlePublishRequirement = useCallback(() => {
    setActionError(null);
    setActionInfo(i18n.t("agent.marketplace.publish_requirement_hint"));
  }, [i18n]);

  const handleListMyAgent = useCallback(() => {
    setActionError(null);
    setActionInfo(i18n.t("agent.marketplace.list_my_agent_hint"));
  }, [i18n]);

  return (
    <section className="flex flex-col gap-md">
      <div className="flex items-start justify-between gap-sm">
        <h1 className="m-0 text-xl font-bold text-text-primary">人才市场</h1>
        <div className="flex gap-sm">
          <Button variant="ghost" onClick={() => void handlePublishRequirement()}>{i18n.t("agent.marketplace.publish_requirement")}</Button>
          <Button variant="metal" onClick={() => void handleListMyAgent()}>{i18n.t("agent.marketplace.list_my_agent")}</Button>
        </div>
      </div>

      <div className="flex gap-sm">
        <Input placeholder="搜索专家名称、技能…" value={keyword} onChange={(e) => setKeyword((e.target as HTMLInputElement).value)} className="flex-1" />
        <Button variant="ghost" onClick={() => void load()}>搜索</Button>
      </div>

      <div className="flex flex-wrap gap-xs">
        {categories.map((c) => (
          <Button key={c} variant={category === c ? "metal" : "ghost"} size="sm" onClick={() => setCategory(c)}>{c}</Button>
        ))}
      </div>

      {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
      {actionInfo && <p className="m-0 rounded-md border border-info/30 bg-info/10 px-sm py-sm text-sm text-info">{actionInfo}</p>}

      {loading ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel> :
        error ? <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger">{error}</GlassPanel> :
        templates.length === 0 ? <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无可招募专家</GlassPanel> :
        <div className="grid grid-cols-3 gap-md">
          {templates.map((t) => (
            <GlassPanel key={t.template_id} className="rounded-window p-md">
              <div className="flex items-start justify-between">
                <div><p className="m-0 text-sm font-bold text-text-primary">{t.display_name}</p><p className="m-0 mt-xs text-xs text-text-muted">{t.category} · {t.model_name} · {t.skills_count} Skills</p></div>
              </div>
              {t.tags.length > 0 && <div className="mt-xs flex flex-wrap gap-xs">{t.tags.slice(0, 3).map((tag) => <span key={tag} className="rounded-pill bg-gold/10 px-sm py-0.5 text-xs text-gold">{tag}</span>)}</div>}
              <p className="m-0 mt-xs text-xs text-text-muted">已有 {t.recruit_count} 家企业招募</p>
              <div className="mt-sm">
                {t.is_recruited ? <span className="text-sm text-success">✓ 已招募</span> :
                  <Button variant="metal" size="sm" disabled={recruiting === t.template_id} onClick={() => void handleRecruit(t.template_id)}>
                    {recruiting === t.template_id ? "招募中…" : "招募"}
                  </Button>}
              </div>
            </GlassPanel>
          ))}
        </div>}
    </section>
  );
}
