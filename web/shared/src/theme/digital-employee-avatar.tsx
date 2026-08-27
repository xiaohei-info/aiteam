import { useState, type ReactNode } from "react";

export type DigitalEmployeeAvatarVariant = "employee" | "human";

export interface DigitalEmployeeAvatarProps {
  /** Display name used as the default stable seed for the illustration. */
  name?: string | null;
  /** Optional explicit stable seed when two people share a display name. */
  seed?: string | number | null;
  /** Optional same-origin uploaded avatar. External URLs intentionally fall back to the illustration. */
  src?: string | null;
  /** Avatar box size in pixels. */
  size?: number;
  /** Human messages use a neutral illustration while employee messages use the full identity treatment. */
  variant?: DigitalEmployeeAvatarVariant;
}

type AvatarPreset = "research" | "finance" | "legal" | "service" | "operations";
type FaceShape = "round" | "oval" | "square";
type HairStyle = "swoop" | "bob" | "crop" | "bun" | "side" | "waves";
type GlassesStyle = "none" | "round" | "square" | "reading";
type OutfitStyle = "collar" | "crew" | "jacket" | "turtleneck";
type Accessory = "none" | "earring" | "badge" | "headset";

type AvatarTraits = {
  preset: AvatarPreset;
  face: FaceShape;
  hair: HairStyle;
  glasses: GlassesStyle;
  outfit: OutfitStyle;
  accessory: Accessory;
  background: string;
  faceFill: string;
  shirtFill: string;
  hairFill: string;
  styleId: string;
};

const PRESETS = ["research", "finance", "legal", "service", "operations"] as const;
const FACES = ["round", "oval", "square"] as const;
const HAIR = ["swoop", "bob", "crop", "bun", "side", "waves"] as const;
const GLASSES = ["none", "round", "square", "reading"] as const;
const OUTFITS = ["collar", "crew", "jacket", "turtleneck"] as const;
const ACCESSORIES = ["none", "earring", "badge", "headset"] as const;
const BACKGROUNDS = ["#f4f4f2", "#eceeec", "#f7f6f3", "#e9ecef", "#f0efed"] as const;
const FACE_FILLS = ["#ffffff", "#f8f8f6", "#efefed"] as const;
const SHIRT_FILLS = ["#ffffff", "#f0f1ef", "#e5e8e8", "#e9e7e3"] as const;
const HAIR_FILLS = ["#171717", "#242424", "#303030"] as const;

/**
 * Small, original line-art avatar used across all three AI Team frontends.
 * It borrows StaffDeck's visual language without copying its AGPL assets/code.
 */
export function DigitalEmployeeAvatar({
  name,
  seed,
  src,
  size = 48,
  variant = "employee",
}: DigitalEmployeeAvatarProps): ReactNode {
  const [imageFailed, setImageFailed] = useState(false);
  const label = name?.trim() || (variant === "human" ? "我" : "数字员工");
  const seedValue = seed == null ? label : String(seed);
  const traits = avatarTraitsFor(`${variant}:${seedValue}`, variant);
  const candidate = src?.trim();
  const imageSrc = candidate?.startsWith("/") && !candidate.startsWith("//") ? candidate : undefined;

  return (
    <span
      data-aiteam-avatar="true"
      data-aiteam-avatar-preset={traits.preset}
      data-aiteam-avatar-style={traits.styleId}
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
        <AvatarIllustration traits={traits} variant={variant} />
      )}
    </span>
  );
}

function avatarTraitsFor(seed: string, variant: DigitalEmployeeAvatarVariant): AvatarTraits {
  const random = seededRandom(hashSeed(seed));
  const choose = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const preset = variant === "human" ? "operations" : choose(PRESETS);
  const face = choose(FACES);
  const hair = choose(HAIR);
  const glasses = choose(GLASSES);
  const outfit = choose(OUTFITS);
  const accessory = choose(ACCESSORIES);
  const background = choose(BACKGROUNDS);
  const faceFill = choose(FACE_FILLS);
  const shirtFill = variant === "human" ? "#dfe4e8" : choose(SHIRT_FILLS);
  const hairFill = choose(HAIR_FILLS);
  const styleId = [preset, face, hair, glasses, outfit, accessory].join("-");
  return { preset, face, hair, glasses, outfit, accessory, background, faceFill, shirtFill, hairFill, styleId };
}

function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 0x6d2b79f5;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function AvatarIllustration({ traits, variant }: { traits: AvatarTraits; variant: DigitalEmployeeAvatarVariant }): ReactNode {
  return (
    <svg width="100%" height="100%" viewBox="0 0 120 120" role="presentation" xmlns="http://www.w3.org/2000/svg">
      <rect width="120" height="120" fill={traits.background} />
      {renderOutfit(traits)}
      <path d="M50 77v15l10 9 10-9V77" fill={traits.faceFill} stroke="#171717" strokeWidth="2.5" />
      <path d="M44 90 60 106 76 90" fill="none" stroke="#171717" strokeWidth="2.5" />
      <circle cx="39" cy="61" r="6" fill={traits.faceFill} stroke="#171717" strokeWidth="2.5" />
      <circle cx="81" cy="61" r="6" fill={traits.faceFill} stroke="#171717" strokeWidth="2.5" />
      {renderFace(traits)}
      {renderHair(traits)}
      {renderEyesAndMouth(traits)}
      {renderGlasses(traits.glasses)}
      {renderPresetDetail(traits)}
      {renderAccessory(traits.accessory)}
      {variant === "human" ? <path d="M47 96h26" fill="none" stroke="#171717" strokeWidth="2.5" strokeLinecap="round" /> : null}
    </svg>
  );
}

function renderOutfit(traits: AvatarTraits): ReactNode {
  const base = <path d="M15 121c4-23 18-36 45-36s41 13 45 36H15Z" fill={traits.shirtFill} stroke="#171717" strokeWidth="3" strokeLinejoin="round" />;
  switch (traits.outfit) {
    case "crew":
      return <>{base}<path d="M48 88c3 7 21 7 24 0" fill="none" stroke="#171717" strokeWidth="2.5" strokeLinecap="round" /></>;
    case "jacket":
      return <>{base}<path d="M60 87v34M44 91l16 15 16-15" fill="none" stroke="#171717" strokeWidth="2.5" strokeLinejoin="round" /></>;
    case "turtleneck":
      return <>{base}<path d="M48 86c1 8 23 8 24 0v8c-3 6-21 6-24 0Z" fill={traits.faceFill} stroke="#171717" strokeWidth="2.5" /></>;
    case "collar":
    default:
      return <>{base}<path d="M50 87 60 101 70 87" fill={traits.faceFill} stroke="#171717" strokeWidth="2.5" strokeLinejoin="round" /></>;
  }
}

function renderFace(traits: AvatarTraits): ReactNode {
  if (traits.face === "round") {
    return <path d="M40 47c0-15 9-26 20-26s20 11 20 26v20c0 14-9 24-20 24S40 81 40 67V47Z" fill={traits.faceFill} stroke="#171717" strokeWidth="3" />;
  }
  if (traits.face === "square") {
    return <path d="M40 48c0-15 9-25 20-25s20 10 20 25v20c0 14-8 23-20 23S40 82 40 68V48Z" fill={traits.faceFill} stroke="#171717" strokeWidth="3" strokeLinejoin="round" />;
  }
  return <path d="M43 45c0-15 7-24 17-24s17 9 17 24v24c0 14-7 22-17 22s-17-8-17-22V45Z" fill={traits.faceFill} stroke="#171717" strokeWidth="3" />;
}

function renderHair(traits: AvatarTraits): ReactNode {
  const fill = traits.hairFill;
  switch (traits.hair) {
    case "bob":
      return <path d="M31 58c-3-25 9-41 29-41 20 0 32 16 29 42-4-5-8-12-10-22-11 9-25 14-47 21Zm4 4c-2 12-1 20 3 28l8-6-3-22Zm50 0c2 12 1 20-3 28l-8-6 3-22Z" fill={fill} />;
    case "crop":
      return <path d="M33 51c0-18 10-34 27-34 18 0 28 14 27 32-8-3-14-8-18-15-8 8-20 13-36 17Z" fill={fill} />;
    case "bun":
      return <><circle cx="86" cy="22" r="10" fill={fill} /><path d="M31 54c-3-22 9-37 29-37 20 0 32 14 29 38-6-7-10-13-12-22-10 11-25 16-46 21Z" fill={fill} /></>;
    case "side":
      return <path d="M30 55c-2-25 10-38 31-38 17 0 28 11 28 31-8-4-13-10-17-19-8 9-19 16-42 26Zm2 4c-4 8-4 17-1 25l9-8-3-18Z" fill={fill} />;
    case "waves":
      return <path d="M31 54c-3-22 9-37 29-37 20 0 32 14 29 38-5-7-9-13-11-22-10 11-25 16-47 21Z" fill={fill} />;
    case "swoop":
    default:
      return <path d="M30 52c-2-20 10-35 29-35 16 0 29 11 29 32-8-5-13-13-15-22-10 8-23 13-43 12Z" fill={fill} />;
  }
}

function renderEyesAndMouth(traits: AvatarTraits): ReactNode {
  const eyes = traits.glasses === "none"
    ? <><circle cx="52" cy="59" r="2.3" fill="#171717" /><circle cx="68" cy="59" r="2.3" fill="#171717" /></>
    : <><path d="M48 59h8M64 59h8" stroke="#171717" strokeWidth="2.2" strokeLinecap="round" /></>;
  return <>{eyes}<path d="M58 60c-1 5-2 8-4 10m-3 4c5 4 13 4 18 0" fill="none" stroke="#171717" strokeWidth="2.2" strokeLinecap="round" /></>;
}

function renderGlasses(style: GlassesStyle): ReactNode {
  switch (style) {
    case "round":
      return <><circle cx="51" cy="59" r="8" fill="none" stroke="#171717" strokeWidth="2.5" /><circle cx="69" cy="59" r="8" fill="none" stroke="#171717" strokeWidth="2.5" /><path d="M59 59h2M43 58h-4M77 58h4" fill="none" stroke="#171717" strokeWidth="2" /></>;
    case "square":
      return <><rect x="43" y="52" width="16" height="13" rx="3" fill="none" stroke="#171717" strokeWidth="2.5" /><rect x="61" y="52" width="16" height="13" rx="3" fill="none" stroke="#171717" strokeWidth="2.5" /><path d="M59 58h2M43 57h-4M77 57h4" fill="none" stroke="#171717" strokeWidth="2" /></>;
    case "reading":
      return <path d="M47 70h11M62 70h11M58 70h4" fill="none" stroke="#171717" strokeWidth="2.2" strokeLinecap="round" />;
    case "none":
    default:
      return null;
  }
}

function renderPresetDetail(traits: AvatarTraits): ReactNode {
  switch (traits.preset) {
    case "finance":
      return <path d="M31 48c4 11 4 24 2 38" fill="none" stroke="#171717" strokeWidth="4" strokeLinecap="round" />;
    case "legal":
      return <path d="M83 48c6 7 8 19 6 31" fill="none" stroke="#171717" strokeWidth="4" strokeLinecap="round" />;
    case "service":
      return <path d="M35 51c-6 1-8 5-8 10m8-2c-4 2-5 7-3 11" fill="none" stroke="#171717" strokeWidth="2.5" strokeLinecap="round" />;
    case "research":
      return <path d="M43 48c5-4 10-5 17-5" fill="none" stroke="#171717" strokeWidth="2" strokeLinecap="round" />;
    case "operations":
    default:
      return null;
  }
}

function renderAccessory(accessory: Accessory): ReactNode {
  switch (accessory) {
    case "earring":
      return <><circle cx="39" cy="72" r="2.5" fill="none" stroke="#171717" strokeWidth="2" /><circle cx="81" cy="72" r="2.5" fill="none" stroke="#171717" strokeWidth="2" /></>;
    case "badge":
      return <><rect x="84" y="98" width="8" height="10" rx="1.5" fill="#fff" stroke="#171717" strokeWidth="1.8" /><path d="M86 101h4M86 104h3" stroke="#171717" strokeWidth="1.2" strokeLinecap="round" /></>;
    case "headset":
      return <><path d="M35 60c0-17 10-27 25-27s25 10 25 27" fill="none" stroke="#171717" strokeWidth="2" /><path d="M33 59v10M87 59v10" stroke="#171717" strokeWidth="3" strokeLinecap="round" /></>;
    case "none":
    default:
      return null;
  }
}
