export interface EnterpriseSettings {
  enterprise_name: string;
  logo_url: string | null;
  phone: string | null;
  contact_email: string;
  default_runtime: string;
  invite_required: boolean;
  member_approval: boolean;
  max_employees: number;
  features: Record<string, unknown>;
  updated_at: string;
}
export interface AdminInvite { invite_id: string; phone: string; display_name: string; status: string; created_at: string; }
