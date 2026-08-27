import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./shell";
import { RequireAuth } from "./auth/RequireAuth";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPlaceholder } from "./pages/DashboardPlaceholder";
import { BoardPage, EnterpriseDetailPage } from "./features/board";
import { EnterprisePage } from "./features/enterprise";
import { EnterprisePageWired } from "./EnterprisePageWired";
import { CatalogPage, CatalogDetailPage } from "./features/catalog";
import { AccountsPage } from "./features/accounts";
import { FinancePage } from "./features/finance";
import { SolutionsPage } from "./features/solutions";
import { SystemHealthPage } from "./features/system-health";
import { SkillMarketPage } from "./features/skill-market/SkillMarketPage";
import { PlatformProvidersPage } from "./features/providers/PlatformProvidersPage";
import { GatewayPage } from "./features/gateway";

export function App(): React.ReactNode {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route path="/" element={<DashboardPlaceholder />} />
        <Route path="/enterprises" element={<EnterprisePageWired />} />
        <Route path="/accounts" element={<AccountsPage />} />
        {/* key 按 catalogType 区分，切换专家/行业方案两页时强制 CatalogPage 重挂载，
            避免注册表单状态（含已填内容）在两个注册流程间串页污染。 */}
        <Route path="/experts" element={<CatalogPage key="expert_template" catalogType="expert_template" titleKey="operation.nav.experts" registerKey="operation.catalog.registerExpert" />} />
        <Route path="/skill-market" element={<SkillMarketPage />} />
        <Route path="/providers" element={<PlatformProvidersPage />} />
        <Route path="/gateway" element={<GatewayPage />} />
        <Route path="/industry-solutions" element={<CatalogPage key="solution_template" catalogType="solution_template" titleKey="operation.nav.industrySolutions" registerKey="operation.catalog.registerSolution" />} />
        {/* 旧 /catalog 列表已拆分为 /experts + /industry-solutions，收藏夹重定向 */}
        <Route path="/catalog" element={<Navigate to="/experts" replace />} />
        <Route path="/catalog/:catalog_type/:template_id" element={<CatalogDetailPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/solutions" element={<SolutionsPage />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/board/:enterprise_id" element={<EnterpriseDetailPage />} />
        <Route path="/health" element={<SystemHealthPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
