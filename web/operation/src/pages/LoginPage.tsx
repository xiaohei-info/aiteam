/**
 * 登录页骨架（W-O.1 只做骨架 + 调本端 /api/auth/* 的占位）。
 *
 * 真实登录表单与 /api/auth/login 联调由后续卡补全；脚手架阶段提供：
 * - 表单 UI（手机号 + bootstrap secret，对应 Manager 颁发）。
 * - 提交时 signIn(token) 注入会话（mock token，待后端联调）。
 * - 登录成功跳回来源页（RequireAuth 透传 state.from）。
 */
import { type FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useSession } from "../auth/session";
import { useI18n } from "../i18n/context";

interface LocationState {
  from?: string;
}

export function LoginPage(): React.ReactNode {
  const { session, signIn } = useSession();
  const i18n = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [phone, setPhone] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 已登录直接跳来源页或首页。
  if (session) {
    const from = (location.state as LocationState | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    if (!phone.trim() || !secret.trim()) {
      setError(i18n.t("operation.login.required"));
      return;
    }
    // 脚手架占位：真实 /api/auth/login 联调由后续卡接入（本端同 origin）。
    // 此处仅校验表单非空，不构造假 token——避免误导验收（token 必须来自后端验签）。
    setError(i18n.t("operation.login.pending_backend"));
  }

  return (
    <div className="login-page">
      <form className="login-page__form" onSubmit={handleSubmit}>
        <h1 className="login-page__title">{i18n.t("operation.title")}</h1>
        <label className="login-page__field">
          <span>{i18n.t("operation.login.phone")}</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="login-page__field">
          <span>{i18n.t("operation.login.secret")}</span>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="login-page__error">{error}</p> : null}
        <button type="submit" className="login-page__submit">
          {i18n.t("operation.login.submit")}
        </button>
      </form>
      {/* signIn 留在作用域内供后续联调使用，避免未使用告警。 */}
      <span hidden>{typeof signIn}</span>
    </div>
  );
}
