import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
// 旧 tokens.css 暂留（Phase 2 #127 清理）；新增 app.css 接入 Tailwind v4 + shared 黑金 token
// CSS，使本次集成确认真实经过 Tailwind 编译。
import "./styles/tokens.css";
import "./styles/app.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
