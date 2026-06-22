/**
 * 目录详情页（F03）。
 *
 * GET /api/operation/catalog/{id}，展示模板/方案完整信息。
 * 黑金玻璃质感，复用 shared 组件（GlassPanel/Table）。
 */
import { useState, useEffect, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { ApiError } from "@aiteam/shared";
import { GlassPanel, Table } from "@aiteam/shared/ui";
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

  if (loading) {
    return <p className="text-sm text-text-secondary">加载中…</p>;
  }

  if (error) {
    return (
      <GlassPanel className="flex flex-col gap-sm rounded-window border border-danger/30 p-lg" role="alert">
        <p className="m-0 text-sm text-danger">{error}</p>
        <Link to="/catalog" className="text-sm text-gold hover:text-gold-bright">
          返回目录
        </Link>
      </GlassPanel>
    );
  }

  if (!item) {
    return (
      <GlassPanel className="flex flex-col gap-sm rounded-window p-lg">
        <p className="m-0 text-sm text-text-muted">未找到该目录项。</p>
        <Link to="/catalog" className="text-sm text-gold hover:text-gold-bright">
          返回目录
        </Link>
      </GlassPanel>
    );
  }

  const fields: Array<[string, ReactNode]> = [
    ["类型", item.type === "expert_template" ? "专家模板" : "行业方案"],
    ["状态", item.status],
    ["可见范围", item.visibility],
    ["版本", item.version],
    ["作者", item.author],
    ["创建时间", item.created_at],
    ["更新时间", item.updated_at],
    ["标签", item.tags.length > 0 ? item.tags.join("、") : "无"],
  ];

  return (
    <section className="flex flex-col gap-lg">
      <Link to="/catalog" className="text-sm text-gold hover:text-gold-bright">
        &larr; 返回目录
      </Link>

      <h1 className="m-0 text-xl font-bold text-text-primary">{item.name}</h1>

      <GlassPanel className="overflow-hidden rounded-window">
        <Table>
          <tbody>
            {fields.map(([k, v]) => (
              <tr key={k}>
                <td className="w-32 text-text-muted">{k}</td>
                <td className="text-text-primary">{v}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </GlassPanel>

      <div className="flex flex-col gap-sm">
        <h2 className="m-0 text-base font-semibold text-text-primary">描述</h2>
        <GlassPanel className="rounded-window p-lg">
          <p className="m-0 text-sm text-text-secondary">{item.description}</p>
        </GlassPanel>
      </div>
    </section>
  );
}