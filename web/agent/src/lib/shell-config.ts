/**
 * 用户端 PageShell 配置（08 §12.2 / page-shell）。
 *
 * 导航项对齐本端路由；requiredRoles 为空 = 登录即可见。
 * 后续私聊/群聊页（W-A.2/W-A.3）在此补真实路由与组件。
 */

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
