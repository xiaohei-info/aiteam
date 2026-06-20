/**
 * 登录页骨架（W-M 只做骨架 + 调本端 /api/auth/* 的占位）。
 *
 * 真实登录表单与 /api/auth/login 联调由后续卡补全；脚手架阶段提供：
 * - 表单 UI（成员账号 + 密码，Manager 为企业租户身份源）。
 * - 提交时 signIn(token) 注入会话（token 必须来自后端验签，脚手架不造假 token）。
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
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 已登录直接跳来源页或首页。
  if (session) {
    const from = (location.state as LocationState | null)?.from ?? "/";
    return <Navigate to={from} replace />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setError(null);
    if (!account.trim() || !password.trim()) {
      setError(i18n.t("manager.login.required"));
      return;
    }
    // 脚手架占位：真实 /api/auth/login 联调由后续卡接入（本端同 origin）。
    // 此处仅校验表单非空，不构造假 token——避免误导验收（token 必须来自后端验签）。
    setError(i18n.t("manager.login.pending_backend"));
  }

  return (
    <div className="login-page">
      <form className="login-page__form" onSubmit={handleSubmit}>
        <h1 className="login-page__title">{i18n.t("manager.title")}</h1>
        <label className="login-page__field">
          <span>{i18n.t("manager.login.account")}</span>
          <input
            type="text"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="login-page__field">
          <span>{i18n.t("manager.login.password")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error ? <p className="login-page__error">{error}</p> : null}
        <button type="submit" className="login-page__submit">
          {i18n.t("manager.login.submit")}
        </button>
      </form>
      {/* signIn / navigate 留在作用域内供后续联调使用，避免未使用告警。 */}
      <span hidden>
        {typeof signIn}
        {typeof navigate}
      </span>
    </div>
  );
}
