import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell";
import { RequireAuth } from "./auth/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPlaceholder } from "./pages/DashboardPlaceholder";
import { MembersPage } from "./features/members";
import { ExpertsPage } from "./features/experts";
import { MarketplacePage } from "./features/marketplace";
import { SolutionsPage } from "./features/solutions";
import { GrantsPage } from "./features/grants";
import { GovernancePage } from "./features/governance";
import { ProvidersPage } from "./features/providers";
import { KnowledgePage } from "./features/knowledge";
import { CapabilityPage } from "./features/capability";
import { BillingPage, RechargePage } from "./features/billing";
import { LlmPage } from "./features/llm";
import { MemoryPage } from "./features/memory-items";
import { ConnectorsPage } from "./features/connectors";
import { OrgPage } from "./features/org";
import { CollaborationPage } from "./features/collaboration";
import { AuditPage } from "./features/audit";
import { SolutionApplyHistoryPage } from "./features/solution-apply";
import { SettingsPage } from "./features/settings";

export function App(): React.ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route path="/" element={<DashboardPlaceholder />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/marketplace" element={<MarketplacePage />} />
        <Route path="/solutions" element={<SolutionsPage />} />
        <Route path="/experts" element={<ExpertsPage />} />
        <Route path="/grants" element={<GrantsPage />} />
        <Route path="/governance" element={<GovernancePage />} />
        <Route path="/providers" element={<ProvidersPage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/capability" element={<CapabilityPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/recharge" element={<RechargePage />} />
        <Route path="/llm" element={<LlmPage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/connectors" element={<ConnectorsPage />} />
        <Route path="/org" element={<OrgPage />} />
        <Route path="/collaboration" element={<CollaborationPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/solution-apply" element={<SolutionApplyHistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
