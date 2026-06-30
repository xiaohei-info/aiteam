/**
 * W-A.7 组织架构页（08 §12.1）—— 可视化组织树 + PNG 导出。
 *
 * 消费后端 get_org_tree 投影，递归渲染部门/员工节点并提供连接线；
 * "导出"按钮将当前树结构序列化为 SVG，经 Canvas 转 PNG 下载。
 * 红线：只读本地投影，不写后端；展示态为组件局部运行态。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@aiteam/shared/api-client";
import { GlassPanel, Button } from "@aiteam/shared/ui";

import { useApp } from "../../lib/app-context";
import { getOrgTree } from "./useOrgApi";
import type { OrgTreeNode } from "./types";

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 将组织树序列化为扁平节点（用于 SVG 绘制），返回节点列表 + 画布尺寸。 */
function flattenTree(root: OrgTreeNode): { nodes: Array<{ id: string; name: string; type: string; x: number; y: number }>; edges: Array<{ x1: number; y1: number; x2: number; y2: number }>; width: number; height: number } {
  const nodes: Array<{ id: string; name: string; type: string; x: number; y: number }> = [];
  const edges: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  const NODE_W = 150;
  const NODE_H = 64;
  const H_GAP = 24;
  const V_GAP = 60;

  // 第一步：计算每棵子树的宽度（后序）。
  function subtreeWidth(n: OrgTreeNode): number {
    const kids = n.children ?? [];
    if (kids.length === 0) return NODE_W;
    const total = kids.reduce((s, k) => s + subtreeWidth(k), 0) + (kids.length - 1) * H_GAP;
    return Math.max(NODE_W, total);
  }

  // 第二步：按相对坐标布局。
  function layout(n: OrgTreeNode, left: number, top: number) {
    const w = subtreeWidth(n);
    const x = left + w / 2 - NODE_W / 2;
    const y = top;
    nodes.push({ id: n.id, name: n.name, type: n.type, x, y });
    const kids = n.children ?? [];
    if (kids.length === 0) return;
    let cursor = left;
    const childTop = top + NODE_H + V_GAP;
    for (const c of kids) {
      const cw = subtreeWidth(c);
      layout(c, cursor, childTop);
      edges.push({
        x1: x + NODE_W / 2,
        y1: y + NODE_H,
        x2: cursor + cw / 2,
        y2: childTop,
      });
      cursor += cw + H_GAP;
    }
  }

  const totalWidth = subtreeWidth(root);
  layout(root, 0, 0);
  return { nodes, edges, width: totalWidth, height: (maxDepth(root) - 1) * (NODE_H + V_GAP) + NODE_H };
}

function maxDepth(n: OrgTreeNode): number {
  const kids = n.children ?? [];
  if (kids.length === 0) return 1;
  return 1 + Math.max(...kids.map(maxDepth));
}

function buildSvg(root: OrgTreeNode): string {
  const { nodes, edges, width, height } = flattenTree(root);
  const pad = 24;
  const w = Math.max(width + pad * 2, 320);
  const h = height + pad * 2;
  const shift = pad;
  const edgesSvg = edges
    .map((e) => `<line x1="${e.x1 + shift}" y1="${e.y1 + shift}" x2="${e.x2 + shift}" y2="${e.y2 + shift}" stroke="rgba(212,175,55,0.6)" stroke-width="2" />`)
    .join("");
  const nodesSvg = nodes
    .map((n) => {
      const isRoot = n.type === "department";
      const bg = isRoot ? "rgba(212,175,55,0.15)" : "rgba(28,24,19,0.6)";
      const stroke = isRoot ? "#d4af37" : "rgba(212,175,55,0.35)";
      return (
        `<g>` +
        `<rect x="${n.x + shift - 6}" y="${n.y + shift - 6}" width="162" height="76" rx="10" fill="${bg}" stroke="${stroke}" stroke-width="1.5" />` +
        `<text x="${n.x + shift + 75}" y="${n.y + shift + 28}" text-anchor="middle" font-family="${FONT}" font-size="13" font-weight="700" fill="#f5e7b0">${escapeXml(n.name)}</text>` +
        `<text x="${n.x + shift + 75}" y="${n.y + shift + 48}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="rgba(245,231,176,0.6)">${escapeXml(isRoot ? "部门" : "员工")}</text>` +
        `</g>`
      );
    })
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="#0c0a07" />` +
    edgesSvg +
    nodesSvg +
    `</svg>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}

function downloadSvgAsPng(svg: string, filename: string) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      URL.revokeObjectURL(url);
      return;
    }
    ctx.fillStyle = "#0c0a07";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, "image/png");
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

function OrgNode({ node }: { node: OrgTreeNode }) {
  const isRoot = node.type === "department";
  const kids = node.children ?? [];
  return (
    <div className="flex flex-col items-center" data-testid="org-node" data-node-id={node.id} data-node-type={node.type}>
      <GlassPanel className={`rounded-window px-sm py-xs text-center min-w-[120px] ${isRoot ? "border border-gold/60" : "border border-gold/20"}`}>
        <p className="m-0 text-sm font-bold text-gold" data-testid="org-node-name">{node.name}</p>
        <p className="m-0 text-xs text-text-muted">{isRoot ? "部门" : "员工"}</p>
      </GlassPanel>
      {kids.length > 0 && (
        <>
          <div className="w-px h-md bg-gold/50" />
          <div className="flex items-start gap-md">
            {kids.map((c) => (
              <div key={c.id} className="flex flex-col items-center">
                <div className="h-md w-px bg-gold/50" />
                <OrgNode node={c} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function OrgPage() {
  const { client, i18n } = useApp();
  const [tree, setTree] = useState<OrgTreeNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await getOrgTree(client);
      setTree(t);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("agent.org.load_error"));
    } finally {
      setLoading(false);
    }
  }, [client, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleExport = useCallback(() => {
    if (!tree) return;
    downloadSvgAsPng(buildSvg(tree), "org-tree.png");
  }, [tree]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">{i18n.t("agent.org.loading")}</GlassPanel>;
  if (error) return <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger" data-testid="org-error">{error}</GlassPanel>;
  if (!tree) return null;

  return (
    <section className="flex flex-col gap-md" data-testid="org-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="m-0 text-xl font-bold text-text-primary">{i18n.t("agent.org.title")}</h1>
          <p className="m-0 mt-xs text-xs text-text-muted">{i18n.t("agent.org.subtitle")}</p>
        </div>
        <div className="flex gap-sm">
          <Button variant="ghost" onClick={handleExport} data-testid="org-export">{i18n.t("agent.org.export")}</Button>
        </div>
      </div>
      <div ref={treeRef} data-testid="org-tree" className="org-tree-container flex justify-start overflow-auto rounded-window border border-gold/20 bg-surface p-lg">
        <OrgNode node={tree} />
      </div>
    </section>
  );
}
