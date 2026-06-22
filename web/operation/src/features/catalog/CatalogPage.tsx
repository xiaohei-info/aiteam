/**
 * 目录治理列表页（W-O.3 F03）。
 * 路径对齐后端 routes_catalog.py。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ApiError, PlatformRole, hasRole } from "@aiteam/shared";
import { Button, GlassPanel, Select, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import { RegisterForm } from "./RegisterForm";
import type { CatalogItem, CatalogItemType, VisibilityLabel } from "./types";
import { visibilityLabel, labelToVisibleScope } from "./types";

function StatusBadge({ status }: { status: string }): ReactNode {
  if (status === "published") return <span className="text-success">已发布</span>;
  if (status === "unpublished") return <span className="text-text-muted">已下架</span>;
  return <span className="text-warning">草稿</span>;
}

function visibilityLabelText(label: VisibilityLabel): string {
  if (label === "public") return "公开";
  if (label === "enterprise") return "企业可见";
  return "隐藏";
}

export function CatalogPage(): ReactNode {
  const { session } = useSession();
  const i18n = useI18n();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN);
  const api = useCatalogApi();

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.list();
      setItems(r.items);
      setNextCursor(r.page.next_cursor);
      setHasMore(r.page.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("operation.catalog.loadError"));
    } finally {
      setLoading(false);
    }
  }, [api, i18n]);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor) return;
    setLoadingMore(true);
    try {
      const r = await api.list(nextCursor);
      setItems((prev) => [...prev, ...r.items]);
      setNextCursor(r.page.next_cursor);
      setHasMore(r.page.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("operation.catalog.loadError"));
    } finally {
      setLoadingMore(false);
    }
  }, [api, hasMore, nextCursor, i18n]);

  const doAction = useCallback(async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await loadFirst();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : i18n.t("operation.catalog.loadError"));
    }
  }, [loadFirst, i18n]);

  if (!session || !hasRole(session, PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR)) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("operation.catalog.noAccess")}
        </GlassPanel>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">目录治理</h1>

      {canWrite && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setShowRegister(true)}>
            {i18n.t("operation.catalog.register")}
          </Button>
        </div>
      )}

      {showRegister && (
        <RegisterForm
          api={api}
          onDone={() => { setShowRegister(false); void loadFirst(); }}
          onCancel={() => setShowRegister(false)}
        />
      )}

      {(error ?? actionError) && (
        <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">
          {error ?? actionError}
        </GlassPanel>
      )}

      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">
          {i18n.t("operation.catalog.loading")}
        </GlassPanel>
      ) : items.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("operation.catalog.none")}
        </GlassPanel>
      ) : (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead>
              <tr>
                <th>名称</th><th>类型</th><th>状态</th><th>可见范围</th>
                {canWrite && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const vLabel = visibilityLabel(item.visible_scope);
                return (
                  <tr key={`${item.catalog_type}-${item.template_id}`}>
                    <td>
                      <Link
                        to={`/catalog/${item.catalog_type}/${item.template_id}`}
                        className="text-text-primary hover:text-gold"
                      >
                        {item.display_name}
                      </Link>
                    </td>
                    <td>{item.catalog_type === "expert_template" ? "专家模板" : "行业方案"}</td>
                    <td><StatusBadge status={item.status} /></td>
                    <td>{visibilityLabelText(vLabel)}</td>
                    {canWrite && (
                      <td className="flex flex-wrap gap-sm">
                        {item.status !== "published" && (
                          <Button variant="ghost" size="sm"
                            onClick={() => doAction(() => api.publish(item.catalog_type, item.template_id))}>
                            发布
                          </Button>
                        )}
                        {item.status === "published" && (
                          <Button variant="ghost" size="sm"
                            onClick={() => doAction(() => api.unpublish(item.catalog_type, item.template_id))}>
                            下架
                          </Button>
                        )}
                        <Select
                          value={vLabel}
                          onChange={(e) => doAction(() =>
                            api.setVisibility(item.catalog_type, item.template_id,
                              labelToVisibleScope(e.target.value as VisibilityLabel))
                          )}
                        >
                          <option value="public">公开</option>
                          <option value="enterprise">企业可见</option>
                          <option value="hidden">隐藏</option>
                        </Select>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </GlassPanel>
      )}

      {hasMore && (
        <Button type="button" variant="ghost" size="sm" className="self-start"
          onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? i18n.t("operation.catalog.loadingMore") : i18n.t("operation.catalog.loadMore")}
        </Button>
      )}
    </section>
  );
}
