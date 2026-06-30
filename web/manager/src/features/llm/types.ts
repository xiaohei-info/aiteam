export interface LlmProvider { provider_id: string; name: string; provider_key: string; base_url: string | null; is_active: boolean; model_count: number; created_at: string; }
export interface LlmModel { model_id: string; provider_id: string; model_uid: string; model_name: string; context_window: number | null; input_price: string | null; output_price: string | null; is_active: boolean; }
