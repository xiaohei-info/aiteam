/**
 * 人才市场页（AITEAM-290 / GH#404）。
 *
 * Manager 端唯一的人才招募入口：浏览可招募专家模板 + 一键招募为 tenant 实例。
 * 招募无需手填实例标识（slug）—— 由后端自动生成（PRD P03/P04，AITEAM-356）。
 *
 * 设计对齐 PRD P03/P04：招募无需手工填写实例标识（slug），服务端按模板自动创建实例；
 * 招募动作为一键按钮，入参仅 template_id。
 *
 * 招募成功后提示可前往专家实例配置 Provider / LLM（AITEAM-683）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { ExpertTemplate } from "../experts/types";
import "../experts/experts.css";

type MarketplaceFilter = "all" | "available" | "recruited";

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (value.trim().slice(0, 2) || "AI").toUpperCase();
}

function modelLabel(template: ExpertTemplate): string {
  return template.platform_model_ref?.model_id || "模型待配置";
}

function MarketplaceAvatar({ name, src }: { name: string; src?: string | null }): ReactNode {
  const candidate = src?.trim();
  const imageSrc = candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : undefined;
  return (
    <div data-ui="expert-card-avatar" aria-hidden="true">
      {imageSrc ? <img src={imageSrc} alt="" loading="lazy" referrerPolicy="no-referrer" /> : initials(name)}
    </div>
  );
}

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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketplaceFilter>("all");

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

  const filteredTemplates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return templates.filter((template) => {
      const matchesFilter = filter === "all"
        || (filter === "available" && !template.is_recruited)
        || (filter === "recruited" && template.is_recruited);
      const searchable = [template.display_name, template.category, template.description, template.persona, modelLabel(template), ...(template.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase();
      return matchesFilter && (!normalized || searchable.includes(normalized));
    });
  }, [filter, query, templates]);

  const summaryStats = [
    { key: "all" as const, label: "全部专家", value: templates.length },
    { key: "available" as const, label: "可招募", value: templates.filter((template) => !template.is_recruited).length },
    { key: "recruited" as const, label: "已招募", value: templates.filter((template) => template.is_recruited).length },
  ];

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
    <VStack as="section" gap={6} data-ui="expert-page">
      <div data-ui="expert-page-header">
        <VStack gap={1}>
          <Heading level={1}>{i18n.t("manager.nav.marketplace")}</Heading>
          <Text color="secondary">从平台人才库挑选成熟能力，快速加入企业团队。</Text>
        </VStack>
      </div>

      <div data-ui="expert-summary" aria-label="人才市场概览">
        {summaryStats.map((stat) => (
          <button
            key={stat.key}
            type="button"
            data-ui="expert-summary-item"
            data-active={filter === stat.key ? "true" : "false"}
            aria-pressed={filter === stat.key}
            onClick={() => setFilter(stat.key)}
          >
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </button>
        ))}
      </div>

      <div data-ui="expert-toolbar">
        <TextInput
          label="搜索专家"
          isLabelHidden
          value={query}
          onChange={setQuery}
          placeholder="搜索专家名称、岗位或模型"
          startIcon="search"
          width="100%"
        />
        <div data-ui="expert-filter-tabs" role="group" aria-label="人才市场筛选">
          {summaryStats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              data-active={filter === stat.key ? "true" : "false"}
              aria-pressed={filter === stat.key}
              onClick={() => setFilter(stat.key)}
            >
              {stat.label}
            </button>
          ))}
        </div>
      </div>

      {notice && (
        <Banner
          status="success"
          title={notice}
          endContent={
            <Button
              label={i18n.t("manager.experts.edit_config")}
              href="/experts"
              variant="ghost"
              size="sm"
              data-testid="goto-experts"
            />
          }
        />
      )}
      {actionError && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      <VStack gap={3}>
        <Heading level={2}>
          {i18n.t("manager.experts.templates_title")}
        </Heading>
        {loading ? (
          <VStack gap={2} role="status" aria-label={i18n.t("manager.experts.loading")}>
            <Text color="secondary">{i18n.t("manager.experts.loading")}</Text>
            <Skeleton height={96} />
          </VStack>
        ) : templates.length === 0 ? (
          <EmptyState
            headingLevel={3}
            title={i18n.t("manager.experts.templates_empty")}
          />
        ) : (
          <div data-ui="expert-grid" data-testid="template-list">
            {filteredTemplates.map((t) => (
              <article
                key={`${t.template_id}@${t.version}`}
                data-ui="expert-card"
                role="article"
                aria-label={t.display_name}
                data-testid="template-row"
              >
                <div data-ui="expert-card-hero">
                  <MarketplaceAvatar name={t.display_name} src={t.avatar_url} />
                  <div data-ui="expert-card-identity">
                    <Heading level={3}>{t.display_name}</Heading>
                    <Text type="supporting">{t.category || "数字员工"} · v{t.version}</Text>
                  </div>
                  <span data-ui="expert-card-status" data-recruited={t.is_recruited ? "true" : "false"}>
                    {t.is_recruited ? "已招募" : "可招募"}
                  </span>
                </div>

                <p data-ui="expert-card-description">
                  {t.description || t.persona || "将成熟经验封装为可复用的企业数字员工。"}
                </p>

                <div data-ui="expert-card-meta">
                  <span><strong>模型</strong>{modelLabel(t)}</span>
                  <span><strong>技能</strong>{t.platform_skill_refs?.length || t.skill_ids?.length || 0} 项</span>
                  <span><strong>版本</strong>v{t.version}</span>
                </div>

                <div data-ui="expert-card-footer">
                  {canWrite && (
                    t.is_recruited ? (
                      <Button
                        label={i18n.t("manager.experts.recruited")}
                        size="sm"
                        variant="secondary"
                        isDisabled
                      />
                    ) : (
                      <Button
                        label={i18n.t("manager.experts.recruit")}
                        size="sm"
                        variant="primary"
                        clickAction={() => runAction(
                          () => api.recruitExpert({ template_id: t.template_id }),
                          "manager.experts.recruit_ok",
                        )}
                      />
                    )
                  )}
                </div>
              </article>
            ))}
            {!filteredTemplates.length && (
              <div data-ui="expert-grid-empty">
                <EmptyState headingLevel={3} title="没有匹配的专家" description="换个关键词或切换筛选条件再试试。" isCompact />
              </div>
            )}
          </div>
        )}
      </VStack>
    </VStack>
  );
}
