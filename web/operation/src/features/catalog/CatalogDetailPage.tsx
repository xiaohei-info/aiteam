/** 运营端目录详情：路由加载、编辑保存与工作台容器。 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { ApiError, PlatformRole, hasRole } from "@aiteam/shared";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { TemplateOverview, visibilityScopeFor } from "./TemplateOverview";
import { TemplateVersionPanel, type DetailTab } from "./TemplateVersionPanel";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem, CatalogItemType } from "./types";

export function CatalogDetailPage(): ReactNode {
  const { catalog_type, template_id } = useParams<{ catalog_type: string; template_id: string }>();
  const { session } = useSession();
  const i18n = useI18n();
  const api = useCatalogApi();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR);
  const requestId = useRef(0);
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [draft, setDraft] = useState<CatalogItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [pendingHidden, setPendingHidden] = useState(false);
  const [visibilityWorking, setVisibilityWorking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");

  useEffect(() => {
    if (!catalog_type || !template_id) {
      setLoading(false);
      return;
    }
    const currentRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    setEditError(null);
    setVisibilityError(null);
    setPendingHidden(false);
    setSaving(false);
    setVisibilityWorking(false);
    setEditing(false);
    setActiveTab("overview");
    api.get(catalog_type as CatalogItemType, template_id)
      .then((data) => {
        if (requestId.current !== currentRequest) return;
        setItem(data);
        setDraft(data ? { ...data } : null);
        setLoading(false);
      })
      .catch((err) => {
        if (requestId.current !== currentRequest) return;
        setError(err instanceof ApiError ? err.message : "加载失败");
        setLoading(false);
      });
  }, [api, catalog_type, template_id]);

  const doVisibility = useCallback(async (next: "public" | "enterprise" | "hidden") => {
    if (!catalog_type || !template_id) return;
    const currentRequest = requestId.current;
    setVisibilityWorking(true);
    setVisibilityError(null);
    try {
      const updated = await api.setVisibility(catalog_type as CatalogItemType, template_id, visibilityScopeFor(next));
      if (requestId.current !== currentRequest) return;
      if (updated) setItem(updated);
      setPendingHidden(false);
    } catch (err) {
      if (requestId.current === currentRequest) {
        setVisibilityError(err instanceof Error ? err.message : "操作失败");
      }
    } finally {
      if (requestId.current === currentRequest) setVisibilityWorking(false);
    }
  }, [api, catalog_type, template_id]);

  const requestVisibilityChange = useCallback((next: "public" | "enterprise" | "hidden") => {
    if (next === "hidden") {
      setVisibilityError(null);
      setPendingHidden(true);
      return;
    }
    void doVisibility(next);
  }, [doVisibility]);

  const handleSave = useCallback(async () => {
    if (!catalog_type || !template_id || !draft) return;
    const currentRequest = requestId.current;
    setSaving(true);
    setEditError(null);
    try {
      const changes: Record<string, unknown> = { display_name: draft.display_name };
      if (draft.catalog_type === "expert_template") {
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
        changes.planner_template_id = draft.planner_template_id ?? "";
        changes.knowledge_refs = draft.knowledge_refs ?? [];
        changes.skill_refs = draft.skill_refs ?? [];
        changes.planner_prompt = draft.planner_prompt ?? "";
        changes.subtask_prompt = draft.subtask_prompt ?? "";
        changes.aggregate_prompt = draft.aggregate_prompt ?? "";
        changes.default_grants = draft.default_grants ?? null;
        changes.tags = draft.tags ?? [];
      }
      const updated = await api.updateEntry(catalog_type as CatalogItemType, template_id, changes);
      if (requestId.current !== currentRequest) return;
      if (updated) {
        setItem(updated);
        setDraft({ ...updated });
      }
      setEditing(false);
    } catch (err) {
      if (requestId.current === currentRequest) {
        setEditError(err instanceof Error ? err.message : "保存失败");
      }
    } finally {
      if (requestId.current === currentRequest) setSaving(false);
    }
  }, [api, catalog_type, draft, template_id]);

  if (loading) {
    return (
      <Card role="status" aria-label="目录详情加载中">
        <VStack gap={2}><Text color="secondary">加载中…</Text><Skeleton height={36} /><Skeleton height={160} index={1} /></VStack>
      </Card>
    );
  }

  if (error) return <Banner status="error" title={error} />;
  if (!item || !draft) return <EmptyState title={i18n.t("operation.catalog.notFound")} />;

  const listPath = item.catalog_type === "expert_template" ? "/experts" : "/industry-solutions";
  const listName = item.catalog_type === "expert_template" ? "专家目录" : "行业方案目录";

  return (
    <VStack as="section" gap={6}>
      <Breadcrumbs label="面包屑" variant="supporting">
        <BreadcrumbItem href={listPath}>{listName}</BreadcrumbItem>
        <BreadcrumbItem isCurrent>{item.template_id}</BreadcrumbItem>
      </Breadcrumbs>

      <HStack justify="between" align="center" wrap="wrap">
        <VStack gap={1}>
          <Heading level={1}>{item.display_name}</Heading>
        </VStack>
        {canWrite && !editing && <Button label="编辑" variant="secondary" size="sm" onClick={() => setEditing(true)} />}
      </HStack>

      {visibilityError && !pendingHidden && <Banner status="error" title={visibilityError} />}

      <TemplateVersionPanel item={item} activeTab={activeTab} onTabChange={setActiveTab} />

      {activeTab === "overview" && (
        <TemplateOverview
          item={item}
          draft={draft}
          editing={editing}
          canWrite={canWrite}
          visibilityChanging={visibilityWorking}
          onChange={setDraft}
          onVisibilityChange={requestVisibilityChange}
        />
      )}

      {editing && activeTab === "overview" && (
        <Card>
          <VStack gap={3}>
            {editError && <Banner status="error" title={editError} />}
            <HStack gap={2}>
              <Button label={saving ? "保存中…" : "保存"} variant="primary" size="sm" isDisabled={saving} onClick={() => void handleSave()} />
              <Button label="取消" variant="ghost" size="sm" isDisabled={saving} onClick={() => {
                setDraft({ ...item });
                setEditing(false);
                setEditError(null);
              }} />
            </HStack>
          </VStack>
        </Card>
      )}

      <AlertDialog
        isOpen={pendingHidden}
        onOpenChange={(open) => {
          if (!open && !visibilityWorking) {
            setPendingHidden(false);
            setVisibilityError(null);
          }
        }}
        title="隐藏模板"
        description={`隐藏后模板不再向企业展示。${visibilityError ? ` ${visibilityError}` : ""}`}
        cancelLabel="取消"
        actionLabel="确认隐藏"
        actionVariant="destructive"
        isActionLoading={visibilityWorking}
        onAction={() => void doVisibility("hidden")}
      />
    </VStack>
  );
}
