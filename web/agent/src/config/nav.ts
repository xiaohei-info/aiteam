/** 用户端 PageShell 导航配置（08 §12.2 / page-shell）。本端差异配置位。 */
import type { PageShellConfig } from "@aiteam/shared/page-shell";

export const agentShellConfig: PageShellConfig = {
  tier: "agent",
  titleKey: "agent.title",
  nav: [
    { id: "workspace", labelKey: "agent.nav.workspace", path: "/workspace", icon: "grid" },
    { id: "private-chat", labelKey: "agent.nav.private_chat", path: "/chat", icon: "message" },
    { id: "group-chat", labelKey: "agent.nav.group_chat", path: "/group", icon: "users" },
  ],
};
