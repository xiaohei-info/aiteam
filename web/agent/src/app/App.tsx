/**
 * 应用根（08 §12.2）。装配 BrowserRouter + AppProvider + 路由。
 */

import { BrowserRouter } from "react-router-dom";

import { AppProvider } from "../lib/app-context";
import { AppRoutes } from "./routes";

export function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <AppRoutes />
      </AppProvider>
    </BrowserRouter>
  );
}
