/** GET /api/manager/me：顶栏和自助改密入口用的当前登录者概览。读取失败不影响页面，顶栏降级为只显示"企业端"。 */
import { useEffect, useMemo, useState } from "react";
import { ApiError } from "@aiteam/shared";
import { createManagerApiClient } from "../api/client";
import { useSession } from "../auth/session";

export interface PasswordPolicy {
  min_length: number;
  require_upper: boolean;
  require_lower: boolean;
  require_digit: boolean;
  require_symbol: boolean;
  max_age_days: number;
}

export interface Me {
  enterprise_name: string | null;
  enterprise_code: string | null;
  account_masked: string;
  roles: string[];
  has_password: boolean;
  password_policy: PasswordPolicy;
  /** active 或 suspended（暂停，仅可查看）。 */
  tenant_status?: string;
}

/** 企业被封禁 / 注销 / 删除：所有接口都会 403，外壳据此整页说明原因。 */
export interface TenantBlocked {
  code: string;
  message: string;
}

const BLOCKED_CODES = new Set(["tenant_banned", "tenant_closed", "tenant_deleted"]);

export interface MeState {
  me: Me | null;
  blocked: TenantBlocked | null;
}

export function useMe(): MeState {
  const { token, onUnauthorized } = useSession();
  const client = useMemo(() => createManagerApiClient({ getToken: () => token, onUnauthorized }), [token, onUnauthorized]);
  const [state, setState] = useState<MeState>({ me: null, blocked: null });

  useEffect(() => {
    if (!token) return;
    let active = true;
    client.get<Me>("/api/manager/me").then(
      (data) => { if (active) setState({ me: data ?? null, blocked: null }); },
      (err: unknown) => {
        if (!active) return;
        const blocked = err instanceof ApiError && BLOCKED_CODES.has(err.code)
          ? { code: err.code, message: err.message }
          : null;
        setState({ me: null, blocked });
      },
    );
    return () => { active = false; };
  }, [client, token]);

  return state;
}
