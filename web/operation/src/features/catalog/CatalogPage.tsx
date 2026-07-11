/** 运营端目录治理列表。 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, PlatformRole, hasRole } from "@aiteam/shared";
import { Badge, type BadgeVariant } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Selector } from "@astryxdesign/core/Selector";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { RegisterForm } from "./RegisterForm";
import { TemplateLifecycleActions, type TemplateLifecycleAction } from "./TemplateLifecycleActions";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem, CatalogItemType, CatalogStatus, VisibilityLabel } from "./types";
import { labelToVisibleScope, visibilityLabel } from "./types";

type CatalogRow = CatalogItem & Record<string, unknown>;

const STATUS_OPTIONS = [
  { value: "all", label: "全部状态" },
  { value: "draft", label: "草稿" },
  { value: "published", label: "已发布" },
  { value: "unpublished", label: "已下架" },
];

function statusPresentation(status: CatalogStatus): { label: string; variant: BadgeVariant } {
  if (status === "published") return { label: "已发布", variant: "success" };
  if (status === "unpublished") return { label: "已下架", variant: "neutral" };
  return { label: "草稿", variant: "warning" };
}

function visibilityText(label: VisibilityLabel): string {
  if (label === "public") return "公开";
  if (label === "enterprise") return "企业可见";
  return "隐藏";
}

export interface CatalogPageProps {
  catalogType: CatalogItemType;
  titleKey: string;
  registerKey: string;
}

export function CatalogPage({ catalogType, titleKey, registerKey }: CatalogPageProps): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const api = useCatalogApi();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.list(undefined, catalogType);
      setItems(result.items.filter((item) => item.catalog_type === catalogType));
      setNextCursor(result.page.next_cursor);
      setHasMore(result.page.has_more);
    } catch (err) {
      setItems([]);
      setError(err instanceof ApiError ? err.message : i18n.t("operation.catalog.loadError"));
    } finally {
      setLoading(false);
    }
  }, [api, catalogType, i18n]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const result = await api.list(nextCursor, catalogType);
      setItems((previous) => [
        ...previous,
        ...result.items.filter((item) => item.catalog_type === catalogType),
      ]);
      setNextCursor(result.page.next_cursor);
      setHasMore(result.page.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("operation.catalog.loadError"));
    } finally {
      setLoadingMore(false);
    }
  }, [api, catalogType, hasMore, i18n, nextCursor]);

  const runLifecycle = useCallback(async (item: CatalogItem, action: TemplateLifecycleAction) => {
    try {
      if (action === "publish") {
        await api.publish(item.catalog_type, item.template_id);
      } else if (action === "unpublish") {
        await api.unpublish(item.catalog_type, item.template_id);
      } else if (action === "hide") {
        await api.setVisibility(item.catalog_type, item.template_id, labelToVisibleScope("hidden"));
      }
      await loadFirst();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : i18n.t("operation.catalog.loadError");
      throw err instanceof Error ? err : new Error(message);
    }
  }, [api, i18n, loadFirst]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      const matchesStatus = status === "all" || item.status === status;
      const matchesQuery = !normalizedQuery
        || item.display_name.toLocaleLowerCase().includes(normalizedQuery)
        || item.template_id.toLocaleLowerCase().includes(normalizedQuery);
      return matchesStatus && matchesQuery;
    });
  }, [items, query, status]);

  const columns = useMemo<TableColumn<CatalogRow>[]>(() => {
    const base: TableColumn<CatalogRow>[] = [
      {
        key: "display_name",
        header: "名称",
        width: proportional(2),
        renderCell: (item) => (
          <VStack gap={0}>
            <Link to={`/catalog/${item.catalog_type}/${item.template_id}`}>{item.display_name}</Link>
            <span>{item.template_id}</span>
          </VStack>
        ),
      },
      {
        key: "status",
        header: "状态",
        width: pixel(110),
        renderCell: (item) => {
          const presentation = statusPresentation(item.status);
          return <Badge label={presentation.label} variant={presentation.variant} />;
        },
      },
      {
        key: "visible_scope",
        header: "可见范围",
        width: pixel(120),
        renderCell: (item) => visibilityText(visibilityLabel(item.visible_scope)),
      },
      {
        key: "version",
        header: "版本",
        width: pixel(100),
      },
    ];
    if (canWrite) {
      base.push({
        key: "actions",
        header: "操作",
        width: pixel(220),
        align: "end",
        resizable: false,
        renderCell: (item) => (
          <TemplateLifecycleActions item={item} onAction={(action) => runLifecycle(item, action)} />
        ),
      });
    }
    return base;
  }, [canWrite, runLifecycle]);

  if (!session || !canWrite) {
    return (
      <EmptyState headingLevel={1} title={i18n.t("operation.catalog.noAccess")} />
    );
  }

  return (
    <VStack as="section" gap={6}>
      <HStack justify="between" align="center" wrap="wrap">
        <Heading level={1}>{i18n.t(titleKey)}</Heading>
        <Button label={i18n.t(registerKey)} variant="primary" onClick={() => setShowRegister(true)} />
      </HStack>

      {showRegister && (
        <RegisterForm
          api={api}
          catalogType={catalogType}
          onDone={() => { setShowRegister(false); void loadFirst(); }}
          onCancel={() => setShowRegister(false)}
        />
      )}

      <Card>
        <HStack gap={3} align="end" wrap="wrap">
          <TextInput
            label="搜索目录"
            value={query}
            onChange={setQuery}
            placeholder="名称或模板 ID"
            startIcon="search"
            width={280}
          />
          <Selector
            label="目录状态"
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            width={160}
          />
        </HStack>
      </Card>

      {error && <Banner status="error" title={error} />}

      {loading ? (
        <Card role="status" aria-label="目录加载中">
          <VStack gap={2}>
            <Skeleton height={36} />
            <Skeleton height={36} index={1} />
            <Skeleton height={36} index={2} />
          </VStack>
        </Card>
      ) : !error ? (
        <Card padding={0}>
          <Table
            aria-label="目录列表"
            tableProps={{ "aria-label": "目录列表" }}
            data={filteredItems as CatalogRow[]}
            columns={columns}
            idKey="template_id"
            hasHover
            emptyState={<EmptyState title={i18n.t("operation.catalog.none")} description="调整筛选条件后重试。" isCompact />}
          />
        </Card>
      ) : null}

      {hasMore && (
        <Button
          label={loadingMore ? i18n.t("operation.catalog.loadingMore") : i18n.t("operation.catalog.loadMore")}
          variant="ghost"
          isDisabled={loadingMore}
          onClick={() => void loadMore()}
        />
      )}
    </VStack>
  );
}
