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
