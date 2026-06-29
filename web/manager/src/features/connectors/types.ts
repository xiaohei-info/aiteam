export interface ConnectorStatus { connector_id: string; status: string; last_check_at: string | null; error_message: string | null; }
export interface ConnectorTestResult { connector_id: string; success: boolean; latency_ms: number; message: string; }
export interface ConnectorPreset { preset_id: string; name: string; type: string; icon: string | null; description: string; }
