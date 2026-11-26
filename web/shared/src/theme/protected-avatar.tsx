/**
 * 受保护头像取图（三端共用）。
 *
 * 头像内容接口（Agent 员工 / 人才市场模板、Manager 人才市场、Operator 目录）都要 Bearer，
 * `<img src>` 带不了 token：对命中 `isProtected` 的本端同源路径，先经本端 ApiClient
 * （自动注入 Authorization）取 blob，再交给 `DigitalEmployeeAvatar` 渲染 objectURL。
 * 其余 src（data URL 等）原样透传。取不到时回退插画——头像不是主链，不升级成页面错误。
 *
 * 路径上的 `?v=` 是头像版本：版本不变就是同一个 src，不会重复请求；版本变了自然重新取。
 */
import { useEffect, useState, type ReactNode } from "react";

import type { RequestOptions } from "../api-client/index.js";
import { DigitalEmployeeAvatar, type DigitalEmployeeAvatarProps } from "./digital-employee-avatar.js";

/** 只需要 `stream`：`ApiClient` 天然满足。 */
export interface AvatarStreamClient {
  stream(path: string, options?: RequestOptions): Promise<Response>;
}

/** 把头像 src 解析成可直接交给 `<img>` 的地址（受保护路径 → objectURL）。 */
export function useProtectedAvatarSrc(
  src: string | null | undefined,
  client: AvatarStreamClient | null | undefined,
  isProtected: (src: string) => boolean,
): string | undefined {
  const needsAuth = typeof src === "string" && isProtected(src);
  const [resolved, setResolved] = useState<string | undefined>(needsAuth ? undefined : src ?? undefined);

  useEffect(() => {
    if (!src || !isProtected(src)) {
      setResolved(src ?? undefined);
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
        const response = await client.stream(src, { headers: { Accept: "image/webp" } });
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResolved(objectUrl);
      } catch {
        if (!cancelled) setResolved(undefined);
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // isProtected 约定为模块级常量函数，不放进依赖：调用方内联箭头也不会导致每次渲染重取。
  }, [client, src]);

  return resolved;
}

export interface ProtectedAvatarProps extends DigitalEmployeeAvatarProps {
  client: AvatarStreamClient | null | undefined;
  isProtected: (src: string) => boolean;
}

/** `DigitalEmployeeAvatar` 的受保护版本：命中的头像路径自动走 Bearer 取图。 */
export function ProtectedAvatar({ client, isProtected, src, ...props }: ProtectedAvatarProps): ReactNode {
  const resolved = useProtectedAvatarSrc(src, client, isProtected);
  return <DigitalEmployeeAvatar {...props} src={resolved} />;
}
