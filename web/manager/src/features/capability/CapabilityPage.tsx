/**
 * 能力目录页（M4，02 §10.1）。
 *
 * 三段目录（技能/连接器/记忆策略）：浏览 + 新增表单（弹窗）+ 行内编辑/删除。
 * owner/enterprise_admin 可写，其余只读（后端鉴权兜底，前端仅 UI 门控）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { Button, Field, GlassPanel, Input, Select, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useCapabilityApi } from "./useCapabilityApi";
import type {
  SkillCatalog,
  ConnectorCatalog,
  MemoryPolicyCatalog,
  SkillCatalogIn,
  ConnectorCatalogIn,
  MemoryPolicyCatalogIn,
  SkillInstallPolicy,
  SkillBindingPolicy,
  CatalogVisibility,
  ConnectorGrantScope,
} from "./types";
import {
  SKILL_INSTALL_POLICIES,
  SKILL_BINDING_POLICIES,
  CATALOG_VISIBILITIES,
  CONNECTOR_GRANT_SCOPES,
} from "./types";

type Kind = "skill" | "connector" | "memory";

interface SkillDraft {
  kind: "skill";
  id: string;
  displayName: string;
  version: string;
  install: SkillInstallPolicy;
  binding: SkillBindingPolicy;
  visibility: CatalogVisibility;
  config: string;
}
interface ConnectorDraft {
  kind: "connector";
  id: string;
  displayName: string;
  grant: ConnectorGrantScope;
  visibility: CatalogVisibility;
  config: string;
}
interface MemoryDraft {
  kind: "memory";
  id: string;
  displayName: string;
  retention: string;
  visibility: CatalogVisibility;
  config: string;
  policy: string;
  seed: string;
}
type Draft = SkillDraft | ConnectorDraft | MemoryDraft;

type Dialog =
  | { mode: "closed" }
  | { mode: "create"; kind: Kind; draft: Draft }
  | { mode: "edit"; kind: Kind; catalogId: string; draft: Draft };

interface PendingDelete {
  kind: Kind;
  catalogId: string;
  displayName: string;
}

function parseJson(value: string): Record<string, unknown> {
  const t = value.trim();
  if (!t) return {};
  try {
    const parsed = JSON.parse(t);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
function parseJsonArray(value: string): unknown[] {
  const t = value.trim();
  if (!t) return [];
  try {
    const parsed = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function configOf(item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog): string {
  return item.config && Object.keys(item.config).length ? JSON.stringify(item.config) : "";
}

function emptyDraft(kind: Kind): Draft {
  switch (kind) {
    case "skill":
      return { kind, id: "", displayName: "", version: "1", install: "on_demand", binding: "opt_in", visibility: "private", config: "" };
    case "connector":
      return { kind, id: "", displayName: "", grant: "tenant_wide", visibility: "private", config: "" };
    case "memory":
      return { kind, id: "", displayName: "", retention: "", visibility: "private", config: "", policy: "", seed: "[]" };
  }
}

function draftFrom(kind: Kind, item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog): Draft {
  if (kind === "skill") {
    const s = item as SkillCatalog;
    return { kind, id: s.skill_id, displayName: s.display_name, version: s.version, install: s.install_policy as SkillInstallPolicy, binding: s.binding_policy as SkillBindingPolicy, visibility: s.visibility as CatalogVisibility, config: configOf(s) };
  }
  if (kind === "connector") {
    const c = item as ConnectorCatalog;
    return { kind, id: c.connector_id, displayName: c.display_name, grant: c.grant_scope as ConnectorGrantScope, visibility: c.visibility as CatalogVisibility, config: configOf(c) };
  }
  const m = item as MemoryPolicyCatalog;
  return {
    kind, id: m.policy_id, displayName: m.display_name,
    retention: m.retention_days != null ? String(m.retention_days) : "",
    visibility: m.visibility as CatalogVisibility, config: configOf(m),
    policy: m.policy && Object.keys(m.policy).length ? JSON.stringify(m.policy) : "",
    seed: m.seed_memories.length ? JSON.stringify(m.seed_memories) : "[]",
  };
}

export function CapabilityPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useCapabilityApi();

  const [skills, setSkills] = useState<SkillCatalog[]>([]);
  const [connectors, setConnectors] = useState<ConnectorCatalog[]>([]);
  const [memories, setMemories] = useState<MemoryPolicyCatalog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>({ mode: "closed" });
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, c, m] = await Promise.all([api.listSkills(), api.listConnectors(), api.listMemoryPolicies()]);
      setSkills(s);
      setConnectors(c);
      setMemories(m);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.capability.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const runWrite = useCallback(
    async (fn: () => Promise<unknown>, successKey: string) => {
      setActionError(null);
      setNotice(null);
      try {
        await fn();
        setNotice(i18n.t(successKey));
        await load();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : i18n.t("manager.capability.action_error"));
        throw err;
      }
    },
    [i18n, load],
  );

  const openCreate = (kind: Kind) => setDialog({ mode: "create", kind, draft: emptyDraft(kind) });
  const openEdit = (kind: Kind, item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog) =>
    setDialog({ mode: "edit", kind, catalogId: item.catalog_id, draft: draftFrom(kind, item) });
  const closeDialog = () => setDialog({ mode: "closed" });

  const renderDialog = (): ReactNode => {
    if (dialog.mode === "closed") return null;
    const { kind, draft } = dialog;
    const titleKey = kind === "skill" ? "manager.capability.add_skill" : kind === "connector" ? "manager.capability.add_connector" : "manager.capability.add_memory_policy";
    const editing = dialog.mode === "edit";

    const update = (key: string, value: unknown) =>
      setDialog((d) => (d.mode === "closed" ? d : { ...d, draft: { ...(d.draft as unknown as Record<string, unknown>), [key]: value } as unknown as Draft }));

    const onSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (kind === "skill") {
        const d = draft as SkillDraft;
        const body: SkillCatalogIn = { skill_id: d.id.trim(), display_name: d.displayName.trim(), version: d.version.trim() || "1", install_policy: d.install, binding_policy: d.binding, visibility: d.visibility, config: parseJson(d.config) };
        const fn = editing ? () => api.updateSkill((dialog as { catalogId: string }).catalogId, body) : () => api.createSkill(body);
        void runWrite(fn, editing ? "manager.capability.update_ok" : "manager.capability.create_ok").finally(closeDialog);
      } else if (kind === "connector") {
        const d = draft as ConnectorDraft;
        const body: ConnectorCatalogIn = { connector_id: d.id.trim(), display_name: d.displayName.trim(), grant_scope: d.grant, visibility: d.visibility, config: parseJson(d.config) };
        const fn = editing ? () => api.updateConnector((dialog as { catalogId: string }).catalogId, body) : () => api.createConnector(body);
        void runWrite(fn, editing ? "manager.capability.update_ok" : "manager.capability.create_ok").finally(closeDialog);
      } else {
        const d = draft as MemoryDraft;
        const body: MemoryPolicyCatalogIn = {
          policy_id: d.id.trim(), display_name: d.displayName.trim(), policy: parseJson(d.policy),
          seed_memories: parseJsonArray(d.seed),
          retention_days: d.retention.trim() === "" ? null : Number(d.retention),
          visibility: d.visibility, config: parseJson(d.config),
        };
        const fn = editing ? () => api.updateMemoryPolicy((dialog as { catalogId: string }).catalogId, body) : () => api.createMemoryPolicy(body);
        void runWrite(fn, editing ? "manager.capability.update_ok" : "manager.capability.create_ok").finally(closeDialog);
      }
    };

    return createPortal(
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg-canvas/70 p-md" role="dialog" aria-modal="true">
        <GlassPanel className="flex w-full max-w-lg flex-col gap-md rounded-window p-lg">
          <div className="flex items-center justify-between">
            <h3 className="m-0 text-base font-semibold text-text-primary">{i18n.t(titleKey)}</h3>
            <button type="button" className="text-text-muted hover:text-text-primary" onClick={closeDialog} aria-label={i18n.t("manager.capability.cancel")}>✕</button>
          </div>
          <form className="flex flex-col gap-md" onSubmit={onSubmit}>
            {actionError && <p className="m-0 text-sm text-danger">{actionError}</p>}
            <Field label={i18n.t("manager.capability.id")}>
              <Input value={draft.id} onChange={(e) => update("id", e.target.value)} required data-testid="field-id" />
            </Field>
            <Field label={i18n.t("manager.capability.display_name")}>
              <Input value={draft.displayName} onChange={(e) => update("displayName", e.target.value)} />
            </Field>
            {kind === "skill" && draft.kind === "skill" && (
              <>
                <Field label={i18n.t("manager.capability.version")}>
                  <Input value={draft.version} onChange={(e) => update("version", e.target.value)} />
                </Field>
                <Field label={i18n.t("manager.capability.install_policy")}>
                  <Select value={draft.install} onChange={(e) => update("install", e.target.value as SkillInstallPolicy)}>
                    {SKILL_INSTALL_POLICIES.map((p) => (
                      <option key={p} value={p}>{i18n.t(`manager.capability.install.${p}`)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label={i18n.t("manager.capability.binding_policy")}>
                  <Select value={draft.binding} onChange={(e) => update("binding", e.target.value as SkillBindingPolicy)}>
                    {SKILL_BINDING_POLICIES.map((p) => (
                      <option key={p} value={p}>{i18n.t(`manager.capability.binding.${p}`)}</option>
                    ))}
                  </Select>
                </Field>
              </>
            )}
            {kind === "connector" && draft.kind === "connector" && (
              <Field label={i18n.t("manager.capability.grant_scope")}>
                <Select value={draft.grant} onChange={(e) => update("grant", e.target.value as ConnectorGrantScope)}>
                  {CONNECTOR_GRANT_SCOPES.map((g) => (
                    <option key={g} value={g}>{i18n.t(`manager.capability.grant.${g}`)}</option>
                  ))}
                </Select>
              </Field>
            )}
            {kind === "memory" && draft.kind === "memory" && (
              <Field label={i18n.t("manager.capability.retention_days")}>
                <Input type="number" min="0" placeholder={i18n.t("manager.capability.retention_days_unlimited")} value={draft.retention} onChange={(e) => update("retention", e.target.value)} />
              </Field>
            )}
            <Field label={i18n.t("manager.capability.visibility")}>
              <Select value={draft.visibility} onChange={(e) => update("visibility", e.target.value as CatalogVisibility)}>
                {CATALOG_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>{i18n.t(`manager.capability.visibility.${v}`)}</option>
                ))}
              </Select>
            </Field>
            <Field label={i18n.t("manager.capability.config")}>
              <textarea className="min-h-20 rounded-md border border-gold/20 bg-surface px-md py-sm text-sm font-mono text-text-primary outline-none focus:border-gold/50 focus:ring-2 focus:ring-gold" placeholder={i18n.t("manager.capability.config_placeholder")} value={draft.config} onChange={(e) => update("config", e.target.value)} />
            </Field>
            <div className="flex gap-sm">
              <Button type="submit" size="sm">{i18n.t("manager.capability.save")}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={closeDialog}>{i18n.t("manager.capability.cancel")}</Button>
            </div>
          </form>
        </GlassPanel>
      </div>,
      document.body,
    );
  };

  const renderDeleteConfirm = (): ReactNode => {
    if (!pendingDelete) return null;
    const { kind, catalogId, displayName } = pendingDelete;
    const confirm = async () => {
      const fn = kind === "skill" ? () => api.deleteSkill(catalogId) : kind === "connector" ? () => api.deleteConnector(catalogId) : () => api.deleteMemoryPolicy(catalogId);
      setPendingDelete(null);
      await runWrite(fn, "manager.capability.delete_ok");
    };
    return (
      <span className="flex items-center gap-sm">
        <span className="text-xs text-text-secondary">{displayName}</span>
        <span className="text-xs text-danger">{i18n.t("manager.capability.delete_confirm")}</span>
        <Button type="button" variant="danger" size="sm" onClick={() => void confirm()}>{i18n.t("manager.capability.delete_confirm_ok")}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>{i18n.t("manager.capability.delete_cancel")}</Button>
      </span>
    );
  };

  const catalogActions = (kind: Kind, item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog, displayName: string) => {
    if (!canWrite) return null;
    if (pendingDelete && pendingDelete.catalogId === item.catalog_id) return renderDeleteConfirm();
    return (
      <span className="flex items-center gap-sm">
        <Button type="button" variant="ghost" size="sm" onClick={() => openEdit(kind, item)}>{i18n.t("manager.capability.edit")}</Button>
        <Button type="button" variant="danger" size="sm" onClick={() => setPendingDelete({ kind, catalogId: item.catalog_id, displayName })}>{i18n.t("manager.capability.delete")}</Button>
      </span>
    );
  };

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">{i18n.t("manager.capability.loading")}</GlassPanel>;

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("manager.nav.capability")}</h1>
      {notice && <p className="m-0 text-sm text-success" role="status">{notice}</p>}
      {actionError && dialog.mode === "closed" && <p className="m-0 text-sm text-danger">{actionError}</p>}
      {!loading && error && <p className="m-0 text-sm text-danger">{error}</p>}

      <CatalogSection
        title={i18n.t("manager.capability.skills_title", { count: skills.length })}
        addLabel={i18n.t("manager.capability.add_skill")}
        canWrite={canWrite}
        onAdd={() => openCreate("skill")}
        empty={skills.length === 0}
        emptyText={i18n.t("manager.capability.empty")}
      >
        <Table>
          <thead><tr><th>{i18n.t("manager.capability.id")}</th><th>{i18n.t("manager.capability.display_name")}</th><th>{i18n.t("manager.capability.version")}</th><th>{i18n.t("manager.capability.install_policy")}</th><th>{i18n.t("manager.capability.binding_policy")}</th><th>{i18n.t("manager.capability.visibility")}</th>{canWrite && <th>{i18n.t("manager.capability.actions")}</th>}</tr></thead>
          <tbody>
            {skills.map((s) => (
              <tr key={s.catalog_id}>
                <td>{s.skill_id}</td>
                <td>{s.display_name || "—"}</td>
                <td>{s.version}</td>
                <td>{s.install_policy}</td>
                <td>{s.binding_policy}</td>
                <td>{s.visibility}</td>
                {canWrite && (<td>{catalogActions("skill", s, s.display_name || s.skill_id)}</td>)}
              </tr>
            ))}
          </tbody>
        </Table>
      </CatalogSection>

      <CatalogSection
        title={i18n.t("manager.capability.connectors_title", { count: connectors.length })}
        addLabel={i18n.t("manager.capability.add_connector")}
        canWrite={canWrite}
        onAdd={() => openCreate("connector")}
        empty={connectors.length === 0}
        emptyText={i18n.t("manager.capability.empty")}
      >
        <Table>
          <thead><tr><th>{i18n.t("manager.capability.id")}</th><th>{i18n.t("manager.capability.display_name")}</th><th>{i18n.t("manager.capability.grant_scope")}</th><th>{i18n.t("manager.capability.visibility")}</th>{canWrite && <th>{i18n.t("manager.capability.actions")}</th>}</tr></thead>
          <tbody>
            {connectors.map((c) => (
              <tr key={c.catalog_id}>
                <td>{c.connector_id}</td>
                <td>{c.display_name || "—"}</td>
                <td>{c.grant_scope}</td>
                <td>{c.visibility}</td>
                {canWrite && (<td>{catalogActions("connector", c, c.display_name || c.connector_id)}</td>)}
              </tr>
            ))}
          </tbody>
        </Table>
      </CatalogSection>

      <CatalogSection
        title={i18n.t("manager.capability.memories_title", { count: memories.length })}
        addLabel={i18n.t("manager.capability.add_memory_policy")}
        canWrite={canWrite}
        onAdd={() => openCreate("memory")}
        empty={memories.length === 0}
        emptyText={i18n.t("manager.capability.empty")}
      >
        <Table>
          <thead><tr><th>{i18n.t("manager.capability.id")}</th><th>{i18n.t("manager.capability.display_name")}</th><th>{i18n.t("manager.capability.retention_days")}</th><th>{i18n.t("manager.capability.visibility")}</th>{canWrite && <th>{i18n.t("manager.capability.actions")}</th>}</tr></thead>
          <tbody>
            {memories.map((m) => (
              <tr key={m.catalog_id}>
                <td>{m.policy_id}</td>
                <td>{m.display_name || "—"}</td>
                <td>{m.retention_days != null ? String(m.retention_days) : i18n.t("manager.capability.retention_days_unlimited")}</td>
                <td>{m.visibility}</td>
                {canWrite && (<td>{catalogActions("memory", m, m.display_name || m.policy_id)}</td>)}
              </tr>
            ))}
          </tbody>
        </Table>
      </CatalogSection>

      {renderDialog()}
    </section>
  );
}

interface SectionProps {
  title: string;
  addLabel: string;
  canWrite: boolean;
  onAdd: () => void;
  empty: boolean;
  emptyText: string;
  children: ReactNode;
}

function CatalogSection({ title, addLabel, canWrite, onAdd, empty, emptyText, children }: SectionProps): ReactNode {
  return (
    <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
      <div className="flex items-center justify-between">
        <h2 className="m-0 text-base font-semibold text-text-primary">{title}</h2>
        {canWrite && (
          <Button type="button" size="sm" onClick={onAdd} data-testid={`add-${title}`}>{addLabel}</Button>
        )}
      </div>
      {empty ? <p className="m-0 text-sm text-text-muted">{emptyText}</p> : (
        <div className="overflow-x-auto">
          {children}
        </div>
      )}
    </GlassPanel>
  );
}
