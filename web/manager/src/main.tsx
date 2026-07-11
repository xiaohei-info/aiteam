/**
 * 企业端前端入口（08 §12.1）。
 *
 * 三套独立前端工程之一：只调本端 /api/manager/* 与 /api/auth/*（同 origin），
 * 公共能力复用 @aiteam/shared（api-client / role-state / app-kit），界面统一使用 Astryx。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ErrorBoundary, QueryProvider } from "@aiteam/shared/app-kit";
import { App } from "./App";
import { AppProviders } from "./AppProviders";
import { AstryxProviders } from "./astryx/AstryxProviders";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={
        <div role="alert" style={{ padding: 24, color: "var(--astryx-color-text-danger)" }}>
          应用出错，请刷新重试。
        </div>
      }
    >
      <QueryProvider>
        <BrowserRouter>
          <AstryxProviders>
            <AppProviders>
              <App />
            </AppProviders>
          </AstryxProviders>
        </BrowserRouter>
      </QueryProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
