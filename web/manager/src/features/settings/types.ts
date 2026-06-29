export interface EnterpriseSettings { enterprise_name: string; logo_url: string | null; phone: string | null; wechat: string | null; invite_code: string | null; notify_on_task_complete: boolean; notify_on_system: boolean; version: string; }
export interface AdminInvite { invite_id: string; phone: string; display_name: string; status: string; created_at: string; }
