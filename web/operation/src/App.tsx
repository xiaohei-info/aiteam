/**
 * 运营端根路由：登录页 + 受保护区（AppShell 内的业务页占位）。
 *
 * /login 公开；其余经 RequireAuth 门控（未登录跳 /login）。
 * 业务页（企业开通/目录/看板）由 W-O.2/3/4 接入真实页面，当前脚手架放占位。
 */
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell";
import { RequireAuth } from "./auth/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPlaceholder } from "./pages/DashboardPlaceholder";
import { EnterprisePlaceholder } from "./pages/EnterprisePlaceholder";
import { CatalogPlaceholder } from "./pages/CatalogPlaceholder";
import { BoardPage, EnterpriseDetailPage } from "./features/board";

export function App(): React.ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPlaceholder />} />
        <Route path="/enterprises" element={<EnterprisePlaceholder />} />
        <Route path="/catalog" element={<CatalogPlaceholder />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/board/:enterprise_id" element={<EnterpriseDetailPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
