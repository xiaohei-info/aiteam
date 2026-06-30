import type { AgentApiClient } from "../../lib/api-client";
import type { OfficeScene, OfficeFeed } from "./types";

export async function getScene(client: AgentApiClient): Promise<OfficeScene | null> {
  return client.get<OfficeScene>("/api/agent/office/scene");
}

export async function getFeed(client: AgentApiClient): Promise<OfficeFeed | null> {
  return client.get<OfficeFeed>("/api/agent/office/feed");
}
