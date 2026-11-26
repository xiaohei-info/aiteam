/**
 * 受保护头像取图（三端共用）。
 *
 * 头像内容接口（Agent 员工 / 人才市场模板、Manager 人才市场、Operator 目录）都要 Bearer，
 * `<img src>` 带不了 token：对命中 `isProtected` 的本端同源路径，先经本端 ApiClient
 * （自动注入 Authorization）取 blob，再交给 `DigitalEmployeeAvatar` 渲染 objectURL。
 * 其余 src（data URL 等）原样透传。取不到时回退插画——头像不是主链，不升级成页面错误。
 *
 * 路径上的 `?v=` 是头像版本：版本不变就是同一个 src，不会重复请求；版本变了自然重新取。
 *
 * 同一个 (client, src) 在整页只取一次：时间线里一个员工发 60 条消息就是 60 个组件实例，
 * 各自取图会打出 60 个请求和 60 份重复 blob。下面按 (client, src) 做共享表 + 引用计数，
 * 并发合并成一次请求，最后一个使用者卸载时才 revoke。
 */
import { useEffect, useState, type ReactNode } from "react";

import type { RequestOptions } from "../api-client/index.js";
import { DigitalEmployeeAvatar, type DigitalEmployeeAvatarProps } from "./digital-employee-avatar.js";

/** 只需要 `stream`：`ApiClient` 天然满足。 */
export interface AvatarStreamClient {
  stream(path: string, options?: RequestOptions): Promise<Response>;
}

interface AvatarEntry {
  /** 取图结果；同一 src 的所有实例共用这一个 promise。 */
  promise: Promise<string | undefined>;
  objectUrl?: string;
  refs: number;
}

/** client 作为键：三端各有自己的 ApiClient，同名路径在不同端是不同资源。 */
const avatarCaches = new WeakMap<AvatarStreamClient, Map<string, AvatarEntry>>();

function cacheFor(client: AvatarStreamClient): Map<string, AvatarEntry> {
  let entries = avatarCaches.get(client);
  if (!entries) {
    entries = new Map();
    avatarCaches.set(client, entries);
  }
  return entries;
}

function acquireAvatar(client: AvatarStreamClient, src: string): AvatarEntry {
  const entries = cacheFor(client);
  const cached = entries.get(src);
  if (cached) {
    cached.refs += 1;
    return cached;
  }
  const entry: AvatarEntry = { refs: 1, promise: Promise.resolve(undefined) };
  entry.promise = (async () => {
    try {
      const response = await client.stream(src, { headers: { Accept: "image/webp" } });
      const blob = await response.blob();
      // 使用者在取图期间全部卸载了：不再造 objectURL，省掉一次没人 revoke 的泄漏。
      if (entry.refs <= 0) return undefined;
      entry.objectUrl = URL.createObjectURL(blob);
      return entry.objectUrl;
    } catch {
      return undefined;
    }
  })();
  entries.set(src, entry);
  return entry;
}

function releaseAvatar(client: AvatarStreamClient, src: string, entry: AvatarEntry): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  const entries = avatarCaches.get(client);
  if (entries?.get(src) === entry) entries.delete(src);
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = undefined;
  }
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
    const entry = acquireAvatar(client, src);
    // 已经取到过就直接渲染，不要先闪一下占位插画。
    setResolved(entry.objectUrl);
    void entry.promise.then((url) => {
      if (!cancelled) setResolved(url);
    });
    return () => {
      cancelled = true;
      releaseAvatar(client, src, entry);
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
