/**
 * W-A.7 组织架构页（08 §12.1）—— 可视化组织树 + PNG 导出。
 *
 * 消费后端 get_org_tree 投影，递归渲染部门/员工节点并提供连接线；
 * "导出"按钮将当前树结构序列化为 SVG，经 Canvas 转 PNG 下载。
 * 红线：只读本地投影，不写后端；展示态为组件局部运行态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DigitalEmployeeAvatar } from "@aiteam/shared";
import { ApiError } from "@aiteam/shared/api-client";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

import { useApp } from "../../lib/app-context";
import { getOrgTree } from "./useOrgApi";
import { listLoadedExperts, type LoadedExpertProjection } from "../group/useGroupApi";
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

function OrgNode({ node, experts }: { node: OrgTreeNode; experts: Map<string, LoadedExpertProjection> }) {
  const isDepartment = node.type === "department";
  const expert = !isDepartment ? experts.get(node.id) : undefined;
  const kids = node.children ?? [];
  return (
    <VStack align="center" gap={2} data-testid="org-node" data-node-id={node.id} data-node-type={node.type}>
      <Card padding={2} variant={isDepartment ? "yellow" : "muted"} minHeight={64} width={170}>
        <HStack gap={2} align="center">
          {!isDepartment ? <DigitalEmployeeAvatar name={expert?.display_name ?? node.name} seed={node.id} src={expert?.avatar_url ?? node.avatar_url} size={42} /> : null}
          <VStack align={isDepartment ? "center" : "start"} gap={1}>
            <Text weight="semibold" data-testid="org-node-name">{node.name}</Text>
            <Text type="supporting">{isDepartment ? "部门" : "员工"}</Text>
          </VStack>
        </HStack>
      </Card>
      {kids.length > 0 && (
        <HStack gap={4} align="start" wrap="wrap">
          {kids.map((c) => (
            <OrgNode key={c.id} node={c} experts={experts} />
          ))}
        </HStack>
      )}
    </VStack>
  );
}

export function OrgPage() {
  const { client, i18n } = useApp();
  const [tree, setTree] = useState<OrgTreeNode | null>(null);
  const [experts, setExperts] = useState<LoadedExpertProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, loaded] = await Promise.all([
        getOrgTree(client),
        listLoadedExperts(client).catch(() => []),
      ]);
      setTree(t);
      setExperts(loaded);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : i18n.t("agent.org.load_error"));
    } finally {
      setLoading(false);
    }
  }, [client, i18n]);

  useEffect(() => {
    void load();
  }, [load]);

  const expertById = useMemo(
    () => new Map(experts.map((expert) => [expert.employee_id, expert] as const)),
    [experts],
  );
  const handleExport = useCallback(() => {
    if (!tree) return;
    downloadSvgAsPng(buildSvg(tree), "org-tree.png");
  }, [tree]);

  if (loading) return <Banner status="info" title={i18n.t("agent.org.loading")} />;
  if (error) return <Banner status="error" title={error} data-testid="org-error" />;
  if (!tree) return <EmptyState title="组织投影不可用" description="Agent 当前没有收到 Manager 的组织树。" data-testid="org-empty" />;

  return (
    <VStack gap={4} role="region" aria-label={i18n.t("agent.org.title")} data-testid="org-page">
      <HStack justify="between" align="center">
        <VStack gap={1}><Heading level={1}>{i18n.t("agent.org.title")}</Heading><Text type="supporting">{i18n.t("agent.org.subtitle")}</Text></VStack>
        <Button label={i18n.t("agent.org.export")} variant="secondary" onClick={handleExport} data-testid="org-export" />
      </HStack>
      <Card ref={treeRef} data-testid="org-tree" padding={4}>
        <OrgNode node={tree} experts={expertById} />
      </Card>
    </VStack>
  );
}
