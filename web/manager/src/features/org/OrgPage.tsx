/** P07 组织架构页 — 树形展示。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { GlassPanel } from "@aiteam/shared/ui";
import { useOrgApi } from "./useOrgApi";
import type { OrgTreeNode } from "./types";

function TreeNode({ node, depth }: { node: OrgTreeNode; depth: number }) {
  return (
    <div style={{ paddingLeft: `${depth * 24}px` }} data-testid="org-node">
      <div className="flex items-center gap-sm py-xs">
        <span className={node.type === "department" ? "text-gold-bright" : "text-text-primary"}>{node.type === "department" ? "📁" : "👤"}</span>
        <span className="text-sm text-text-primary">{node.name}</span>
        {node.status && <span className={`text-xs ${node.status === "online" ? "text-success" : "text-text-muted"}`}>●{node.status}</span>}
      </div>
      {node.children?.map((c) => <TreeNode key={c.id} node={c} depth={depth + 1} />)}
    </div>
  );
}

export function OrgPage(): ReactNode {
  const api = useOrgApi();
  const [tree, setTree] = useState<OrgTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setTree(await api.getTree()); } catch (err) {
      setError(err instanceof ApiError ? err.message : "组织架构加载失败");
    } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">组织架构</h1>
      {error && <GlassPanel className="rounded-window p-md text-sm text-danger">{error}</GlassPanel>}
      <GlassPanel className="rounded-window p-md">{tree ? <TreeNode node={tree} depth={0} /> : <p className="text-sm text-text-secondary">暂无数据</p>}</GlassPanel>
    </section>
  );
}
