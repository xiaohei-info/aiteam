import { useState, type ReactNode } from "react";

export type DigitalEmployeeAvatarVariant = "employee" | "human";

export interface DigitalEmployeeAvatarProps {
  /** Display name used to choose a deterministic illustration preset. */
  name?: string | null;
  /** Optional same-origin uploaded avatar. External URLs intentionally fall back to the illustration. */
  src?: string | null;
  /** Avatar box size in pixels. */
  size?: number;
  /** Human messages use a neutral illustration while employee messages use the full identity treatment. */
  variant?: DigitalEmployeeAvatarVariant;
}

type AvatarPreset = "research" | "finance" | "legal" | "service" | "operations";

const PRESETS: AvatarPreset[] = ["research", "finance", "legal", "service", "operations"];

/**
 * Small, original line-art avatar used across all three AI Team frontends.
 * It borrows StaffDeck's visual language without copying its AGPL assets/code.
 */
export function DigitalEmployeeAvatar({ name, src, size = 48, variant = "employee" }: DigitalEmployeeAvatarProps): ReactNode {
  const [imageFailed, setImageFailed] = useState(false);
  const label = name?.trim() || (variant === "human" ? "我" : "数字员工");
  const candidate = src?.trim();
  const imageSrc = candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : undefined;
  const preset = presetFor(label, variant);

  return (
    <span
      data-aiteam-avatar="true"
      data-aiteam-avatar-preset={preset}
      data-aiteam-avatar-variant={variant}
      aria-hidden="true"
      style={{
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        flex: "0 0 auto",
        overflow: "hidden",
        alignItems: "flex-end",
        justifyContent: "center",
        border: "2px solid var(--color-background-card, #fff)",
        borderRadius: Math.max(10, Math.round(size * 0.28)),
        background: "var(--color-background-gray, #f0f0ef)",
        boxShadow: "var(--shadow-low, 0 5px 14px rgba(37, 32, 24, 0.12))",
      }}
    >
      {imageSrc && !imageFailed ? (
        <img
          src={imageSrc}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <AvatarIllustration preset={preset} variant={variant} />
      )}
    </span>
  );
}

function presetFor(name: string, variant: DigitalEmployeeAvatarVariant): AvatarPreset {
  if (variant === "human") return "operations";
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return PRESETS[hash % PRESETS.length]!;
}

function AvatarIllustration({ preset, variant }: { preset: AvatarPreset; variant: DigitalEmployeeAvatarVariant }): ReactNode {
  const hair = preset === "finance"
    ? <path d="M32 53c-4-17 6-34 28-35 18-1 30 12 28 31-6-4-10-10-13-18-12 10-26 14-43 14Z" fill="#171717" />
    : preset === "legal"
      ? <path d="M29 57c-2-26 10-39 31-39s33 14 31 39c-4-3-8-7-11-13-6 8-15 12-28 13-8 0-16 1-23 0Z" fill="#171717" />
      : preset === "service"
        ? <path d="M31 52c-2-20 10-35 29-35 16 0 29 11 29 32-8-5-13-13-15-22-10 8-23 13-43 12Z" fill="#171717" />
        : <path d="M31 54c-3-22 9-37 29-37 20 0 32 14 29 38-5-7-9-13-11-22-10 11-25 16-47 21Z" fill="#171717" />;

  return (
    <svg width="100%" height="100%" viewBox="0 0 120 120" role="presentation" xmlns="http://www.w3.org/2000/svg">
      <rect width="120" height="120" fill="#f4f4f2" />
      <path d="M15 121c4-23 18-36 45-36s41 13 45 36H15Z" fill={variant === "human" ? "#dfe4e8" : "#fff"} stroke="#171717" strokeWidth="3" strokeLinejoin="round" />
      <path d="M50 77v15l10 9 10-9V77" fill="#fff" stroke="#171717" strokeWidth="2.5" />
      <path d="M44 90 60 106 76 90" fill="none" stroke="#171717" strokeWidth="2.5" />
      <circle cx="39" cy="61" r="6" fill="#fff" stroke="#171717" strokeWidth="2.5" />
      <circle cx="81" cy="61" r="6" fill="#fff" stroke="#171717" strokeWidth="2.5" />
      <path d="M40 47c0-15 9-26 20-26s20 11 20 26v20c0 14-9 24-20 24S40 81 40 67V47Z" fill="#fff" stroke="#171717" strokeWidth="3" />
      {hair}
      {preset === "research" ? (
        <>
          <circle cx="51" cy="59" r="8" fill="#fff" stroke="#171717" strokeWidth="2.5" />
          <circle cx="69" cy="59" r="8" fill="#fff" stroke="#171717" strokeWidth="2.5" />
          <path d="M59 59h2M43 58h-4M77 58h4" fill="none" stroke="#171717" strokeWidth="2" />
        </>
      ) : (
        <>
          <circle cx="52" cy="59" r="2.3" fill="#171717" />
          <circle cx="68" cy="59" r="2.3" fill="#171717" />
        </>
      )}
      <path d="M58 60c-1 5-2 8-4 10m-3 4c5 4 13 4 18 0" fill="none" stroke="#171717" strokeWidth="2.2" strokeLinecap="round" />
      {preset === "finance" ? <path d="M31 48c4 11 4 24 2 38" fill="none" stroke="#171717" strokeWidth="4" strokeLinecap="round" /> : null}
      {preset === "legal" ? <path d="M83 48c6 7 8 19 6 31" fill="none" stroke="#171717" strokeWidth="4" strokeLinecap="round" /> : null}
      {preset === "service" ? <path d="M35 51c-6 1-8 5-8 10m8-2c-4 2-5 7-3 11" fill="none" stroke="#171717" strokeWidth="2.5" strokeLinecap="round" /> : null}
      {preset === "operations" ? <path d="M47 96h26" fill="none" stroke="#171717" strokeWidth="2.5" strokeLinecap="round" /> : null}
    </svg>
  );
}
