/**
 * 人才市场页（AITEAM-290 / GH#404）。
 *
 * Manager 端唯一的人才招募入口：浏览可招募专家模板 + 设置部门后招募为 tenant 实例。
 * 招募无需手填实例标识（slug）—— 由后端自动生成（PRD P03/P04，AITEAM-356）。
 *
 * 设计对齐 PRD P03/P04：招募无需手工填写实例标识（slug），服务端按模板自动创建实例；
 * 部门设置允许明确选择“未设置”，并沿用所选部门授权范围。
 *
 * 招募成功后提示可前往专家实例配置 Provider / LLM（AITEAM-683）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, DigitalEmployeeAvatar, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { DepartmentSelector } from "../experts/DepartmentSelector";
import { useExpertsApi } from "../experts/useExpertsApi";
import type { Department, ExpertTemplate } from "../experts/types";
import "../experts/experts.css";

type MarketplaceFilter = "all" | "available" | "recruited";

function modelLabel(template: ExpertTemplate): string {
  return template.platform_model_ref?.model_id || "模型待配置";
}

function MarketplaceAvatar({ name, src }: { name: string; src?: string | null }): ReactNode {
  return <DigitalEmployeeAvatar name={name} src={src} size={54} />;
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
  const [recruitFor, setRecruitFor] = useState<ExpertTemplate | null>(null);

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
    async (fn: () => Promise<unknown>, successKey: string): Promise<boolean> => {
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(i18n.t(successKey));
        await load();
        return true;
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.experts.action_error"));
        return false;
      }
    },
    [i18n, load],
  );

  async function recruitWithDepartments(departmentIds: string[]): Promise<void> {
    if (!recruitFor) return;
    const succeeded = await runAction(
      () => api.recruitExpert({ template_id: recruitFor.template_id, department_ids: departmentIds }),
      "manager.experts.recruit_ok",
    );
    if (succeeded) setRecruitFor(null);
  }

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
                        clickAction={() => {
                          if (api.listDepartments) {
                            setRecruitFor(t);
                            return;
                          }
                          // Older injected clients do not expose department lookup;
                          // preserve their original direct-recruit contract.
                          void runAction(
                            () => api.recruitExpert({ template_id: t.template_id }),
                            "manager.experts.recruit_ok",
                          );
                        }}
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

      {recruitFor && api.listDepartments && (
        <RecruitDepartmentDialog
          template={recruitFor}
          listDepartments={api.listDepartments}
          onClose={() => setRecruitFor(null)}
          onSubmit={recruitWithDepartments}
        />
      )}
    </VStack>
  );
}

function RecruitDepartmentDialog({
  template,
  listDepartments,
  onClose,
  onSubmit,
}: {
  template: ExpertTemplate;
  listDepartments: () => Promise<Department[]>;
  onClose: () => void;
  onSubmit: (departmentIds: string[]) => Promise<void>;
}): ReactNode {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listDepartments()
      .then((items) => { if (active) setDepartments(items); })
      .catch((err) => { if (active) setError(err instanceof Error ? err.message : "部门列表加载失败"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [listDepartments]);

  async function submit(): Promise<void> {
    setWorking(true);
    setError(null);
    try {
      await onSubmit(departmentIds);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "招募失败");
    } finally {
      setWorking(false);
    }
  }

  return (
    <Dialog
      isOpen
      purpose="form"
      width={560}
      aria-label={`招募${template.display_name}`}
      onOpenChange={(open) => { if (!open && !working) onClose(); }}
    >
      <VStack gap={4}>
        <DialogHeader
          title={`为${template.display_name}设置部门`}
          onOpenChange={(open) => { if (!open && !working) onClose(); }}
        />
        <Text color="secondary">请选择该专家所属部门；不归属部门时请选择“未设置”。所选部门也会沿用为该专家的部门授权范围。</Text>
        {error && <Banner status="error" title={error} />}
        <DepartmentSelector
          departments={departments}
          value={departmentIds}
          onChange={setDepartmentIds}
          label="所属部门"
          isDisabled={working}
          isLoading={loading}
          dataTestId="recruit-departments-selector"
        />
        <div>
          <Button label="取消" variant="secondary" onClick={onClose} isDisabled={working} />
          <Button label="招募" variant="primary" onClick={() => void submit()} isLoading={working} isDisabled={working || loading} />
        </div>
      </VStack>
    </Dialog>
  );
}
