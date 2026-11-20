import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CapabilityOrigin } from "./CapabilityOrigin";
import { capabilityTitle, provenanceText } from "./namespace";

describe("capability namespace and provenance", () => {
  it("prefixes our namespace and leaves unchanged third-party content bare", () => {
    expect(capabilityTitle("taiyim", "weather")).toBe("taiyim/weather");
    expect(capabilityTitle("", "weather")).toBe("weather");
    expect(capabilityTitle(undefined, "weather")).toBe("weather");
  });

  it("cites where content came from or what it was edited from", () => {
    expect(provenanceText(null)).toBe("");
    expect(provenanceText({ kind: "clawhub", label: "ClawHub steipete/weather", edited: false })).toBe("来自 ClawHub steipete/weather");
    expect(provenanceText({ kind: "platform", label: "taiyim/weather", version: "8c2d", edited: true })).toBe("改自 taiyim/weather v8c2d");
  });

  it("opens the origin in a new tab", () => {
    render(<CapabilityOrigin provenance={{ kind: "clawhub", label: "ClawHub steipete/weather", url: "https://clawhub.ai/steipete/skills/weather", edited: false }} />);
    const link = screen.getByRole("link", { name: /ClawHub steipete\/weather/ });
    expect(link).toHaveAttribute("href", "https://clawhub.ai/steipete/skills/weather");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
