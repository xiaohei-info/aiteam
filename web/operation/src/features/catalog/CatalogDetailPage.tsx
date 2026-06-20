/**
 * 目录详情页（F03）。
 *
 * GET /api/operation/catalog/{id}，展示模板/方案完整信息。
 */
import { useState, useEffect, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { ApiError } from "@aiteam/shared";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem } from "./types";

export function CatalogDetailPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const api = useCatalogApi();
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get(id)
      .then((result) => {
        if (cancelled) return;
        setItem(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, id]);

  if (loading) return <p>加载中…</p>;

  if (error) {
    return (
      <div className="catalog-detail" role="alert">
        <p>{error}</p>
        <Link to="/catalog">返回目录</Link>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="catalog-detail">
        <p>未找到该目录项。</p>
        <Link to="/catalog">返回目录</Link>
      </div>
    );
  }

  return (
    <div className="catalog-detail">
      <Link to="/catalog" className="catalog-detail__back">
        &larr; 返回目录
      </Link>
      <h1>{item.name}</h1>
      <dl className="catalog-detail__fields">
        <dt>类型</dt>
        <dd>
          {item.type === "expert_template" ? "专家模板" : "行业方案"}
        </dd>
        <dt>状态</dt>
        <dd>{item.status}</dd>
        <dt>可见范围</dt>
        <dd>{item.visibility}</dd>
        <dt>版本</dt>
        <dd>{item.version}</dd>
        <dt>作者</dt>
        <dd>{item.author}</dd>
        <dt>创建时间</dt>
        <dd>{item.created_at}</dd>
        <dt>更新时间</dt>
        <dd>{item.updated_at}</dd>
        <dt>标签</dt>
        <dd>{item.tags.length > 0 ? item.tags.join("、") : "无"}</dd>
      </dl>
      <section className="catalog-detail__description">
        <h2>描述</h2>
        <p>{item.description}</p>
      </section>
    </div>
  );
}
