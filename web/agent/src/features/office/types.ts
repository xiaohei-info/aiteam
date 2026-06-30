export interface OfficeEmployee { employee_id: string; display_name: string; status: string; task: string | null; avatar_url: string | null; }
export interface OfficeScene { employees: OfficeEmployee[]; summary: Record<string, number>; }
export interface OfficeFeed { events: Array<Record<string, unknown>>; }
