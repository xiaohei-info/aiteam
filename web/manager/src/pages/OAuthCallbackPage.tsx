import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useSession } from "../auth/session";
import { consumeOAuthTransaction } from "../auth/factors";
import { createManagerApiClient } from "../api/client";

export function OAuthCallbackPage(): React.ReactNode {
  const { token, signIn } = useSession();
  const navigate = useNavigate();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get("code");
        // Remove the one-time authorization code from visible browser history immediately.
        window.history.replaceState(null, "", window.location.pathname);
        const transaction = consumeOAuthTransaction(params.get("state"));
        if (!code || params.has("error")) throw new Error("OAuth 授权已取消或失败");
        const client = createManagerApiClient({ getToken: () => token });
        if (transaction.intent === "link") {
          if (!token) throw new Error("绑定账号需要重新登录");
          const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { user_id: string };
          if (claims.user_id !== transaction.userId) throw new Error("当前账号与发起绑定的账号不同");
          await client.post("/api/manager/oauth/link", { body: { provider: transaction.provider, code, state: transaction.state, redirect_uri: transaction.redirectUri } });
          navigate("/settings", { replace: true });
        } else {
          const out = await client.post<{ token: string }>("/api/auth/oauth/callback", { body: { provider: transaction.provider, code, state: transaction.state } });
          if (!out) throw new Error("OAuth 登录未返回凭据");
          signIn(out.token);
          navigate("/", { replace: true });
        }
      } catch (err) { setError(err instanceof Error ? err.message : "OAuth 回调失败"); }
    })();
  }, [navigate, signIn, token]);
  return <section><h1>账号认证</h1>{error ? <p role="alert">{error}</p> : <p role="status">正在验证授权…</p>}<Link to="/login">返回登录</Link></section>;
}
