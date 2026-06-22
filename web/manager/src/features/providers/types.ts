export interface ProviderCredential {
  credential_id: string;
  provider_ref: string;
  display_name: string;
  mode: string;
  endpoint: string | null;
  visibility: string;
  allowed_member_ids: string[];
  version: number;
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
