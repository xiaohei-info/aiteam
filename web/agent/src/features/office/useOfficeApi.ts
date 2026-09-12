import type { AgentApiClient } from "../../lib/api-client";
import type { OfficeScene, OfficeFeed } from "./types";

export {
  getUsageStatistics,
  listWorkRecordChanges,
  listWorkRecords,
  type UsageStatistics,
  type WorkChangesPage,
  type WorkHistoryPage,
  type WorkRecord,
} from "../workspace/useWorkspaceApi";

export async function getScene(client: AgentApiClient, signal?: AbortSignal): Promise<OfficeScene | null> {
  return signal ? client.get<OfficeScene>("/api/agent/office/scene", { signal }) : client.get<OfficeScene>("/api/agent/office/scene");
}

export async function getFeed(client: AgentApiClient, signal?: AbortSignal): Promise<OfficeFeed | null> {
  return signal ? client.get<OfficeFeed>("/api/agent/office/feed", { signal }) : client.get<OfficeFeed>("/api/agent/office/feed");
}
