/**
 * 目录项详情页（F03）。
 *
 * 对齐后端 GET /api/operation/catalog/{catalog_type}/{template_id}
 * 并对管理员暴露 PATCH 部分更新。
 *
 * 详情显示 payload 顶层字段:
 *   - 专家: persona / recommended_config.{prompt_pack,
 *     default_model_ref, default_binding, default_skill_bundle,
 *     default_skills, knowledge_bindings, memory_config, role_name,
 *     category_code}
 *   - 行业方案: expert_template_ids / knowledge_refs / skill_refs /
 *     planner_prompt / subtask_prompt / aggregate_prompt /
 *     default_grants / tags / default_kb_blueprint / default_skill_bundle
 */
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { ApiError, PlatformRole, hasRole } from "@aiteam/shared";
import {
  Button,
  Field,
  GlassPanel,
  Input,
  Select,
} from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import { useSession } from "../../auth/session";
import { useCatalogApi } from "./useCatalogApi";
import {
  visibilityLabel,
  labelToVisibleScope,
} from "./types";
import type {
  CatalogItem,
  CatalogItemType,
  ExpertRecommendedConfig,
  ModelRef,
} from "./types";

const textareaCls =
  "min-h-[80px] w-full rounded-md border border-gold/20 bg-surface px-md py-sm " +
  "text-sm text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold";

const inputCls =
  "w-full rounded-md border border-gold/20 bg-surface px-md py-sm text-sm " +
  "text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold";

function safeJson(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseList(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function CatalogDetailPage(): ReactNode {
  const { catalog_type, template_id } = useParams<{
    catalog_type: string;
    template_id: string;
  }>();
  const i18n = useI18n();
  const { session } = useSession();
  const api = useCatalogApi();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR);

  const [item, setItem] = useState<CatalogItem | null>(null);
  const [draft, setDraft] = useState<CatalogItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!catalog_type || !template_id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get(catalog_type as CatalogItemType, template_id)
      .then((data) => {
        if (cancelled) return;
        setItem(data);
        setDraft(data ? { ...data } : null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "加载失败");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, catalog_type, template_id]);

  const doVisibility = useCallback(
    async (next: "public" | "enterprise" | "hidden") => {
      if (!catalog_type || !template_id) return;
      setError(null);
      try {
        const updated = await api.setVisibility(
          catalog_type as CatalogItemType,
          template_id,
          labelToVisibleScope(next),
        );
        if (updated) {
          setItem(updated);
          setDraft({ ...updated });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "操作失败");
      }
    },
    [api, catalog_type, template_id],
  );

  const handleSave = useCallback(async () => {
    if (!catalog_type || !template_id || !draft) return;
    setSaving(true);
    setEditError(null);
    try {
      const isExpert = draft.catalog_type === "expert_template";
      const changes: Record<string, unknown> = {};
      changes.display_name = draft.display_name;
      if (isExpert) {
        changes.persona = draft.persona ?? "";
        if (draft.recommended_config) {
          changes.recommended_config = draft.recommended_config;
        }
      } else {
        if (draft.expert_template_ids) changes.expert_template_ids = draft.expert_template_ids;
        if (draft.knowledge_refs) changes.knowledge_refs = draft.knowledge_refs;
        if (draft.skill_refs) changes.skill_refs = draft.skill_refs;
        if (draft.planner_prompt) changes.planner_prompt = draft.planner_prompt;
        if (draft.subtask_prompt) changes.subtask_prompt = draft.subtask_prompt;
        if (draft.aggregate_prompt) changes.aggregate_prompt = draft.aggregate_prompt;
        if (draft.default_grants) changes.default_grants = draft.default_grants;
        if (draft.tags) changes.tags = draft.tags;
      }
      const updated = await api.updateEntry(
        catalog_type as CatalogItemType,
        template_id,
        changes,
      );
      if (updated) {
        setItem(updated);
        setDraft({ ...updated });
      }
      setEditing(false);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }, [api, catalog_type, template_id, draft]);

  if (loading) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
          加载中…
        </GlassPanel>
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">
          {error}
        </GlassPanel>
      </section>
    );
  }

  if (!item || !draft) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("operation.catalog.notFound")}
        </GlassPanel>
      </section>
    );
  }

  const vLabel = visibilityLabel(item.visible_scope);
  const isExpert = item.catalog_type === "expert_template";
  const recommended = (draft.recommended_config ?? {}) as ExpertRecommendedConfig;
  const modelRef: ModelRef = recommended?.default_model_ref ?? {};
  const skillsText = (recommended?.default_skills ?? []).join("\n");
  const kbText = (recommended?.knowledge_bindings ?? []).join("\n");
  const kbRefsText = (draft.knowledge_refs ?? []).join("\n");
  const skillRefsText = (draft.skill_refs ?? []).join("\n");
  const solutionTagsText = (draft.tags ?? []).join("\n");
  const expertPicksText = (draft.expert_template_ids ?? []).join("\n");
  const promptPackText = safeJson(recommended?.prompt_pack ?? {});
  const memoryText = safeJson(recommended?.memory_config ?? {});
  const grantsText = safeJson(draft.default_grants ?? {});

  return (
    <section className="flex flex-col gap-lg">
      <Link to="/catalog" className="text-sm text-text-muted hover:text-gold">
        ← {i18n.t("operation.catalog.backToList")}
      </Link>

      <div className="flex items-center justify-between">
        <h1 className="m-0 text-xl font-bold text-text-primary">
          {item.display_name}
        </h1>
        <div className="flex gap-sm">
          {canWrite && !editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              编辑
            </Button>
          )}
        </div>
      </div>

      <GlassPanel className="rounded-window p-md">
        <table className="w-full text-sm">
          <tbody>
            <tr>
              <td className="w-[140px] text-text-secondary">模板 ID</td>
              <td>{item.template_id}</td>
            </tr>
            <tr>
              <td className="text-text-secondary">类型</td>
              <td>{isExpert ? "专家模板" : "行业方案"}</td>
            </tr>
            <tr>
              <td className="text-text-secondary">版本</td>
              <td>{item.version}</td>
            </tr>
            <tr>
              <td className="text-text-secondary">状态</td>
              <td>{item.status}</td>
            </tr>
            <tr>
              <td className="text-text-secondary">可见范围</td>
              <td>
                {canWrite && editing ? (
                  <Select
                    value={vLabel}
                    onChange={(e) =>
                      void doVisibility(
                        e.target.value as "public" | "enterprise" | "hidden",
                      )
                    }
                  >
                    <option value="public">
                      {i18n.t("operation.catalog.visibilityPublic")}
                    </option>
                    <option value="enterprise">
                      {i18n.t("operation.catalog.visibilityEnterprise")}
                    </option>
                    <option value="hidden">
                      {i18n.t("operation.catalog.visibilityHidden")}
                    </option>
                  </Select>
                ) : vLabel === "public" ? (
                  i18n.t("operation.catalog.visibilityPublic")
                ) : vLabel === "enterprise" ? (
                  i18n.t("operation.catalog.visibilityEnterprise")
                ) : (
                  i18n.t("operation.catalog.visibilityHidden")
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </GlassPanel>

      <div className="flex flex-col gap-lg">
        {isExpert ? (
          <ExpertDetailSections
            draft={draft}
            onChange={setDraft}
            modelRef={modelRef}
            skillsText={skillsText}
            kbText={kbText}
            promptPackText={promptPackText}
            memoryText={memoryText}
            recommended={recommended}
            editing={editing}
          />
        ) : (
          <SolutionDetailSections
            draft={draft}
            onChange={setDraft}
            expertPicksText={expertPicksText}
            kbRefsText={kbRefsText}
            skillRefsText={skillRefsText}
            solutionTagsText={solutionTagsText}
            grantsText={grantsText}
            editing={editing}
          />
        )}
      </div>

      {editing && (
        <GlassPanel className="rounded-window border border-gold/30 p-md">
          {editError && (
            <p className="m-0 mb-sm text-sm text-danger">{editError}</p>
          )}
          <div className="flex gap-sm">
            <Button
              variant="metal"
              size="sm"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "保存中…" : "保存"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setDraft({ ...item });
                setEditing(false);
                setEditError(null);
              }}
            >
              取消
            </Button>
          </div>
        </GlassPanel>
      )}
    </section>
  );
}

// ---- 专家详情 sections ----

interface ExpertDetailProps {
  draft: CatalogItem;
  onChange: (next: CatalogItem) => void;
  modelRef: ModelRef;
  skillsText: string;
  kbText: string;
  promptPackText: string;
  memoryText: string;
  recommended?: ExpertRecommendedConfig;
  editing: boolean;
}

function ExpertDetailSections(p: ExpertDetailProps): ReactNode {
  return (
    <>
      <DetailSection title="人设(persona)">
        {p.editing ? (
          <textarea
            className={textareaCls}
            value={p.draft.persona ?? ""}
            onChange={(e) =>
              p.onChange({ ...p.draft, persona: e.target.value })
            }
          />
        ) : (
          <ReadonlyText value={p.draft.persona} />
        )}
      </DetailSection>

      <DetailSection title="岗位 / 类别">
        <div className="grid grid-cols-2 gap-sm">
          {p.editing ? (
            <>
              <Field label="role_name">
                <Input
                  className={inputCls}
                  value={p.recommended?.role_name ?? ""}
                  onChange={(e) =>
                    p.onChange({
                      ...p.draft,
                      recommended_config: {
                        ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                        role_name: e.target.value,
                      },
                    })
                  }
                />
              </Field>
              <Field label="category_code">
                <Input
                  className={inputCls}
                  value={p.recommended?.category_code ?? ""}
                  onChange={(e) =>
                    p.onChange({
                      ...p.draft,
                      recommended_config: {
                        ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                        category_code: e.target.value,
                      },
                    })
                  }
                />
              </Field>
            </>
          ) : (
            <>
              <ReadonlyRow label="role_name" value={p.recommended?.role_name} />
              <ReadonlyRow label="category_code" value={p.recommended?.category_code} />
            </>
          )}
        </div>
      </DetailSection>

      <DetailSection title="推荐模型 (default_model_ref)">
        {p.editing ? (
          <div className="grid grid-cols-2 gap-sm">
            <Field label="provider_key">
              <Input
                className={inputCls}
                value={p.modelRef.provider_key ?? ""}
                onChange={(e) =>
                  p.onChange({
                    ...p.draft,
                    recommended_config: {
                      ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                      default_model_ref: {
                        ...((p.draft.recommended_config as ExpertRecommendedConfig)?.default_model_ref ?? {}),
                        provider_key: e.target.value,
                      },
                    },
                  })
                }
              />
            </Field>
            <Field label="model_id">
              <Input
                className={inputCls}
                value={p.modelRef.model_id ?? ""}
                onChange={(e) =>
                  p.onChange({
                    ...p.draft,
                    recommended_config: {
                      ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                      default_model_ref: {
                        ...((p.draft.recommended_config as ExpertRecommendedConfig)?.default_model_ref ?? {}),
                        model_id: e.target.value,
                      },
                    },
                  })
                }
              />
            </Field>
          </div>
        ) : (
          <ReadonlyJson value={p.modelRef} />
        )}
      </DetailSection>

      <DetailSection title="默认技能 / 知识绑定 / Prompt Pack">
        {p.editing ? (
          <div className="flex flex-col gap-md">
            <Field label="默认技能 (每行或逗号)">
              <textarea
                className={textareaCls}
                value={p.skillsText}
                onChange={(e) => {
                  const skills = parseList(e.target.value);
                  p.onChange({
                    ...p.draft,
                    recommended_config: {
                      ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                      default_skills: skills,
                    },
                  });
                }}
              />
            </Field>
            <Field label="知识库 (每行或逗号)">
              <textarea
                className={textareaCls}
                value={p.kbText}
                onChange={(e) => {
                  const kb = parseList(e.target.value);
                  p.onChange({
                    ...p.draft,
                    recommended_config: {
                      ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                      knowledge_bindings: kb,
                    },
                  });
                }}
              />
            </Field>
            <Field label="Prompt Pack (JSON)">
              <textarea
                className={textareaCls}
                value={p.promptPackText}
                onChange={(e) => {
                  const parsed = parseJsonObject(e.target.value);
                  if (!parsed) return;
                  p.onChange({
                    ...p.draft,
                    recommended_config: {
                      ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                      prompt_pack: parsed,
                    },
                  });
                }}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-md">
            <ReadonlyJson title="default_skills" value={p.recommended?.default_skills} />
            <ReadonlyJson title="knowledge_bindings" value={p.recommended?.knowledge_bindings} />
            <ReadonlyJson title="prompt_pack" value={p.recommended?.prompt_pack} />
          </div>
        )}
      </DetailSection>

      <DetailSection title="初始记忆 (memory_config)">
        {p.editing ? (
          <textarea
            className={textareaCls}
            value={p.memoryText}
            onChange={(e) => {
              const parsed = parseJsonObject(e.target.value);
              if (!parsed) return;
              p.onChange({
                ...p.draft,
                recommended_config: {
                  ...(p.draft.recommended_config as ExpertRecommendedConfig ?? {}),
                  memory_config: parsed,
                },
              });
            }}
          />
        ) : (
          <ReadonlyJson value={p.recommended?.memory_config} />
        )}
      </DetailSection>
    </>
  );
}

// ---- 行业方案详情 sections ----

interface SolutionDetailProps {
  draft: CatalogItem;
  onChange: (next: CatalogItem) => void;
  expertPicksText: string;
  kbRefsText: string;
  skillRefsText: string;
  solutionTagsText: string;
  grantsText: string;
  editing: boolean;
}

function SolutionDetailSections(p: SolutionDetailProps): ReactNode {
  return (
    <>
      <DetailSection title="配置专家 (expert_template_ids)">
        {p.editing ? (
          <textarea
            className={textareaCls}
            value={p.expertPicksText}
            onChange={(e) => {
              const ids = parseList(e.target.value);
              p.onChange({ ...p.draft, expert_template_ids: ids });
            }}
            placeholder="每行一个 template_id (编辑模式)"
          />
        ) : (
          <ReadonlyJson value={p.draft.expert_template_ids} />
        )}
      </DetailSection>

      <DetailSection title="知识 / 技能引用">
        {p.editing ? (
          <div className="flex flex-col gap-md">
            <Field label="知识引用 (knowledge_refs)">
              <textarea
                className={textareaCls}
                value={p.kbRefsText}
                onChange={(e) => {
                  const refs = parseList(e.target.value);
                  p.onChange({ ...p.draft, knowledge_refs: refs });
                }}
              />
            </Field>
            <Field label="技能引用 (skill_refs)">
              <textarea
                className={textareaCls}
                value={p.skillRefsText}
                onChange={(e) => {
                  const refs = parseList(e.target.value);
                  p.onChange({ ...p.draft, skill_refs: refs });
                }}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-md">
            <ReadonlyJson title="knowledge_refs" value={p.draft.knowledge_refs} />
            <ReadonlyJson title="skill_refs" value={p.draft.skill_refs} />
          </div>
        )}
      </DetailSection>

      <DetailSection title="协作编排规则 (prompts)">
        {p.editing ? (
          <div className="flex flex-col gap-md">
            <Field label="planner_prompt">
              <textarea
                className={textareaCls}
                value={p.draft.planner_prompt ?? ""}
                onChange={(e) =>
                  p.onChange({ ...p.draft, planner_prompt: e.target.value })
                }
              />
            </Field>
            <Field label="subtask_prompt">
              <textarea
                className={textareaCls}
                value={p.draft.subtask_prompt ?? ""}
                onChange={(e) =>
                  p.onChange({ ...p.draft, subtask_prompt: e.target.value })
                }
              />
            </Field>
            <Field label="aggregate_prompt">
              <textarea
                className={textareaCls}
                value={p.draft.aggregate_prompt ?? ""}
                onChange={(e) =>
                  p.onChange({ ...p.draft, aggregate_prompt: e.target.value })
                }
              />
            </Field>
          </div>
        ) : (
          <div className="flex flex-col gap-sm">
            <ReadonlyRow label="planner_prompt" value={p.draft.planner_prompt} />
            <ReadonlyRow label="subtask_prompt" value={p.draft.subtask_prompt} />
            <ReadonlyRow label="aggregate_prompt" value={p.draft.aggregate_prompt} />
          </div>
        )}
      </DetailSection>

      <DetailSection title="默认 Grants / 方案标签">
        {p.editing ? (
          <div className="flex flex-col gap-md">
            <Field label="默认 Grants (JSON)">
              <textarea
                className={textareaCls}
                value={p.grantsText}
                onChange={(e) => {
                  const parsed = parseJsonObject(e.target.value);
                  if (!parsed) return;
                  p.onChange({ ...p.draft, default_grants: parsed });
                }}
              />
            </Field>
            <Field label="方案标签 (每行或逗号)">
              <textarea
                className={textareaCls}
                value={p.solutionTagsText}
                onChange={(e) => {
                  const tags = parseList(e.target.value);
                  p.onChange({ ...p.draft, tags });
                }}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-md">
            <ReadonlyJson title="default_grants" value={p.draft.default_grants} />
            <ReadonlyJson title="tags" value={p.draft.tags} />
          </div>
        )}
      </DetailSection>
    </>
  );
}

// ---- 通用展示组件 ----

interface DetailSectionProps {
  title: string;
  children: ReactNode;
}

function DetailSection({ title, children }: DetailSectionProps): ReactNode {
  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-md">
      <h3 className="m-0 text-sm font-semibold text-text-primary">{title}</h3>
      {children}
    </GlassPanel>
  );
}

function ReadonlyText({ value }: { value?: string | null }): ReactNode {
  if (!value) {
    return <span className="text-text-muted">—</span>;
  }
  return (
    <p className="m-0 whitespace-pre-wrap text-sm text-text-primary">{value}</p>
  );
}

function ReadonlyRow({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-xs">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="text-sm text-text-primary">
        {value && value.length > 0 ? value : "—"}
      </span>
    </div>
  );
}

function ReadonlyJson({
  title,
  value,
}: {
  title?: string;
  value?: unknown;
}): ReactNode {
  const rendered =
    value == null || (Array.isArray(value) && value.length === 0)
      ? "—"
      : safeJson(value);
  return (
    <div className="flex flex-col gap-xs rounded-md border border-gold/10 bg-surface p-sm">
      {title && <span className="text-xs text-text-muted">{title}</span>}
      <pre className="m-0 max-h-[200px] overflow-auto whitespace-pre-wrap text-xs text-text-primary">
        {rendered}
      </pre>
    </div>
  );
}
