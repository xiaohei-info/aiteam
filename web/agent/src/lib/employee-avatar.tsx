/**
 * 员工头像取图适配（Agent 端）。
 *
 * 员工头像接口 `/api/agent/employees/:id/avatar/content` 需要 Bearer，`<img src>` 带不了
 * token，所以对这类同源受保护路径先经 client（自动注入 Authorization）取 blob，再交给
 * `DigitalEmployeeAvatar` 渲染 objectURL；其余 src（本地 data URL、模板头像等）原样透传。
 *
 * 取不到时回退到插画：头像不是主链，不把图片失败升级成页面级错误。
 */
import { useEffect, useState, type ReactNode } from "react";
import { DigitalEmployeeAvatar, type DigitalEmployeeAvatarProps } from "@aiteam/shared";

import { useOptionalApp } from "./app-context";

const PROTECTED_EMPLOYEE_AVATAR = /^\/api\/agent\/employees\/[^/]+\/avatar\/content(?:\?[^#]*)?$/u;

/** 判断是否是需要 Bearer 的本机员工头像路径。 */
export function isProtectedEmployeeAvatar(src: string): boolean {
  return PROTECTED_EMPLOYEE_AVATAR.test(src);
}

/** 把员工头像 src 解析成可直接交给 `<img>` 的地址（受保护路径 → objectURL）。 */
export function useEmployeeAvatarSrc(src: string | null | undefined): string | undefined {
  const app = useOptionalApp();
  const client = app?.client;
  const token = app?.token ?? null;
  const needsAuth = typeof src === "string" && isProtectedEmployeeAvatar(src);
  const [resolved, setResolved] = useState<string | undefined>(needsAuth ? undefined : src ?? undefined);

  useEffect(() => {
    if (!src) {
      setResolved(undefined);
      return;
    }
    if (!isProtectedEmployeeAvatar(src)) {
      setResolved(src);
      return;
    }
    if (!client) {
      setResolved(undefined);
      return;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setResolved(undefined);
    void (async () => {
      try {
        const response = await client.stream(src, { headers: { Accept: "image/*" } });
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved(objectUrl);
      } catch {
        // 企业端不可达 / 无权限：回退插画。
        if (!cancelled) setResolved(undefined);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, src, token]);

  return resolved;
}

/** `DigitalEmployeeAvatar` 的安全版本：员工头像 URL 自动走 Bearer 取图。 */
export function EmployeeAvatar({ src, ...props }: DigitalEmployeeAvatarProps): ReactNode {
  const resolved = useEmployeeAvatarSrc(src);
  return <DigitalEmployeeAvatar {...props} src={resolved} />;
}
