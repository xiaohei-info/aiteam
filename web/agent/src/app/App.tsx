/** 应用根。装配全局 providers + 路由。 */
import { AppProviders } from "./providers";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  );
}
