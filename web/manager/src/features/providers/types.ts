/** 单个 provider 支持的非敏感模型能力声明（对齐后端 ProviderModelCapability）。 */
export interface ProviderModelCapability {
  /** 模型标识（如 gpt-4o、claude-3-5-sonnet）。 */
  model: string;
  /** 面向用户的展示名（可空，UI 回退到 model）。 */
  display_name?: string;
  /** 该模型是否启用（未启用的模型不参与配置选择）。 */
  enabled?: boolean;
  /** 能力扩展键值（如 context_window、supports_vision）。 */
  capabilities?: Record<string, unknown>;
}

export interface ProviderCredential {
  credential_id: string;
  provider_ref: string;
  display_name: string;
  mode: string;
  endpoint: string | null;
  visibility: string;
  allowed_member_ids: string[];
  version: number;
  /** 该 provider 支持的模型能力目录（非敏感，允许回显）。 */
  supported_models?: ProviderModelCapability[];
}
export interface CreateProviderInput {
  provider_ref: string;
  secret: string;
  display_name?: string;
  mode?: "relay" | "direct";
  endpoint?: string;
  visibility?: "tenant" | "members";
  allowed_member_ids?: string[];
}
