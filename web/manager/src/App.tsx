import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell";
import { RequireAuth } from "./auth/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPlaceholder } from "./pages/DashboardPlaceholder";
import { MembersPage } from "./features/members";
import { DepartmentsPage } from "./features/departments";
import { MarketplacePage } from "./features/marketplace";
import { SolutionsPage } from "./features/solutions";
import { ExpertsPage } from "./features/experts";
import { GrantsPage } from "./features/grants";
import { GovernancePage } from "./features/governance";
import { KnowledgePage } from "./features/knowledge";
import { CapabilityPage } from "./features/capability";
import { BillingPage, RechargePage } from "./features/billing";
import { MemoryPage } from "./features/memory-items";
import { ConnectorsPage } from "./features/connectors";
import { OrgPage } from "./features/org";
import { AuditPage } from "./features/audit";
import { SolutionApplyHistoryPage } from "./features/solution-apply";
import { SettingsPage } from "./features/settings";
import { SkillMarketPage } from "./features/skill-market/SkillMarketPage";

export function App(): React.ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route path="/" element={<DashboardPlaceholder />} />
        <Route path="/members" element={<MembersPage />} />
        <Route path="/departments" element={<DepartmentsPage />} />
        <Route path="/marketplace" element={<MarketplacePage />} />
        <Route path="/solutions" element={<SolutionsPage />} />
        <Route path="/experts" element={<ExpertsPage />} />
        <Route path="/grants" element={<GrantsPage />} />
        <Route path="/governance" element={<GovernancePage />} />
        <Route path="/knowledge" element={<KnowledgePage />} />
        <Route path="/capability" element={<CapabilityPage />} />
        <Route path="/skill-market" element={<SkillMarketPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/recharge" element={<RechargePage />} />
        <Route path="/memory" element={<MemoryPage />} />
        <Route path="/connectors" element={<ConnectorsPage />} />
        <Route path="/org" element={<OrgPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/solution-apply" element={<SolutionApplyHistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
