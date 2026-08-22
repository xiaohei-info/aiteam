/** Provider 接入协议由 Manager runtime-config 契约限定。 */
export type ProviderApiProtocol =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages";

export type ProviderVisibility = "tenant" | "members";
export type ProviderModelCatalogSource = "manual" | "discovery";

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
  endpoint: string | null;
  api_protocol: ProviderApiProtocol;
  visibility: ProviderVisibility;
  allowed_member_ids: string[];
  version: number;
  /** 该 provider 支持的模型能力目录（非敏感，允许回显）。 */
  supported_models?: ProviderModelCapability[];
  /** 能力目录来源；旧响应缺失时 UI 按 manual 处理。 */
  model_catalog_source?: ProviderModelCatalogSource;
}

export interface CreateProviderInput {
  provider_ref: string;
  secret: string;
  display_name?: string;
  endpoint?: string | null;
  api_protocol?: ProviderApiProtocol;
  visibility?: ProviderVisibility;
  allowed_member_ids?: string[];
  /** 该 provider 支持的模型能力目录（非敏感）；用于招募时按 default_model 自动匹配 provider_ref。 */
  supported_models?: ProviderModelCapability[];
  model_catalog_source?: ProviderModelCatalogSource;
}

/** 当前 Manager API 要求每次 PUT 都携带新 secret；空 secret 不代表“保持原密钥”。 */
export interface UpdateProviderInput {
  secret: string;
  display_name?: string;
  endpoint?: string | null;
  api_protocol?: ProviderApiProtocol;
  visibility?: ProviderVisibility;
  allowed_member_ids?: string[];
  supported_models?: ProviderModelCapability[];
  model_catalog_source?: ProviderModelCatalogSource;
}
