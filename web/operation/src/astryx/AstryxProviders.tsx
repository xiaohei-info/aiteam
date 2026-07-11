import type { ReactNode } from "react";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import { aiteamStone } from "@aiteam/shared/theme";
import { RouterLinkAdapter } from "./RouterLinkAdapter";

export function AstryxProviders({ children }: { children: ReactNode }) {
  return (
    <Theme theme={aiteamStone} mode="system">
      <LinkProvider component={RouterLinkAdapter}>{children}</LinkProvider>
    </Theme>
  );
}
