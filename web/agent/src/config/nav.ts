import type { PageShellConfig } from "@aiteam/shared/page-shell";

export const agentShellConfig: PageShellConfig = {
  tier: "agent",
  titleKey: "agent.title",
  nav: [
    { id: "workspace", labelKey: "agent.nav.workspace", path: "/workspace", icon: "grid" },
    { id: "private-chat", labelKey: "agent.nav.private_chat", path: "/chat", icon: "message" },
    { id: "group-chat", labelKey: "agent.nav.group_chat", path: "/group", icon: "users" },
    { id: "marketplace", labelKey: "agent.nav.marketplace", path: "/marketplace", icon: "grid" },
    { id: "knowledge", labelKey: "agent.nav.knowledge", path: "/knowledge", icon: "catalog" },
    { id: "office", labelKey: "agent.nav.office", path: "/office", icon: "dashboard" },
    { id: "settings", labelKey: "agent.nav.settings", path: "/settings", icon: "settings" },
    { id: "org", labelKey: "agent.nav.org", path: "/org", icon: "sitemap" },
    { id: "sync", labelKey: "agent.nav.sync", path: "/sync", icon: "refresh" },
  ],
};
