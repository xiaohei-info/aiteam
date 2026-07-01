/**
 * W-A.7 组织架构页 API 适配层（08 §12.2）。
 *
 * 消费后端 /api/agent/org/tree 投影，返回 OrgTreeNode 递归结构。
 * 红线：只调本端 /api/agent/*，跨端由基类 assertOwnTierPath 拦截。
 */
import type { AgentApiClient } from "../../lib/api-client";
import type { OrgTreeNode } from "./types";

export async function getOrgTree(client: AgentApiClient): Promise<OrgTreeNode | null> {
  return client.get<OrgTreeNode>("/api/agent/org/tree");
}
