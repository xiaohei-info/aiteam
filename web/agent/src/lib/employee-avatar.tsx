/**
 * 员工头像取图适配（Agent 端）。
 *
 * 本机员工头像 `/api/agent/employees/:id/avatar/content` 与人才市场模板头像
 * `/api/agent/marketplace/templates/:id/avatar/content` 都需要 Bearer；取图逻辑见
 * `@aiteam/shared` 的 `useProtectedAvatarSrc`。
 */
import type { ReactNode } from "react";
import { DigitalEmployeeAvatar, useProtectedAvatarSrc, type DigitalEmployeeAvatarProps } from "@aiteam/shared";

import { useOptionalApp } from "./app-context";

const PROTECTED_AGENT_AVATAR =
  /^\/api\/agent\/(?:employees|marketplace\/templates)\/[^/?#]+\/avatar\/content(?:\?[^#]*)?$/u;

/** 判断是否是需要 Bearer 的本机头像路径（员工 / 人才市场模板）。 */
export function isProtectedEmployeeAvatar(src: string): boolean {
  return PROTECTED_AGENT_AVATAR.test(src);
}

/** 把头像 src 解析成可直接交给 `<img>` 的地址（受保护路径 → objectURL）。 */
export function useEmployeeAvatarSrc(src: string | null | undefined): string | undefined {
  return useProtectedAvatarSrc(src, useOptionalApp()?.client, isProtectedEmployeeAvatar);
}

/** `DigitalEmployeeAvatar` 的安全版本：本机头像 URL 自动走 Bearer 取图。 */
export function EmployeeAvatar({ src, ...props }: DigitalEmployeeAvatarProps): ReactNode {
  return <DigitalEmployeeAvatar {...props} src={useEmployeeAvatarSrc(src)} />;
}
