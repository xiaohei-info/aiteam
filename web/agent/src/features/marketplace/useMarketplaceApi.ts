import type { AgentApiClient } from "../../lib/api-client";
import type { MarketTemplate, MarketTemplateDetail } from "./types";

export async function listTemplates(client: AgentApiClient, params?: { category?: string; keyword?: string }): Promise<MarketTemplate[]> {
  const sp = new URLSearchParams();
  if (params?.category) sp.set("category", params.category);
  if (params?.keyword) sp.set("keyword", params.keyword);
  const qs = sp.toString();
  const r = await client.listGet<MarketTemplate>(`/api/agent/marketplace/templates${qs ? "?" + qs : ""}`);
  return r.items ?? [];
}

export async function getTemplateDetail(client: AgentApiClient, templateId: string): Promise<MarketTemplateDetail | null> {
  return client.get<MarketTemplateDetail>(`/api/agent/marketplace/templates/${templateId}`);
}
