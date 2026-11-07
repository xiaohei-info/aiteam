export interface PlatformProvider {
  provider_id: string;
  provider_code: string;
  display_name: string;
  relay_base_url: string;
  api_protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  status: "draft" | "published" | "disabled";
  version: number;
  updated_at: string;
}

export interface PlatformModel {
  provider_id: string;
  model_id: string;
  display_name: string;
  capabilities: Record<string, unknown>;
  status: "draft" | "published" | "disabled";
  source: "discovery" | "manual";
  version: number;
  updated_at: string;
}

export interface PlatformModelRate {
  rate_id: string;
  provider_id: string;
  model_id: string;
  pricing_version: number;
  pricing_status: "known" | "unknown";
  billing_mode: "token" | "request";
  input_usd_per_million: string | null;
  output_usd_per_million: string | null;
  cache_read_usd_per_million: string | null;
  cache_write_usd_per_million: string | null;
  request_usd: string | null;
  currency: "USD";
  source: "manual" | "provider" | "public_reference" | "unknown";
  effective_from: string;
}

export interface PlatformModelWithRate { model: PlatformModel; rate: PlatformModelRate | null; }

export interface PublicPricingSyncResult {
  source: string;
  updated: number;
  skipped_known: number;
  skipped_manual: number;
  unmatched: number;
}

export type ThinkingMode = "none" | "toggle" | "effort" | "budget";

/** One upstream channel of the LLM gateway. The upstream API key is write-only and never returned. */
export interface GatewayChannel {
  id: number;
  name: string;
  channel_type: number;
  channel_type_label: string;
  status: "enabled" | "manually_disabled" | "auto_disabled" | "unknown";
  base_url: string;
  models: string[];
  model_mapping: Record<string, string>;
  /** Sensitive header values come back masked as `********`. */
  header_override: Record<string, string>;
  param_override: Record<string, unknown>;
  group: string;
  priority: number;
  weight: number;
  test_model: string | null;
  response_time_ms: number | null;
  tested_at: number | null;
}

export interface GatewayChannelInput {
  name: string;
  channel_type: number;
  base_url: string;
  /** Omit or leave empty when editing to keep the stored key. */
  key?: string;
  models: string[];
  model_mapping: Record<string, string>;
  header_override: Record<string, string>;
  param_override: Record<string, unknown>;
  group: string;
  priority: number;
  weight: number;
  test_model: string | null;
}

export interface GatewayChannelType { channel_type: number; label: string; }

export interface GatewayChannelTestResult { ok: boolean; seconds: number | null; message: string; }

export interface UpstreamModelPreviewInput {
  channel_id?: number;
  channel_type?: number;
  base_url?: string;
  key?: string;
}

export interface ModelCapabilitiesInput {
  display_name: string;
  context_window: number | null;
  max_tokens: number | null;
  reasoning: boolean;
  thinking_mode: ThinkingMode;
  thinking_levels: string[];
  thinking_level_map: Record<string, string | null>;
  input: ("text" | "image")[];
}
