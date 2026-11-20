/**
 * 能力目录页：技能、连接器和记忆策略的租户内 CRUD。
 * 技能按技能本身编辑（SKILL.md + 附带文件，见 EnterpriseSkillDialogs）；连接器与记忆策略仍用通用表单。
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, CapabilityOrigin, EnterpriseRole, hasRole, skillSummary } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog as AstryxDialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { CapabilityAssistDialog } from "../capability-assist/CapabilityAssistDialog";
import { handoffState, MCP_PAGE, readHandoff, skillImportInitial } from "../capability-assist/handoff";
import type { CapabilityAssistCandidate } from "../capability-assist/types";
import { useCapabilityAssistApi } from "../capability-assist/useCapabilityAssistApi";
import { useMe } from "../../shell/useMe";
import type { PlatformSkillMarketItem } from "../skill-market/types";
import { useSkillMarketApi } from "../skill-market/useSkillMarketApi";
import { EnterpriseSkillEditor, EnterpriseSkillImport, isPlatformSkill, skillTitle } from "./EnterpriseSkillDialogs";
import { useCapabilityApi } from "./useCapabilityApi";
import type {
  CatalogVisibility,
  ConnectorCatalog,
  ConnectorCatalogIn,
  ConnectorGrantScope,
  MemoryPolicyCatalog,
  MemoryPolicyCatalogIn,
  SkillCatalog,
} from "./types";
import { CATALOG_VISIBILITIES, CONNECTOR_GRANT_SCOPES } from "./types";

type Kind = "skill" | "connector" | "memory";
/** 通用表单只剩连接器与记忆策略；技能用技能编辑器。 */
type EditorKind = Exclude<Kind, "skill">;

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

type Draft = ConnectorDraft | MemoryDraft;
type EditorState =
  | { mode: "closed" }
  | { mode: "create"; kind: EditorKind; draft: Draft }
  | { mode: "edit"; kind: EditorKind; catalogId: string; draft: Draft };

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

function emptyDraft(kind: EditorKind): Draft {
  if (kind === "connector") {
    return { kind, id: "", displayName: "", grant: "tenant_wide", visibility: "private", config: "" };
  }
  return { kind, id: "", displayName: "", retention: "", visibility: "private", config: "", policy: "", seed: "[]" };
}

function draftFrom(kind: EditorKind, item: ConnectorCatalog | MemoryPolicyCatalog): Draft {
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

interface CapabilityPageProps {
  /** 嵌在「技能管理 · 企业技能」里：只显示技能目录，不显示页标题（连接器、记忆另有菜单）。 */
  skillsOnly?: boolean;
}

export function CapabilityPage({ skillsOnly = false }: CapabilityPageProps = {}): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, EnterpriseRole.OWNER, EnterpriseRole.ENTERPRISE_ADMIN);
  const api = useCapabilityApi();
  const [skills, setSkills] = useState<SkillCatalog[]>([]);
  /** 平台技能市场：用来提示「平台有新版本」（读不到不影响页面）。 */
  const marketApi = useSkillMarketApi();
  const [market, setMarket] = useState<PlatformSkillMarketItem[]>([]);
  const { me } = useMe();
  const enterpriseNamespace = me?.enterprise_name || me?.enterprise_code || "";
  const [connectors, setConnectors] = useState<ConnectorCatalog[]>([]);
  const [memories, setMemories] = useState<MemoryPolicyCatalog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: "closed" });
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [working, setWorking] = useState(false);
  /** 导入对话框；从「让模型帮我找」来时带着预填的来源与地址。 */
  const [importing, setImporting] = useState<{ initial?: { source: "url" | "clawhub"; url: string } } | null>(null);
  const [assisting, setAssisting] = useState(false);
  /** 技能编辑器：row 为空时是「从零写一个」。 */
  const [skillEditor, setSkillEditor] = useState<{ row?: SkillCatalog } | null>(null);
  const assistApi = useCapabilityAssistApi();
  const navigate = useNavigate();
  const location = useLocation();

  // MCP 市场页的「让模型帮我找」选中了技能候选：在这里打开导入对话框，然后清掉路由 state，刷新不再重复弹出。
  useEffect(() => {
    const candidate = readHandoff(location.state, "skill");
    if (!candidate) return;
    setImporting({ initial: skillImportInitial(candidate) });
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, location.pathname, navigate]);

  const pickCandidate = (candidate: CapabilityAssistCandidate) => {
    setAssisting(false);
    if (candidate.kind === "skill") setImporting({ initial: skillImportInitial(candidate) });
    else navigate(MCP_PAGE, { state: handoffState(candidate) });
  };

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
      if (skillItems.some(isPlatformSkill)) setMarket(await marketApi.list().catch(() => []));
      setConnectors(connectorItems);
      setMemories(memoryItems);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("manager.capability.load_error"));
    } finally {
      setLoading(false);
    }
  }, [api, marketApi, i18n]);

  useEffect(() => { void load(); }, [load]);

  /** 平台技能有新版本时的市场条目（按平台技能 id 对上）。 */
  const updateFor = useCallback((row: SkillCatalog): PlatformSkillMarketItem | null => {
    if (!isPlatformSkill(row)) return null;
    const item = market.find((entry) => entry.skill_id === row.config?.source_skill_id);
    return item?.update_available && item.published_version && item.published_version !== row.version ? item : null;
  }, [market]);

  const [updating, setUpdating] = useState<string | null>(null);
  const updateSkill = useCallback(async (row: SkillCatalog, item: PlatformSkillMarketItem) => {
    setUpdating(row.catalog_id);
    setActionError(null);
    setNotice(null);
    try {
      await marketApi.install(item);
      setNotice(`已把 ${skillTitle(row)} 更新到 v${item.published_version}，专家和成员下次对话起用新版本`);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError || err instanceof Error ? err.message : "更新失败，请重试");
    } finally {
      setUpdating(null);
    }
  }, [marketApi, load]);

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

  const openCreate = (kind: EditorKind) => {
    setActionError(null);
    setEditor({ mode: "create", kind, draft: emptyDraft(kind) });
  };
  const openEdit = (kind: EditorKind, item: ConnectorCatalog | MemoryPolicyCatalog) => {
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

    if (editor.kind === "connector") {
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

  const actionCell = useCallback((kind: EditorKind, item: ConnectorCatalog | MemoryPolicyCatalog, name: string) => (
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

  // 技能按技能本身展示：名称、说明（SKILL.md 的 description）、版本、来源，加两项真正生效的设置。
  const skillColumns = useMemo<TableColumn<SkillRow>[]>(() => {
    const columns: TableColumn<SkillRow>[] = [
      { key: "display_name", header: "名称", width: proportional(1), renderCell: (row) => (
        <VStack gap={0.5}>
          <Text>{skillTitle(row) || "未命名技能"}</Text>
          <CapabilityOrigin provenance={row.provenance} />
        </VStack>
      ) },
      { key: "description", header: "说明", width: proportional(2), renderCell: (row) => <Text color="secondary" style={CLAMP_2}>{skillDescription(row) || "—"}</Text> },
      { key: "version", header: i18n.t("manager.capability.version"), width: pixel(130) },
      { key: "source", header: "来源", width: pixel(150), renderCell: (row) => {
        const update = updateFor(row);
        return (
          <VStack gap={1} align="start">
            <Badge label={skillSourceLabel(row.config)} />
            {update && <Badge label={`平台有新版本 v${update.published_version}`} variant="warning" />}
          </VStack>
        );
      } },
      { key: "member_install", header: "成员自装", width: pixel(110), renderCell: (row) => row.visibility === "private" ? <Badge label="仅配给专家" /> : <Badge label="可以" variant="success" /> },
      { key: "status", header: "状态", width: pixel(100), renderCell: (row) => { const status = skillStatus(row); return <Badge label={status.label} variant={status.variant} />; } },
    ];
    if (canWrite) columns.push({
      key: "actions", header: i18n.t("manager.capability.actions"), width: pixel(150), align: "end",
      renderCell: (row) => (
        <HStack gap={1} justify="end">
          {(() => {
            const update = updateFor(row);
            return update && (
              <Button label="更新" variant="primary" size="sm" isLoading={updating === row.catalog_id} isDisabled={updating !== null}
                onClick={() => void updateSkill(row, update)} />
            );
          })()}
          <Button label={i18n.t("manager.capability.edit")} variant="ghost" size="sm" onClick={() => { setNotice(null); setSkillEditor({ row }); }} />
          {!isPlatformSkill(row) && (
            <Button label={i18n.t("manager.capability.delete")} variant="destructive" size="sm"
              onClick={() => setPendingDelete({ kind: "skill", catalogId: row.catalog_id, displayName: row.display_name || "未命名技能" })} />
          )}
        </HStack>
      ),
    });
    return columns;
  }, [canWrite, i18n, updateFor, updateSkill, updating]);

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
      ? `编辑${editor.kind === "connector" ? "连接器" : "记忆策略"}`
      : i18n.t(editor.kind === "connector" ? "manager.capability.add_connector" : "manager.capability.add_memory_policy");

  return (
    <VStack as="section" gap={6}>
      {!skillsOnly && <Heading level={1}>{i18n.t("manager.nav.capability")}</Heading>}
      {notice && <Banner status="success" title={notice} />}
      {actionError && editor.mode === "closed" && <Banner status="error" title={actionError} />}
      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label={i18n.t("manager.capability.loading")}>
          <VStack gap={2}><Skeleton height={36} /><Skeleton height={120} index={1} /></VStack>
        </Card>
      ) : (
        <>
          <CatalogSection
            title={i18n.t("manager.capability.skills_title", { count: skills.length })} addLabel={i18n.t("manager.capability.add_skill")} canWrite={canWrite} onAdd={() => setSkillEditor({})}
            addMenu={(
              <DropdownMenu button={{ label: i18n.t("manager.capability.add_skill"), size: "sm" }} menuWidth={200}>
                <DropdownMenuItem label="导入技能" onClick={() => { setNotice(null); setImporting({}); }} />
                <DropdownMenuItem label="让模型帮我找" onClick={() => { setNotice(null); setAssisting(true); }} />
                <DropdownMenuItem label="从零写一个" onClick={() => { setNotice(null); setSkillEditor({}); }} />
              </DropdownMenu>
            )}
          >
            <Table aria-label="技能目录" tableProps={{ "aria-label": "技能目录" }} data={skills as SkillRow[]} columns={skillColumns} idKey="catalog_id" hasHover emptyState={<EmptyState title={i18n.t("manager.capability.empty")} isCompact />} />
          </CatalogSection>
          {!skillsOnly && <>
          <CatalogSection title={i18n.t("manager.capability.connectors_title", { count: connectors.length })} addLabel={i18n.t("manager.capability.add_connector")} canWrite={canWrite} onAdd={() => openCreate("connector")}>
            <Table aria-label="连接器目录" tableProps={{ "aria-label": "连接器目录" }} data={connectors as ConnectorRow[]} columns={connectorColumns} idKey="catalog_id" hasHover emptyState={<EmptyState title={i18n.t("manager.capability.empty")} isCompact />} />
          </CatalogSection>
          <CatalogSection title={i18n.t("manager.capability.memories_title", { count: memories.length })} addLabel={i18n.t("manager.capability.add_memory_policy")} canWrite={canWrite} onAdd={() => openCreate("memory")}>
            <Table aria-label="记忆策略目录" tableProps={{ "aria-label": "记忆策略目录" }} data={memories as MemoryRow[]} columns={memoryColumns} idKey="catalog_id" hasHover emptyState={<EmptyState title={i18n.t("manager.capability.empty")} isCompact />} />
          </CatalogSection>
          </>}
        </>
      )}

      {assisting && <CapabilityAssistDialog api={assistApi} onClose={() => setAssisting(false)} onUse={pickCandidate} />}

      {importing && (
        <EnterpriseSkillImport
          api={api}
          initial={importing.initial}
          onClose={() => setImporting(null)}
          onImported={() => { setNotice("技能已导入企业目录"); void load(); }}
        />
      )}

      {skillEditor && (
        <EnterpriseSkillEditor
          api={api}
          row={skillEditor.row}
          existingIds={new Set(skills.map((item) => item.skill_id))}
          enterpriseNamespace={enterpriseNamespace}
          onClose={() => setSkillEditor(null)}
          onSaved={(message) => { setSkillEditor(null); setNotice(message); void load(); }}
        />
      )}

      {editor.mode !== "closed" && (
        <AstryxDialog isOpen purpose="form" width={640} maxHeight="90vh" aria-label={editorTitle} onOpenChange={(isOpen) => { if (!isOpen) closeEditor(); }}>
          <Layout
            header={<DialogHeader title={editorTitle} onOpenChange={(isOpen) => { if (!isOpen) closeEditor(); }} />}
            content={
              <LayoutContent>
                <form id="capability-editor-form" onSubmit={(event) => void submitEditor(event)}>
                  <VStack gap={4}>
                    {actionError && <Banner status="error" title={actionError} />}
                    <FormLayout>
                      <TextInput label={i18n.t("manager.capability.id")} value={editor.draft.id} onChange={(value) => updateDraft("id", value)} isRequired isDisabled={working} data-testid="field-id" />
                      <TextInput label={i18n.t("manager.capability.display_name")} value={editor.draft.displayName} onChange={(value) => updateDraft("displayName", value)} isDisabled={working} />
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

const CLAMP_2 = { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } as const;

/** 说明取自 SKILL.md 的 description（导入时也存了一份在 config 里）。 */
function skillDescription(row: SkillCatalog): string {
  return skillSummary(row.files).description || String(row.config?.description ?? "");
}

function skillStatus(row: SkillCatalog): { label: string; variant: "success" | "warning" | "error" | "neutral" } {
  if (row.binding_policy === "disabled") return { label: "已停用", variant: "warning" };
  if (row.package_status === "invalid") return { label: "包无效", variant: "error" };
  if (row.package_status === "draft") return { label: "草稿", variant: "neutral" };
  return { label: "可用", variant: "success" };
}

/** 技能来源：平台技能市场 / 自定义导入 / 网址 / ClawHub；手动建的条目算自定义。 */
function skillSourceLabel(config: Record<string, unknown> | undefined): string {
  const source = config?.source;
  if (source === "operator") return "平台市场";
  if (source === "url") return "网址";
  if (source === "clawhub") return "ClawHub";
  return "自定义";
}

function CatalogSection({ title, addLabel, canWrite, onAdd, addMenu, children }: {
  title: string;
  addLabel: string;
  canWrite: boolean;
  onAdd: () => void;
  /** 有多种添加方式时替换单个「添加」按钮。 */
  addMenu?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <Card padding={4}>
      <VStack gap={4}>
        <HStack justify="between" align="center" wrap="wrap" gap={2}>
          <Heading level={2}>{title}</Heading>
          {canWrite && (addMenu ?? <Button label={addLabel} size="sm" onClick={onAdd} />)}
        </HStack>
        {children}
      </VStack>
    </Card>
  );
}
