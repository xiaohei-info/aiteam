/**
 * 应用路由（08 §12.2）。/login 公开；其余需登录，由 PageShell 包裹。
 * 路由表对齐 shell-config 的 nav path（三处同名对齐，02 §10.1）。
 */

import { Navigate, Route, Routes } from "react-router-dom";

import { PageShell } from "../components/PageShell";
import { RequireAuth } from "../components/RequireAuth";
import { ChatPage } from "../features/chat";
import { GroupPage } from "../features/group";
import { WorkspacePage } from "../features/workspace";
import { SyncPage } from "../features/sync";
import { LoginPage } from "../pages/LoginPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/workspace"
        element={
          <RequireAuth>
            <PageShell>
              <WorkspacePage />
            </PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/chat"
        element={
          <RequireAuth>
            <PageShell>
              <ChatPage />
            </PageShell>
          </RequireAuth>
        }
      />
      <Route
        path="/group"
        element={
          <RequireAuth>
            <PageShell>
              <GroupPage />
            </PageShell>
          </RequireAuth>
        }
      />
      <Route path="/" element={<Navigate to="/workspace" replace />} />
      <Route path="/sync" element={<RequireAuth><PageShell><SyncPage /></PageShell></RequireAuth>} />
      <Route path="*" element={<Navigate to="/workspace" replace />} />
    </Routes>
  );
}
