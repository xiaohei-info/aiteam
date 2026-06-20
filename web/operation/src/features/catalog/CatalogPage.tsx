/**
 * 目录治理主列表页（F03）。
 *
 * 列表 + cursor 翻页（listGet → page.next_cursor 触 loadMore）；
 * role-state 门控：system_admin 可写，system_operator 只读。
 */
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { hasRole, ApiError, PlatformRole } from "@aiteam/shared";
import { useSession } from "../../auth/session";
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem } from "./types";
import { RegisterForm } from "./RegisterForm";

export function CatalogPage(): ReactNode {
  const { session } = useSession();
  const canWrite = hasRole(session, PlatformRole.SYSTEM_ADMIN);

  if (!hasRole(session, PlatformRole.SYSTEM_ADMIN, PlatformRole.SYSTEM_OPERATOR)) {
    return (
      <div className="catalog-page">
        <p>无权限访问目录治理。</p>
      </div>
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
    <div className="catalog-page">
      <h1>{i18n.t("operation.nav.catalog")}</h1>

      {canWrite && (
        <button
          className="catalog-page__add-btn"
          onClick={() => setShowRegister(true)}
        >
          注册模板/方案
        </button>
      )}

      {actionError && (
        <div className="catalog-page__error" role="alert">
          {actionError}
        </div>
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

      {loading && <p>加载中…</p>}

      {error && (
        <div className="catalog-page__error" role="alert">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <p>暂无目录项。</p>
      )}

      {items.length > 0 && (
        <>
          <table className="catalog-table">
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
                    <Link to={`/catalog/${item.id}`}>{item.name}</Link>
                  </td>
                  <td>
                    {item.type === "expert_template" ? "专家模板" : "行业方案"}
                  </td>
                  <td>
                    <StatusBadge status={item.status} />
                  </td>
                  <td>{visibilityLabel(item.visibility)}</td>
                  <td className="catalog-table__actions">
                    {canWrite && item.status !== "published" && (
                      <button
                        onClick={() => doAction(() => api.publish(item.id))}
                      >
                        发布
                      </button>
                    )}
                    {canWrite && item.status === "published" && (
                      <button
                        onClick={() => doAction(() => api.unpublish(item.id))}
                      >
                        下架
                      </button>
                    )}
                    {canWrite && (
                      <select
                        value={item.visibility}
                        onChange={(e) =>
                          doAction(() =>
                            api.setVisibility({
                              id: item.id,
                              visibility: e.target.value as
                                | "public"
                                | "enterprise"
                                | "hidden",
                            }),
                          )
                        }
                      >
                        <option value="public">公开</option>
                        <option value="enterprise">企业可见</option>
                        <option value="hidden">隐藏</option>
                      </select>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {hasMore && (
            <button
              className="catalog-page__load-more"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "加载中…" : "加载更多"}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }): ReactNode {
  const label = status === "published" ? "已发布" : status === "unpublished" ? "已下架" : "草稿";
  return <span className={`status-badge status-badge--${status}`}>{label}</span>;
}

function visibilityLabel(v: string): string {
  if (v === "public") return "公开";
  if (v === "enterprise") return "企业可见";
  if (v === "hidden") return "隐藏";
  return v;
}
