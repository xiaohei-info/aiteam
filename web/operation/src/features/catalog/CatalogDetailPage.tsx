/**
 * 目录项详情页（F03）。
 * GET /api/operation/catalog/{catalog_type}/{template_id}
 */
import { useState, useEffect, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { ApiError } from "@aiteam/shared";
import { Button, GlassPanel, Table } from "@aiteam/shared/ui";
import { useI18n } from "../../i18n/context";
import { useCatalogApi } from "./useCatalogApi";
import type { CatalogItem, CatalogItemType } from "./types";

export function CatalogDetailPage(): ReactNode {
  const { catalog_type, template_id } = useParams<{ catalog_type: string; template_id: string }>();
  const i18n = useI18n();
  const api = useCatalogApi();
  const [item, setItem] = useState<CatalogItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!catalog_type || !template_id) return;
    setLoading(true);
    api
      .get(catalog_type as CatalogItemType, template_id)
      .then((data) => { setItem(data); setLoading(false); })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : "加载失败");
        setLoading(false);
      });
  }, [api, catalog_type, template_id]);

  if (loading) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">
          {error}
        </GlassPanel>
      </section>
    );
  }

  if (!item) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">
          {i18n.t("operation.catalog.notFound")}
        </GlassPanel>
      </section>
    );
  }

  const rows: [string, string][] = [
    ["模板 ID", item.template_id],
    ["类型", item.catalog_type === "expert_template" ? "专家模板" : "行业方案"],
    ["版本", item.version],
    ["状态", item.status],
    ["名称", item.display_name],
  ];

  return (
    <section className="flex flex-col gap-lg">
      <Link to="/catalog" className="text-sm text-text-muted hover:text-gold">
        ← {i18n.t("operation.catalog.backToList")}
      </Link>
      <h1 className="m-0 text-xl font-bold text-text-primary">{item.display_name}</h1>
      <GlassPanel className="overflow-hidden rounded-window">
        <Table>
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <td className="text-text-secondary">{label}</td>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </GlassPanel>
    </section>
  );
}
