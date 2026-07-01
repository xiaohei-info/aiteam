/**
 * 目录项详情页（F03）——只读 + 编辑模式。
 *   GET  /api/operation/catalog/{catalog_type}/{template_id}
 *   PATCH /api/operation/catalog/{catalog_type}/{template_id}
 */
import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { ApiError, PlatformRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem, CatalogItemType } from "./types";

const textareaCls =
  "min-h-[80px] w-full resize-y rounded-md border border-gold/20 bg-surface px-md " +
  "py-sm text-sm text-text-primary outline-none transition placeholder:text-text-muted " +
  "focus:border-gold/50 focus:ring-2 focus:ring-gold disabled:opacity-50";

export function CatalogDetailPage(): ReactNode {
  const { catalog_type, template_id } = useParams<{ catalog_type: string; template_id: string }>();
  const i18n = useI18n();
  const api = useCatalogApi();
  const { session } = useSession();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN);
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [draftPersona, setDraftPersona] = useState("");
  const [draftRecommendedConfig, setDraftRecommendedConfig] = useState("");
  const [draftExpertBindings, setDraftExpertBindings] = useState("");
  const [draftKnowledgeRefs, setDraftKnowledgeRefs] = useState("");
  const [draftSkillRefs, setDraftSkillRefs] = useState("");
  const [draftDefaultGrants, setDraftDefaultGrants] = useState("");

  useEffect(() => {
    if (!catalog_type || !template_id) return;
    setLoading(true);
    api
      .get(catalog_type as CatalogItemType, template_id)
      .then((data) => { setItem(data); setLoading(false); })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "加载失败");
        setLoading(false);
      });
  }, [api, catalog_type, template_id]);

  useEffect(() => {
    if (!item) return;
    setDraftPersona(item.persona ?? "");
    setDraftRecommendedConfig(safeJson(item.recommended_config));
    setDraftExpertBindings(safeJson(item.expert_bindings));
    setDraftKnowledgeRefs((item.knowledge_refs ?? []).join(", "));
    setDraftSkillRefs((item.skill_refs ?? []).join(", "));
    setDraftDefaultGrants(safeJson(item.default_grants));
  }, [item]);

  function resetDraft(): void {
    if (!item) return;
    setDraftPersona(item.persona ?? "");
    setDraftRecommendedConfig(safeJson(item.recommended_config));
    setDraftExpertBindings(safeJson(item.expert_bindings));
    setDraftKnowledgeRefs((item.knowledge_refs ?? []).join(", "));
    setDraftSkillRefs((item.skill_refs ?? []).join(", "));
    setDraftDefaultGrants(safeJson(item.default_grants));
  }

  function parseList(raw: string): string[] {
    return raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async function handleSave(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!catalog_type || !template_id || !item) return;
    const ct = catalog_type as CatalogItemType;
    setSaving(true);
    setSaveError(null);
    try {
      if (ct === "expert_template") {
        const persona = draftPersona.trim();
        const recommended_config = parseJsonDict(draftRecommendedConfig, "recommended_config");
        const changes = {
          ...(persona ? { persona } : { persona: null }),
          recommended_config,
        };
        const updated = await api.save(ct, template_id, changes);
        if (updated) setItem(updated);
      } else {
        const default_grants = parseJsonDictOrNull(draftDefaultGrants, "default_grants");
        const changes = {
          knowledge_refs: parseList(draftKnowledgeRefs),
          skill_refs: parseList(draftSkillRefs),
          expert_bindings: parseExpertBindings(draftExpertBindings),
          ...(draftDefaultGrants.trim() ? { default_grants } : {}),
        };
        const updated = await api.save(ct, template_id, changes);
        if (updated) setItem(updated);
      }
      setEditing(false);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : (err instanceof Error ? err.message : "保存失败"));
    } finally {
      setSaving(false);
    }
  }

  function safeJson(value: unknown): string {
    if (value == null) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }

  function parseJsonDict(raw: string, field: string): Record<string, unknown> {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      throw new Error(`${field} 必须是 JSON 对象`);
    } catch (err) {
      throw new Error(`${field} JSON 解析失败：${err instanceof Error ? err.message : "格式错误"}`);
    }
  }

  function parseJsonDictOrNull(raw: string, field: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return parseJsonDict(raw, field);
  }

  function parseExpertBindings(raw: string): { template_id: string; sequence_no: number; enabled: boolean }[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) throw new Error("expert_bindings 必须是 JSON 数组");
      return parsed.map((b: Record<string, unknown>, idx: number) => {
        if (!b || typeof b.template_id !== "string" || !b.template_id) {
          throw new Error(`expert_bindings[${idx}].template_id 必填`);
        }
        const sequence_no = Number(b.sequence_no);
        return {
          template_id: b.template_id,
          sequence_no: Number.isFinite(sequence_no) && sequence_no > 0 ? sequence_no : idx + 1,
          enabled: b.enabled !== false,
        };
      });
    } catch (err) {
      throw new Error(`expert_bindings JSON 解析失败：${err instanceof Error ? err.message : "格式错误"}`);
    }
  }

  if (loading) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
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

  if (!item) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("operation.catalog.notFound")}
        </GlassPanel>
      </section>
    );
  }

  const rows: [string, string][] = [
    ["模板 ID", item.template_id],
    ["类型", item.catalog_type === "expert_template" ? "专家模板" : "行业方案"],
    ["版本", item.version],
    ["状态", item.status],
    ["名称", item.display_name],
    ...(item.persona ? [["专家人设（Persona）", item.persona] as [string, string]] : []),
  ];

  return (
    <section className="flex flex-col gap-lg">
      <Link to="/catalog" className="text-sm text-text-muted hover:text-gold">
        ← {i18n.t("operation.catalog.backToList")}
      </Link>
      <h1 className="m-0 text-xl font-bold text-text-primary">{item.display_name}</h1>
      {canWrite && !editing && (
        <div>
          <Button type="button" variant="ghost" size="sm"
            onClick={() => { setEditing(true); resetDraft(); setSaveError(null); }}>
            {i18n.t("operation.catalog.edit")}
          </Button>
        </div>
      )}
      <GlassPanel className="overflow-hidden rounded-window">
        <Table>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="text-text-secondary">{label}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </GlassPanel>

      {editing && (
        <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
          <h2 className="m-0 text-base font-semibold text-text-primary">
            {i18n.t("operation.catalog.editTitle")}
          </h2>
          <form className="flex flex-col gap-md" onSubmit={handleSave}>
            {catalog_type === "expert_template" && (
              <>
                <Field label={i18n.t("operation.catalog.fieldPersona")}>
                  <textarea
                    className={textareaCls}
                    value={draftPersona}
                    onChange={(e) => setDraftPersona(e.target.value)}
                    placeholder="专家人设描述"
                    disabled={saving}
                  />
                </Field>
                <Field label={i18n.t("operation.catalog.fieldRecommendedConfig")}>
                  <textarea
                    className={textareaCls}
                    value={draftRecommendedConfig}
                    onChange={(e) => setDraftRecommendedConfig(e.target.value)}
                    placeholder='{"key": "value"}'
                    disabled={saving}
                  />
                </Field>
              </>
            )}
            {catalog_type === "solution_template" && (
              <>
                <Field label={i18n.t("operation.catalog.fieldExpertBindings")}>
                  <textarea
                    className={textareaCls}
                    value={draftExpertBindings}
                    onChange={(e) => setDraftExpertBindings(e.target.value)}
                    placeholder='[{"template_id": "t1", "sequence_no": 1, "enabled": true}]'
                    disabled={saving}
                  />
                </Field>
                <Field label={i18n.t("operation.catalog.fieldKnowledgeRefs")}>
                  <Input
                    type="text"
                    className="w-full"
                    value={draftKnowledgeRefs}
                    onChange={(e) => setDraftKnowledgeRefs(e.target.value)}
                    placeholder="kb-1, kb-2"
                    disabled={saving}
                  />
                </Field>
                <Field label={i18n.t("operation.catalog.fieldSkillRefs")}>
                  <Input
                    type="text"
                    className="w-full"
                    value={draftSkillRefs}
                    onChange={(e) => setDraftSkillRefs(e.target.value)}
                    placeholder="skill-1, skill-2"
                    disabled={saving}
                  />
                </Field>
                <Field label={i18n.t("operation.catalog.fieldDefaultGrants")}>
                  <textarea
                    className={textareaCls}
                    value={draftDefaultGrants}
                    onChange={(e) => setDraftDefaultGrants(e.target.value)}
                    placeholder='{"role": "viewer"}'
                    disabled={saving}
                  />
                </Field>
              </>
            )}
            {saveError && <p className="m-0 text-sm text-danger">{saveError}</p>}
            <div className="flex gap-sm">
              <Button type="submit" disabled={saving} className="self-start">
                {saving ? i18n.t("operation.catalog.saving") : i18n.t("operation.catalog.save")}
              </Button>
              <Button type="button" variant="ghost" disabled={saving}
                onClick={() => { setEditing(false); resetDraft(); setSaveError(null); }}>
                {i18n.t("operation.catalog.cancelEdit")}
              </Button>
            </div>
          </form>
        </GlassPanel>
      )}
    </section>
  );
}
