import { describe, expect, it } from "vitest";
import { agentShellConfig } from "./nav";

describe("agent navigation", () => {
  it("does not advertise the removed Agent-local knowledge page", () => {
    const nav = agentShellConfig.nav;

    expect(nav.map((item) => item.id)).toEqual([
      "workspace",
      "private-chat",
      "group-chat",
      "marketplace",
      "office",
      "settings",
      "org",
      "sync",
    ]);
    expect(nav.map((item) => item.path)).not.toContain("/knowledge");
  });
});
