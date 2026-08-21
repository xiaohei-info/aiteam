import type { AgentApiClient } from "../../lib/api-client";
import type { MarketTemplate } from "./types";

export async function listTemplates(client: AgentApiClient): Promise<MarketTemplate[]> {
  const r = await client.listGet<MarketTemplate>("/api/agent/marketplace/templates");
  if (!Array.isArray(r.items)) throw new Error("marketplace catalog: invalid response");
  return r.items;
}
