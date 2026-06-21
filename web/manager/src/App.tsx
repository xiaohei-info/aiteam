/**
 * 企业端根路由：登录页 + 受保护区（AppShell 内的业务页占位）。
 *
 * /login 公开；其余经 RequireAuth 门控（未登录跳 /login）。
 * 企业端业务面（成员账号 / 招募专家 / 成员级授权 / 企业治理，见 08 §12.1）由后续卡接入真实页面，
 * 当前脚手架放占位，并按企业角色（owner/enterprise_admin/finance_admin/member）门控导航。
 */
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell";
import { RequireAuth } from "./auth/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPlaceholder } from "./pages/DashboardPlaceholder";
import { MembersPage } from "./features/members";
import { ExpertsPage } from "./features/experts";
import { GrantsPage } from "./features/grants";
import { GovernancePlaceholder } from "./pages/GovernancePlaceholder";

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
        <Route path="/members" element={<MembersPage />} />
        <Route path="/experts" element={<ExpertsPage />} />
        <Route path="/grants" element={<GrantsPage />} />
        <Route path="/governance" element={<GovernancePlaceholder />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
