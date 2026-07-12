import type { SVGProps } from "react";

type GlyphProps = SVGProps<SVGSVGElement>;

const glyphProps = {
  "aria-hidden": "true",
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.8,
  viewBox: "0 0 24 24",
} as const;

export function AttachmentIcon(props: GlyphProps): React.ReactNode {
  return (
    <svg {...glyphProps} {...props}>
      <path d="m8.5 12.5 6.7-6.7a3.25 3.25 0 1 1 4.6 4.6l-8.4 8.4a5 5 0 0 1-7.1-7.1l7.8-7.8" />
    </svg>
  );
}

export function AgentIcon(props: GlyphProps): React.ReactNode {
  return (
    <svg {...glyphProps} {...props}>
      <rect x="4" y="6" width="16" height="13" rx="3" />
      <path d="M12 3v3M8.5 11h.01M15.5 11h.01M8 15h8" />
    </svg>
  );
}

export function SkillIcon(props: GlyphProps): React.ReactNode {
  return (
    <svg {...glyphProps} {...props}>
      <path d="m12 3 1.35 5.15L18.5 9.5l-5.15 1.35L12 16l-1.35-5.15L5.5 9.5l5.15-1.35L12 3Z" />
      <path d="m18 16 .7 2.3L21 19l-2.3.7L18 22l-.7-2.3L15 19l2.3-.7L18 16Z" />
    </svg>
  );
}

export function ScreenshotIcon(props: GlyphProps): React.ReactNode {
  return (
    <svg {...glyphProps} {...props}>
      <path d="M8 4H6a2 2 0 0 0-2 2v2m12-4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2m8 0h2a2 2 0 0 0 2-2v-2" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
