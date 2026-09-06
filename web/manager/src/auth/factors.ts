import type { ApiClient } from "../api/client";

const TRANSACTION_KEY = "aiteam.manager.oauth.transaction";
export interface OAuthTransaction {
  state: string;
  provider: string;
  intent: "login" | "link";
  redirectUri: string;
  userId?: string;
  startedAt: number;
}
export function clearOAuthTransaction(): void {
  sessionStorage.removeItem(TRANSACTION_KEY);
}
export async function startOAuth(client: ApiClient, tenantId: string, provider: string, intent: "login" | "link", userId?: string): Promise<void> {
  const redirectUri = window.location.origin + "/auth/oauth/callback";
  const out = await client.post<{ state: string; authorization_url: string }>("/api/auth/oauth/authorize", {
    body: { tenant_id: tenantId, provider, intent, redirect_uri: redirectUri },
  });
  if (!out) throw new Error("OAuth 授权未返回有效响应");
  sessionStorage.setItem(TRANSACTION_KEY, JSON.stringify({ state: out.state, provider, intent, redirectUri, userId, startedAt: Date.now() }));
  window.location.assign(out.authorization_url);
}
export function consumeOAuthTransaction(state: string | null): OAuthTransaction {
  const raw = sessionStorage.getItem(TRANSACTION_KEY);
  clearOAuthTransaction();
  const transaction: OAuthTransaction | null = raw ? JSON.parse(raw) as OAuthTransaction : null;
  if (!state || !transaction || transaction.state !== state || Date.now() - transaction.startedAt > 600_000
      || transaction.redirectUri !== window.location.origin + "/auth/oauth/callback"
      || !["login", "link"].includes(transaction.intent)) {
    throw new Error("OAuth 回调与本浏览器发起的登录不匹配或已过期，请重新开始");
  }
  return transaction;
}
