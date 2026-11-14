/** GET /api/manager/me：顶栏和自助改密入口用的当前登录者概览。读取失败不影响页面，顶栏降级为只显示"企业端"。 */
import { useEffect, useMemo, useState } from "react";
import { createManagerApiClient } from "../api/client";
import { useSession } from "../auth/session";

/** 企业名等 me 字段被改后（如设置页保存），派发此事件让顶栏重新读取，不用刷新页面。 */
export const ME_CHANGED_EVENT = "aiteam:manager-me-changed";

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
}

export function useMe(): Me | null {
  const { token, onUnauthorized } = useSession();
  const client = useMemo(() => createManagerApiClient({ getToken: () => token, onUnauthorized }), [token, onUnauthorized]);
  const [me, setMe] = useState<Me | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1);
    window.addEventListener(ME_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(ME_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    client.get<Me>("/api/manager/me").then(
      (data) => { if (active) setMe(data ?? null); },
      () => { if (active) setMe(null); },
    );
    return () => { active = false; };
  }, [client, token, version]);

  return me;
}
