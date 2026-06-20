/**
 * 本地 token 存储（03 §9.4C / §9.8）。
 *
 * 用户端登录后缓存 token + 解出的 claims；离线时凭缓存 token 继续工作。
 * 仅本机 localStorage，绝不上传（本地优先，02 §12.2）。错误体/日志禁含 token。
 */

import type { TokenClaims } from "@aiteam/shared/contracts";

const TOKEN_KEY = "aiteam.agent.token";
const CLAIMS_KEY = "aiteam.agent.claims";

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface StoredSession {
  token: string;
  claims: TokenClaims;
}

export function loadSession(): StoredSession | null {
  const storage = safeStorage();
  if (!storage) return null;
  const token = storage.getItem(TOKEN_KEY);
  const claimsRaw = storage.getItem(CLAIMS_KEY);
  if (!token || !claimsRaw) return null;
  try {
    const claims = JSON.parse(claimsRaw) as TokenClaims;
    return { token, claims };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  const storage = safeStorage();
  if (!storage) return;
  storage.setItem(TOKEN_KEY, session.token);
  storage.setItem(CLAIMS_KEY, JSON.stringify(session.claims));
}

export function clearSession(): void {
  const storage = safeStorage();
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
  storage.removeItem(CLAIMS_KEY);
}
