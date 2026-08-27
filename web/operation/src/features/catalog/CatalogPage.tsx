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
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { RegisterForm } from "./register/RegisterForm";
import { TemplateLifecycleActions, type TemplateLifecycleAction } from "./TemplateLifecycleActions";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem, CatalogItemType, CatalogStatus, VisibilityLabel } from "./types";
import { labelToVisibleScope, visibilityLabel } from "./types";
import "./catalog.css";

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

function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  return (value.trim().slice(0, 2) || "AI").toUpperCase();
}

function CatalogAvatar({ name, src }: { name: string; src?: string }): ReactNode {
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc = src?.trim();
  return (
    <div data-ui="catalog-avatar" aria-hidden="true">
      {imageSrc && !imageFailed ? (
        <img src={imageSrc} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
      ) : initials(name)}
    </div>
  );
}

function ExpertCatalogCard({ item, canWrite, onAction }: {
  item: CatalogItem;
  canWrite: boolean;
  onAction: (action: TemplateLifecycleAction) => Promise<void>;
}): ReactNode {
  const status = statusPresentation(item.status);
  const model = item.platform_model_ref?.model_id || "待配置";
  const skillCount = item.platform_skill_refs?.length || item.skill_ids?.length || 0;
  const tags = [item.category, ...(item.tags ?? [])].filter(Boolean).slice(0, 3) as string[];
  const displayName = item.display_name || "未命名专家";
  return (
    <article data-ui="catalog-expert-card" aria-label={displayName}>
      <div data-ui="catalog-expert-card-hero">
        <CatalogAvatar name={displayName} src={item.avatar_url} />
        <div data-ui="catalog-expert-card-identity">
          <Link data-ui="catalog-expert-card-name" to={`/catalog/${item.catalog_type}/${item.template_id}`}>
            {displayName}
          </Link>
          <span data-ui="catalog-expert-card-role">{item.category || "数字员工"}</span>
        </div>
        <Badge label={status.label} variant={status.variant} />
      </div>

      <p data-ui="catalog-expert-card-description">
        {item.description || "把专业经验沉淀为可复用的数字员工能力。"}
      </p>

      <div data-ui="catalog-tags" aria-label="专家能力标签">
        {tags.length ? tags.map((tag) => <span key={tag}>{tag}</span>) : <span>通用能力</span>}
      </div>

      <dl data-ui="catalog-expert-card-stats">
        <div><dt>模型</dt><dd title={model}>{model}</dd></div>
        <div><dt>技能</dt><dd>{skillCount} 项</dd></div>
        <div><dt>可见范围</dt><dd>{visibilityText(visibilityLabel(item.visible_scope))}</dd></div>
      </dl>

      <div data-ui="catalog-expert-card-footer">
        <span data-ui="catalog-version">v{item.version}</span>
        {canWrite && <TemplateLifecycleActions item={item} onAction={onAction} />}
      </div>
    </article>
  );
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
      const searchable = [
        item.display_name,
        item.template_id,
        item.category,
        item.description,
        ...(item.tags ?? []),
        ...(item.platform_skill_refs ?? []).map((ref) => ref.skill_id),
      ].filter(Boolean).join(" ").toLocaleLowerCase();
      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
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

  const isExpertCatalog = catalogType === "expert_template";
  const summaryStats = [
    { key: "all", label: "全部专家", value: items.length },
    { key: "published", label: "已发布", value: items.filter((item) => item.status === "published").length },
    { key: "draft", label: "草稿", value: items.filter((item) => item.status === "draft").length },
    { key: "unpublished", label: "已下架", value: items.filter((item) => item.status === "unpublished").length },
  ];

  return (
    <VStack as="section" gap={6} data-ui={isExpertCatalog ? "catalog-page" : undefined}>
      <HStack justify="between" align="center" wrap="wrap" data-ui="catalog-page-header">
        <VStack gap={1}>
          <Heading level={1}>{i18n.t(titleKey)}</Heading>
          {isExpertCatalog && <Text color="secondary">把平台能力整理成可被企业直接使用的数字员工。</Text>}
        </VStack>
        <Button label={i18n.t(registerKey)} variant="primary" onClick={() => setShowRegister(true)} />
      </HStack>

      {isExpertCatalog && (
        <div data-ui="catalog-summary" aria-label="专家目录概览">
          {summaryStats.map((stat) => (
            <button
              key={stat.key}
              type="button"
              data-ui="catalog-summary-item"
              data-active={status === stat.key ? "true" : "false"}
              aria-pressed={status === stat.key}
              onClick={() => setStatus(stat.key)}
            >
              <strong>{stat.value}</strong>
              <span>{stat.label}</span>
            </button>
          ))}
        </div>
      )}

      {showRegister && (
        <RegisterForm
          api={api}
          catalogType={catalogType}
          onDone={() => { setShowRegister(false); void loadFirst(); }}
          onCancel={() => setShowRegister(false)}
        />
      )}

      <Card data-ui={isExpertCatalog ? "catalog-filter-card" : undefined}>
        <HStack gap={3} align="end" wrap="wrap">
          <TextInput
            label="搜索目录"
            isLabelHidden={isExpertCatalog}
            value={query}
            onChange={setQuery}
            placeholder={isExpertCatalog ? "搜索专家名称、分类或能力" : "名称或模板 ID"}
            startIcon="search"
            width={isExpertCatalog ? "100%" : 280}
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
        isExpertCatalog ? (
          <div data-ui="catalog-expert-grid" data-testid="catalog-expert-grid">
            {filteredItems.map((item) => (
              <ExpertCatalogCard
                key={`${item.template_id}@${item.version}`}
                item={item}
                canWrite={canWrite}
                onAction={(action) => runLifecycle(item, action)}
              />
            ))}
            {!filteredItems.length && (
              <div data-ui="catalog-grid-empty">
                <EmptyState title={i18n.t("operation.catalog.none")} description="调整筛选条件后重试。" isCompact />
              </div>
            )}
          </div>
        ) : (
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
        )
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
