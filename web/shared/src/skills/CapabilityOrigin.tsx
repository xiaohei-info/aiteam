import { forwardRef, type AnchorHTMLAttributes } from "react";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import type { CapabilityProvenance } from "./namespace.js";

/** A plain anchor: the consoles' LinkProvider routes in-app links, but an origin is always an external page. */
const ExternalAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function ExternalAnchor(props, ref) {
  return <a ref={ref} {...props} />;
});

/** 「来自 ClawHub steipete/weather ↗」/「改自 taiyim/weather v…」; nothing for our own content. Links open a new tab. */
export function CapabilityOrigin({ provenance }: { provenance: CapabilityProvenance | null | undefined }) {
  if (!provenance?.label) return null;
  const verb = provenance.edited ? "改自" : "来自";
  const version = provenance.edited && provenance.version ? ` v${provenance.version}` : "";
  return (
    <Text color="secondary" size="sm">
      {verb}{" "}
      {provenance.url
        ? <Link as={ExternalAnchor} href={provenance.url} target="_blank" rel="noopener noreferrer">{provenance.label} ↗</Link>
        : provenance.label}
      {version}
    </Text>
  );
}
