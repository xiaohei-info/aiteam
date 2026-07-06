/**
 * 目录项详情页（F03）。
 *
 * 对齐后端 GET /api/operation/catalog/{catalog_type}/{template_id}
 * 并对管理员暴露 PATCH 部分更新。
 *
 * 详情显示 payload 扁平字段（PRD-v2）:
 *   - 专家: display_name / category / avatar_url / system_prompt /
 *     default_model / skill_ids / tags / description / initial_memories / sort_order
 *   - 行业方案: expert_template_ids / knowledge_refs / skill_refs /
 *     planner_prompt / subtask_prompt / aggregate_prompt / default_grants / tags
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

function parseJsonArray(value: string): Record<string, unknown>[] | undefined {
  const text = value.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
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
      // Always send the full editable payload so that clearing a field (to empty /
      // empty array / null) is reflected — do not use truthy guards which would keep
      // stale server values when the user empties a field.
      const changes: Record<string, unknown> = { display_name: draft.display_name };
      if (isExpert) {
        changes.system_prompt = draft.system_prompt ?? "";
        changes.default_model = draft.default_model ?? "";
        changes.category = draft.category ?? "";
        changes.avatar_url = draft.avatar_url ?? "";
        changes.description = draft.description ?? "";
        changes.skill_ids = draft.skill_ids ?? [];
        changes.tags = draft.tags ?? [];
        changes.initial_memories = draft.initial_memories ?? [];
        changes.sort_order = draft.sort_order ?? 0;
      } else {
        changes.description = draft.description ?? "";
        changes.icon = draft.icon ?? "";
        changes.expert_template_ids = draft.expert_template_ids ?? [];
        changes.knowledge_refs = draft.knowledge_refs ?? [];
        changes.skill_refs = draft.skill_refs ?? [];
        changes.planner_prompt = draft.planner_prompt ?? "";
        changes.subtask_prompt = draft.subtask_prompt ?? "";
        changes.aggregate_prompt = draft.aggregate_prompt ?? "";
        changes.default_grants = draft.default_grants ?? null;
        changes.tags = draft.tags ?? [];
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
  const skillIdsText = (draft.skill_ids ?? []).join("\n");
  const tagsText = (draft.tags ?? []).join("\n");
  const description = draft.description ?? "";
  const initialMemoriesText = safeJson(draft.initial_memories ?? []);
  const kbRefsText = (draft.knowledge_refs ?? []).join("\n");
  const skillRefsText = (draft.skill_refs ?? []).join("\n");
  const solutionTagsText = (draft.tags ?? []).join("\n");
  const expertPicksText = (draft.expert_template_ids ?? []).join("\n");
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
            skillIdsText={skillIdsText}
            tagsText={tagsText}
            description={description}
            initialMemoriesText={initialMemoriesText}
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
  skillIdsText: string;
  tagsText: string;
  description: string;
  initialMemoriesText: string;
  editing: boolean;
}

function ExpertDetailSections(p: ExpertDetailProps): ReactNode {
  return (
    <>
      <DetailSection title="分类 / 头像">
        <div className="grid grid-cols-2 gap-sm">
          {p.editing ? (
            <>
              <Field label="category">
                <Input
                  className={inputCls}
                  value={p.draft.category ?? ""}
                  onChange={(e) =>
                    p.onChange({ ...p.draft, category: e.target.value })
                  }
                />
              </Field>
              <Field label="avatar_url">
                <Input
                  className={inputCls}
                  value={p.draft.avatar_url ?? ""}
                  onChange={(e) =>
                    p.onChange({ ...p.draft, avatar_url: e.target.value })
                  }
                />
              </Field>
            </>
          ) : (
            <>
              <ReadonlyRow label="category" value={p.draft.category} />
              <ReadonlyRow label="avatar_url" value={p.draft.avatar_url} />
            </>
          )}
        </div>
      </DetailSection>

      <DetailSection title="系统提示词 (system_prompt)">
        {p.editing ? (
          <textarea
            className={textareaCls}
            placeholder="岗位描述系统提示词（纯文本）"
            value={p.draft.system_prompt ?? ""}
            onChange={(e) =>
              p.onChange({ ...p.draft, system_prompt: e.target.value })
            }
          />
        ) : (
          <ReadonlyText value={p.draft.system_prompt} />
        )}
      </DetailSection>

      <DetailSection title="默认模型 (default_model)">
        {p.editing ? (
          <Input
            type="text"
            className={inputCls}
            value={p.draft.default_model ?? ""}
            onChange={(e) =>
              p.onChange({ ...p.draft, default_model: e.target.value })
            }
          />
        ) : (
          <ReadonlyText value={p.draft.default_model} />
        )}
      </DetailSection>

      <DetailSection title="岗位描述 (description)">
        {p.editing ? (
          <textarea
            className={textareaCls}
            value={p.description}
            onChange={(e) =>
              p.onChange({ ...p.draft, description: e.target.value })
            }
          />
        ) : (
          <ReadonlyText value={p.draft.description} />
        )}
      </DetailSection>

      <DetailSection title="技能 / 标签">
        {p.editing ? (
          <div className="flex flex-col gap-md">
            <Field label="skill_ids (每行或逗号)">
              <textarea
                className={textareaCls}
                value={p.skillIdsText}
                onChange={(e) => {
                  const skills = parseList(e.target.value);
                  p.onChange({ ...p.draft, skill_ids: skills });
                }}
              />
            </Field>
            <Field label="tags (每行或逗号)">
              <textarea
                className={textareaCls}
                value={p.tagsText}
                onChange={(e) => {
                  const tags = parseList(e.target.value);
                  p.onChange({ ...p.draft, tags });
                }}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-md">
            <ReadonlyJson title="skill_ids" value={p.draft.skill_ids} />
            <ReadonlyJson title="tags" value={p.draft.tags} />
          </div>
        )}
      </DetailSection>

      <DetailSection title="预置记忆 (initial_memories)">
        {p.editing ? (
          <textarea
            className={textareaCls}
            value={p.initialMemoriesText}
            onChange={(e) => {
              const parsed = parseJsonArray(e.target.value);
              if (!parsed) return;
              p.onChange({ ...p.draft, initial_memories: parsed });
            }}
          />
        ) : (
          <ReadonlyJson value={p.draft.initial_memories} />
        )}
      </DetailSection>

      <DetailSection title="排序 (sort_order)">
        <ReadonlyText value={p.draft.sort_order?.toString()} />
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
