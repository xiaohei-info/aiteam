/**
 * 目录治理主列表页（F03）。
 *
 * 列表 + cursor 翻页（listGet → page.next_cursor 触 loadMore）；
 * role-state 门控：system_admin 可写，system_operator 只读。
 * 黑金玻璃质感，复用 shared 组件（GlassPanel/Button/Select/Table）。
 */
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { hasRole, ApiError, PlatformRole } from "@aiteam/shared";
import { Button, GlassPanel, Select, Table } from "@aiteam/shared/ui";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem, Visibility } from "./types";
import { RegisterForm } from "./RegisterForm";

export function CatalogPage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN);

  if (!hasRole(session, PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR)) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          无权限访问目录治理。
        </GlassPanel>
      </section>
    );
  }

  return <CatalogList canWrite={canWrite} />;
}

function CatalogList({ canWrite }: { canWrite: boolean }): ReactNode {
  const api = useCatalogApi();
  const i18n = useI18n();

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.list();
      setItems(result.items);
      setNextCursor(result.page.next_cursor);
      setHasMore(result.page.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await api.list(nextCursor);
      setItems((prev) => [...prev, ...result.items]);
      setNextCursor(result.page.next_cursor);
      setHasMore(result.page.has_more);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  }, [api, nextCursor, loadingMore]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  const doAction = useCallback(
    async (action: () => Promise<unknown>) => {
      if (!canWrite) return;
      setActionError(null);
      try {
        await action();
        await loadFirst();
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : "操作失败");
      }
    },
    [canWrite, loadFirst],
  );

  return (
    <section className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-center justify-between gap-md">
        <h1 className="m-0 text-xl font-bold text-text-primary">
          {i18n.t("operation.nav.catalog")}
        </h1>
        {canWrite && (
          <Button type="button" size="sm" onClick={() => setShowRegister(true)}>
            注册模板/方案
          </Button>
        )}
      </div>

      {actionError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {actionError}
        </p>
      )}

      {showRegister && (
        <RegisterForm
          onSuccess={() => {
            setShowRegister(false);
            loadFirst();
          }}
          onCancel={() => setShowRegister(false)}
        />
      )}

      {loading && <p className="m-0 text-sm text-text-secondary">加载中…</p>}

      {error && (
        <p className="m-0 text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      {!loading && !error && items.length === 0 && (
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          暂无目录项。
        </GlassPanel>
      )}

      {items.length > 0 && (
        <GlassPanel className="overflow-hidden rounded-window">
          <Table>
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>状态</th>
                <th>可见范围</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <Link
                      to={`/catalog/${item.id}`}
                      className="text-text-primary hover:text-gold"
                    >
                      {item.name}
                    </Link>
                  </td>
                  <td>
                    {item.type === "expert_template" ? "专家模板" : "行业方案"}
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{visibilityLabel(item.visibility)}</td>
                  <td className="flex flex-wrap gap-sm">
                    {canWrite && item.status !== "published" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => doAction(() => api.publish(item.id))}
                      >
                        发布
                      </Button>
                    )}
                    {canWrite && item.status === "published" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => doAction(() => api.unpublish(item.id))}
                      >
                        下架
                      </Button>
                    )}
                    {canWrite && (
                      <Select
                        value={item.visibility}
                        onChange={(e) =>
                          doAction(() =>
                            api.setVisibility({
                              id: item.id,
                              visibility: e.target.value as Visibility,
                            }),
                          )
                        }
                      >
                        <option value="public">公开</option>
                        <option value="enterprise">企业可见</option>
                        <option value="hidden">隐藏</option>
                      </Select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </GlassPanel>
      )}

      {hasMore && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? "加载中…" : "加载更多"}
        </Button>
      )}
    </section>
  );
}

function StatusBadge({ status }: { status: string }): ReactNode {
  const label = status === "published" ? "已发布" : status === "unpublished" ? "已下架" : "草稿";
  const cls =
    status === "published"
      ? "text-success"
      : status === "unpublished"
        ? "text-text-muted"
        : "text-warning";
  return <span className={`text-sm font-medium ${cls}`}>{label}</span>;
}

function visibilityLabel(v: string): string {
  if (v === "public") return "公开";
  if (v === "enterprise") return "企业可见";
  if (v === "hidden") return "隐藏";
  return v;
}