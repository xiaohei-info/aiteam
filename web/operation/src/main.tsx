/**
 * 运营端前端入口（08 §12.1）。
 *
 * 三套独立前端工程之一：只调本端 /api/operation/* 与 /api/auth/*（同 origin），
 * 公共能力复用 @aiteam/shared（page-shell / api-client / role-state / i18n / 设计系统）。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AppProviders } from "./AppProviders";
import "./styles/global.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProviders>
        <App />
      </AppProviders>
    </BrowserRouter>
  </React.StrictMode>,
);
