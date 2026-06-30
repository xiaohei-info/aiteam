import { Navigate, Route, Routes } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import { RequireAuth } from "../components/RequireAuth";
import { ChatPage } from "../features/chat";
import { GroupPage } from "../features/group";
import { WorkspacePage } from "../features/workspace";
import { SyncPage } from "../features/sync";
import { MarketplacePage } from "../features/marketplace";
import { OfficePage } from "../features/office";
import { KnowledgePage } from "../features/knowledge";
import { LoginPage } from "../pages/LoginPage";

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/workspace" element={<RequireAuth><PageShell><WorkspacePage /></PageShell></RequireAuth>} />
      <Route path="/chat" element={<RequireAuth><PageShell><ChatPage /></PageShell></RequireAuth>} />
      <Route path="/group" element={<RequireAuth><PageShell><GroupPage /></PageShell></RequireAuth>} />
      <Route path="/marketplace" element={<RequireAuth><PageShell><MarketplacePage /></PageShell></RequireAuth>} />
      <Route path="/knowledge" element={<RequireAuth><PageShell><KnowledgePage /></PageShell></RequireAuth>} />
      <Route path="/office" element={<RequireAuth><PageShell><OfficePage /></PageShell></RequireAuth>} />
      <Route path="/sync" element={<RequireAuth><PageShell><SyncPage /></PageShell></RequireAuth>} />
      <Route path="/" element={<Navigate to="/workspace" replace />} />
      <Route path="*" element={<Navigate to="/workspace" replace />} />
    </Routes>
  );
}
