export interface SystemHealth {
  status: string;
  services: Record<string, string>;
  timestamp: string;
}
