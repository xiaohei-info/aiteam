/** 能力目录页：技能、连接器和记忆策略的租户内 CRUD。 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, EnterpriseRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog as AstryxDialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useCapabilityApi } from "./useCapabilityApi";
import type {
  CatalogVisibility,
  ConnectorCatalog,
  ConnectorCatalogIn,
  ConnectorGrantScope,
  MemoryPolicyCatalog,
  MemoryPolicyCatalogIn,
  SkillBindingPolicy,
  SkillCatalog,
  SkillCatalogIn,
  SkillInstallPolicy,
} from "./types";
import {
  CATALOG_VISIBILITIES,
  CONNECTOR_GRANT_SCOPES,
  SKILL_BINDING_POLICIES,
  SKILL_INSTALL_POLICIES,
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
type EditorState =
  | { mode: "closed" }
  | { mode: "create"; kind: Kind; draft: Draft }
  | { mode: "edit"; kind: Kind; catalogId: string; draft: Draft };

interface PendingDelete {
  kind: Kind;
  catalogId: string;
  displayName: string;
}

type SkillRow = SkillCatalog & Record<string, unknown>;
type ConnectorRow = ConnectorCatalog & Record<string, unknown>;
type MemoryRow = MemoryPolicyCatalog & Record<string, unknown>;

function parseJson(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): unknown[] {
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function jsonText(value: Record<string, unknown>): string {
  return Object.keys(value).length > 0 ? JSON.stringify(value) : "";
}

function emptyDraft(kind: Kind): Draft {
  if (kind === "skill") {
    return { kind, id: "", displayName: "", version: "1", install: "on_demand", binding: "opt_in", visibility: "private", config: "" };
  }
  if (kind === "connector") {
    return { kind, id: "", displayName: "", grant: "tenant_wide", visibility: "private", config: "" };
  }
  return { kind, id: "", displayName: "", retention: "", visibility: "private", config: "", policy: "", seed: "[]" };
}

function draftFrom(kind: Kind, item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog): Draft {
  if (kind === "skill") {
    const skill = item as SkillCatalog;
    return {
      kind,
      id: skill.skill_id,
      displayName: skill.display_name,
      version: skill.version,
      install: skill.install_policy as SkillInstallPolicy,
      binding: skill.binding_policy as SkillBindingPolicy,
      visibility: skill.visibility as CatalogVisibility,
      config: jsonText(skill.config),
    };
  }
  if (kind === "connector") {
    const connector = item as ConnectorCatalog;
    return {
      kind,
      id: connector.connector_id,
      displayName: connector.display_name,
      grant: connector.grant_scope as ConnectorGrantScope,
      visibility: connector.visibility as CatalogVisibility,
      config: jsonText(connector.config),
    };
  }
  const memory = item as MemoryPolicyCatalog;
  return {
    kind,
    id: memory.policy_id,
    displayName: memory.display_name,
    retention: memory.retention_days == null ? "" : String(memory.retention_days),
    visibility: memory.visibility as CatalogVisibility,
    config: jsonText(memory.config),
    policy: jsonText(memory.policy),
    seed: memory.seed_memories.length > 0 ? JSON.stringify(memory.seed_memories) : "[]",
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
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillItems, connectorItems, memoryItems] = await Promise.all([
        api.listSkills(),
        api.listConnectors(),
        api.listMemoryPolicies(),
      ]);
      setSkills(skillItems);
      setConnectors(connectorItems);
      setMemories(memoryItems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.capability.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void load(); }, [load]);

  const runWrite = useCallback(async (fn: () => Promise<unknown>, successKey: string): Promise<boolean> => {
    setWorking(true);
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(i18n.t(successKey));
      await load();
      return true;
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("manager.capability.action_error"));
      return false;
    } finally {
      setWorking(false);
    }
  }, [i18n, load]);

  const openCreate = (kind: Kind) => {
    setActionError(null);
    setEditor({ mode: "create", kind, draft: emptyDraft(kind) });
  };
  const openEdit = (kind: Kind, item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog) => {
    setActionError(null);
    setEditor({ mode: "edit", kind, catalogId: item.catalog_id, draft: draftFrom(kind, item) });
  };
  const closeEditor = () => { if (!working) setEditor({ mode: "closed" }); };
  const updateDraft = (key: string, value: unknown) => {
    setEditor((current) => current.mode === "closed"
      ? current
      : { ...current, draft: { ...current.draft, [key]: value } as Draft });
  };

  const submitEditor = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (editor.mode === "closed") return;
    const editingId = editor.mode === "edit" ? editor.catalogId : null;
    let operation: () => Promise<unknown>;

    if (editor.kind === "skill") {
      const draft = editor.draft as SkillDraft;
      const body: SkillCatalogIn = {
        skill_id: draft.id.trim(),
        display_name: draft.displayName.trim(),
        version: draft.version.trim() || "1",
        install_policy: draft.install,
        binding_policy: draft.binding,
        visibility: draft.visibility,
        config: parseJson(draft.config),
      };
      operation = editingId
        ? () => api.updateSkill(editingId, body)
        : () => api.createSkill(body);
    } else if (editor.kind === "connector") {
      const draft = editor.draft as ConnectorDraft;
      const body: ConnectorCatalogIn = {
        connector_id: draft.id.trim(),
        display_name: draft.displayName.trim(),
        grant_scope: draft.grant,
        visibility: draft.visibility,
        config: parseJson(draft.config),
      };
      operation = editingId
        ? () => api.updateConnector(editingId, body)
        : () => api.createConnector(body);
    } else {
      const draft = editor.draft as MemoryDraft;
      const body: MemoryPolicyCatalogIn = {
        policy_id: draft.id.trim(),
        display_name: draft.displayName.trim(),
        policy: parseJson(draft.policy),
        seed_memories: parseJsonArray(draft.seed),
        retention_days: draft.retention.trim() === "" ? null : Number(draft.retention),
        visibility: draft.visibility,
        config: parseJson(draft.config),
      };
      operation = editingId
        ? () => api.updateMemoryPolicy(editingId, body)
        : () => api.createMemoryPolicy(body);
    }

    const success = await runWrite(
      operation,
      editor.mode === "edit" ? "manager.capability.update_ok" : "manager.capability.create_ok",
    );
    if (success) setEditor({ mode: "closed" });
  };

  const actionCell = useCallback((kind: Kind, item: SkillCatalog | ConnectorCatalog | MemoryPolicyCatalog, name: string) => (
    <HStack gap={1} justify="end">
      <Button label={i18n.t("manager.capability.edit")} variant="ghost" size="sm" onClick={() => openEdit(kind, item)} />
      <Button
        label={i18n.t("manager.capability.delete")}
        variant="destructive"
        size="sm"
        onClick={() => setPendingDelete({ kind, catalogId: item.catalog_id, displayName: name })}
      />
    </HStack>
  ), [i18n]);

  const skillColumns = useMemo<TableColumn<SkillRow>[]>(() => {
    const columns: TableColumn<SkillRow>[] = [
      { key: "display_name", header: i18n.t("manager.capability.display_name"), width: proportional(1), renderCell: (row) => row.display_name || "未命名技能" },
      { key: "version", header: i18n.t("manager.capability.version"), width: pixel(80) },
      { key: "install_policy", header: i18n.t("manager.capability.install_policy"), width: pixel(130), renderCell: (row) => <Badge label={row.install_policy} /> },
      { key: "binding_policy", header: i18n.t("manager.capability.binding_policy"), width: pixel(120), renderCell: (row) => <Badge label={row.binding_policy} /> },
      { key: "visibility", header: i18n.t("manager.capability.visibility"), width: pixel(100), renderCell: (row) => <Badge label={row.visibility} /> },
    ];
    if (canWrite) columns.push({ key: "actions", header: i18n.t("manager.capability.actions"), width: pixel(150), align: "end", renderCell: (row) => actionCell("skill", row, row.display_name || "未命名技能") });
    return columns;
  }, [actionCell, canWrite, i18n]);

  const connectorColumns = useMemo<TableColumn<ConnectorRow>[]>(() => {
    const columns: TableColumn<ConnectorRow>[] = [
      { key: "display_name", header: i18n.t("manager.capability.display_name"), width: proportional(1), renderCell: (row) => row.display_name || "未命名连接器" },
      { key: "grant_scope", header: i18n.t("manager.capability.grant_scope"), width: pixel(150), renderCell: (row) => <Badge label={row.grant_scope} /> },
      { key: "visibility", header: i18n.t("manager.capability.visibility"), width: pixel(100), renderCell: (row) => <Badge label={row.visibility} /> },
    ];
    if (canWrite) columns.push({ key: "actions", header: i18n.t("manager.capability.actions"), width: pixel(150), align: "end", renderCell: (row) => actionCell("connector", row, row.display_name || "未命名连接器") });
    return columns;
  }, [actionCell, canWrite, i18n]);

  const memoryColumns = useMemo<TableColumn<MemoryRow>[]>(() => {
    const columns: TableColumn<MemoryRow>[] = [
      { key: "display_name", header: i18n.t("manager.capability.display_name"), width: proportional(1), renderCell: (row) => row.display_name || "未命名记忆策略" },
      { key: "retention_days", header: i18n.t("manager.capability.retention_days"), width: pixel(130), renderCell: (row) => row.retention_days == null ? i18n.t("manager.capability.retention_days_unlimited") : row.retention_days },
      { key: "visibility", header: i18n.t("manager.capability.visibility"), width: pixel(100), renderCell: (row) => <Badge label={row.visibility} /> },
    ];
    if (canWrite) columns.push({ key: "actions", header: i18n.t("manager.capability.actions"), width: pixel(150), align: "end", renderCell: (row) => actionCell("memory", row, row.display_name || "未命名记忆策略") });
    return columns;
  }, [actionCell, canWrite, i18n]);

  const deleteSelected = async () => {
    if (!pendingDelete) return;
    const selected = pendingDelete;
    const operation = selected.kind === "skill"
      ? () => api.deleteSkill(selected.catalogId)
      : selected.kind === "connector"
        ? () => api.deleteConnector(selected.catalogId)
        : () => api.deleteMemoryPolicy(selected.catalogId);
    const success = await runWrite(operation, "manager.capability.delete_ok");
    if (success) setPendingDelete(null);
  };

  const editorTitle = editor.mode === "closed"
    ? ""
    : editor.mode === "edit"
      ? `编辑${editor.kind === "skill" ? "技能" : editor.kind === "connector" ? "连接器" : "记忆策略"}`
      : i18n.t(editor.kind === "skill"
        ? "manager.capability.add_skill"
        : editor.kind === "connector"
          ? "manager.capability.add_connector"
          : "manager.capability.add_memory_policy");

  return (
    <VStack as="section" gap={6}>
      <Heading level={1}>{i18n.t("manager.nav.capability")}</Heading>
      {notice && <Banner status="success" title={notice} />}
      {actionError && editor.mode === "closed" && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.capability.loading")}>
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={120} index={1} /></VStack>
        </Card>
      ) : (
        <>
          <CatalogSection title={i18n.t("manager.capability.skills_title", { count: skills.length })} addLabel={i18n.t("manager.capability.add_skill")} canWrite={canWrite} onAdd={() => openCreate("skill")}>
            <Table aria-label="技能目录" tableProps={{ "aria-label": "技能目录" }} data={skills as SkillRow[]} columns={skillColumns} idKey="catalog_id" hasHover emptyState={<EmptyState title={i18n.t("manager.capability.empty")} isCompact />} />
          </CatalogSection>
          <CatalogSection title={i18n.t("manager.capability.connectors_title", { count: connectors.length })} addLabel={i18n.t("manager.capability.add_connector")} canWrite={canWrite} onAdd={() => openCreate("connector")}>
            <Table aria-label="连接器目录" tableProps={{ "aria-label": "连接器目录" }} data={connectors as ConnectorRow[]} columns={connectorColumns} idKey="catalog_id" hasHover emptyState={<EmptyState title={i18n.t("manager.capability.empty")} isCompact />} />
          </CatalogSection>
          <CatalogSection title={i18n.t("manager.capability.memories_title", { count: memories.length })} addLabel={i18n.t("manager.capability.add_memory_policy")} canWrite={canWrite} onAdd={() => openCreate("memory")}>
            <Table aria-label="记忆策略目录" tableProps={{ "aria-label": "记忆策略目录" }} data={memories as MemoryRow[]} columns={memoryColumns} idKey="catalog_id" hasHover emptyState={<EmptyState title={i18n.t("manager.capability.empty")} isCompact />} />
          </CatalogSection>
        </>
      )}

      {editor.mode !== "closed" && (
        <AstryxDialog isOpen purpose="form" width={640} maxHeight="90vh" aria-label={editorTitle} onOpenChange={(isOpen) => { if (!isOpen) closeEditor(); }}>
          <Layout
            height="auto"
            header={<DialogHeader title={editorTitle} onOpenChange={(isOpen) => { if (!isOpen) closeEditor(); }} />}
            content={
              <LayoutContent>
                <form id="capability-editor-form" onSubmit={(event) => void submitEditor(event)}>
                  <VStack gap={4}>
                    {actionError && <Banner status="error" title={actionError} />}
                    <FormLayout>
                      <TextInput label={i18n.t("manager.capability.id")} value={editor.draft.id} onChange={(value) => updateDraft("id", value)} isRequired isDisabled={working} data-testid="field-id" />
                      <TextInput label={i18n.t("manager.capability.display_name")} value={editor.draft.displayName} onChange={(value) => updateDraft("displayName", value)} isDisabled={working} />
                      {editor.draft.kind === "skill" && (
                        <>
                          <TextInput label={i18n.t("manager.capability.version")} value={editor.draft.version} onChange={(value) => updateDraft("version", value)} isDisabled={working} />
                          <Selector label={i18n.t("manager.capability.install_policy")} options={SKILL_INSTALL_POLICIES.map((value) => ({ value, label: i18n.t(`manager.capability.install.${value}`) }))} value={editor.draft.install} onChange={(value) => updateDraft("install", value)} isDisabled={working} />
                          <Selector label={i18n.t("manager.capability.binding_policy")} options={SKILL_BINDING_POLICIES.map((value) => ({ value, label: i18n.t(`manager.capability.binding.${value}`) }))} value={editor.draft.binding} onChange={(value) => updateDraft("binding", value)} isDisabled={working} />
                        </>
                      )}
                      {editor.draft.kind === "connector" && (
                        <Selector label={i18n.t("manager.capability.grant_scope")} options={CONNECTOR_GRANT_SCOPES.map((value) => ({ value, label: i18n.t(`manager.capability.grant.${value}`) }))} value={editor.draft.grant} onChange={(value) => updateDraft("grant", value)} isDisabled={working} />
                      )}
                      {editor.draft.kind === "memory" && (
                        <TextInput label={i18n.t("manager.capability.retention_days")} value={editor.draft.retention} onChange={(value) => updateDraft("retention", value)} placeholder={i18n.t("manager.capability.retention_days_unlimited")} isDisabled={working} />
                      )}
                      <Selector label={i18n.t("manager.capability.visibility")} options={CATALOG_VISIBILITIES.map((value) => ({ value, label: i18n.t(`manager.capability.visibility.${value}`) }))} value={editor.draft.visibility} onChange={(value) => updateDraft("visibility", value)} isDisabled={working} />
                      {editor.draft.kind === "memory" && (
                        <>
                          <TextArea label="策略（JSON）" value={editor.draft.policy} onChange={(value) => updateDraft("policy", value)} rows={4} isDisabled={working} />
                          <TextArea label="种子记忆（JSON 数组）" value={editor.draft.seed} onChange={(value) => updateDraft("seed", value)} rows={4} isDisabled={working} />
                        </>
                      )}
                      <TextArea label={i18n.t("manager.capability.config")} value={editor.draft.config} onChange={(value) => updateDraft("config", value)} placeholder={i18n.t("manager.capability.config_placeholder")} rows={4} isDisabled={working} />
                    </FormLayout>
                  </VStack>
                </form>
              </LayoutContent>
            }
            footer={
              <LayoutFooter hasDivider>
                <HStack gap={2} justify="end">
                  <Button label={i18n.t("manager.capability.cancel")} variant="ghost" isDisabled={working} onClick={closeEditor} />
                  <Button label={i18n.t("manager.capability.save")} variant="primary" type="submit" form="capability-editor-form" isLoading={working} />
                </HStack>
              </LayoutFooter>
            }
          />
        </AstryxDialog>
      )}

      {pendingDelete && (
        <AlertDialog
          isOpen
          title={`删除 ${pendingDelete.displayName}？`}
          description={i18n.t("manager.capability.delete_confirm")}
          cancelLabel={i18n.t("manager.capability.delete_cancel")}
          actionLabel={i18n.t("manager.capability.delete_confirm_ok")}
          isActionLoading={working}
          onOpenChange={(isOpen) => { if (!isOpen && !working) setPendingDelete(null); }}
          onAction={() => void deleteSelected()}
        />
      )}
    </VStack>
  );
}

function CatalogSection({ title, addLabel, canWrite, onAdd, children }: {
  title: string;
  addLabel: string;
  canWrite: boolean;
  onAdd: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <Card padding={4}>
      <VStack gap={4}>
        <HStack justify="between" align="center" wrap="wrap" gap={2}>
          <Heading level={2}>{title}</Heading>
          {canWrite && <Button label={addLabel} size="sm" onClick={onAdd} />}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}
