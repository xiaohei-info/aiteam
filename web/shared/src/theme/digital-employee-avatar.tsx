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
type Expression = "smile" | "open" | "soft";

type AvatarPalette = {
  key: string;
  background: string;
  shirt: string;
  shirtEdge: string;
  skin: string;
  skinShadow: string;
  hair: string;
};

const SAFE_INLINE_AVATAR = /^data:image\/(?:gif|jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
const MAX_INLINE_AVATAR_LENGTH = 3_000_000;

type AvatarTraits = {
  palette: AvatarPalette;
  preset: AvatarPreset;
  face: FaceShape;
  hair: HairStyle;
  glasses: GlassesStyle;
  outfit: OutfitStyle;
  accessory: Accessory;
  expression: Expression;
  styleId: string;
};

const PRESETS = ["research", "finance", "legal", "service", "operations"] as const;
const FACES = ["round", "oval", "square"] as const;
const HAIR = ["swoop", "bob", "crop", "bun", "side", "waves"] as const;
const GLASSES = ["none", "round", "square", "reading"] as const;
const OUTFITS = ["collar", "crew", "jacket", "turtleneck"] as const;
const ACCESSORIES = ["none", "earring", "badge", "headset"] as const;
const EXPRESSIONS = ["smile", "open", "soft"] as const;

// Original palette inspired by StaffDeck's friendly, colorful employee identity treatment.
const PALETTES: readonly AvatarPalette[] = [
  { key: "teal", background: "#2bbbd4", shirt: "#d8f1f4", shirtEdge: "#087f8c", skin: "#f6c7b2", skinShadow: "#df9b8a", hair: "#2a221e" },
  { key: "coral", background: "#ff6a64", shirt: "#ffd7d1", shirtEdge: "#c94745", skin: "#f2c1ad", skinShadow: "#d78b7e", hair: "#2c211e" },
  { key: "gold", background: "#f2c65c", shirt: "#fff0bd", shirtEdge: "#a4771f", skin: "#edbd9f", skinShadow: "#d18d79", hair: "#30251f" },
  { key: "olive", background: "#8ca65d", shirt: "#e4edc8", shirtEdge: "#4f6938", skin: "#dba181", skinShadow: "#bd735e", hair: "#2d2923" },
  { key: "blue", background: "#628ee8", shirt: "#dfeaff", shirtEdge: "#345ca7", skin: "#f3c8ae", skinShadow: "#da9a85", hair: "#252834" },
  { key: "purple", background: "#9b7bc8", shirt: "#eadff5", shirtEdge: "#604682", skin: "#edc1ab", skinShadow: "#d59583", hair: "#2c2431" },
  { key: "copper", background: "#d07f4e", shirt: "#ffe1ca", shirtEdge: "#8e4f2d", skin: "#eab492", skinShadow: "#c97e68", hair: "#342822" },
  { key: "mint", background: "#53b692", shirt: "#d5f0e1", shirtEdge: "#28785f", skin: "#efc0a6", skinShadow: "#d58e7c", hair: "#262a25" },
];

/**
 * Small, original colored upper-body avatar used across all three AI Team frontends.
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
  const imageSrc = candidate?.startsWith("/") && !candidate.startsWith("//")
    ? candidate
    : candidate && candidate.length <= MAX_INLINE_AVATAR_LENGTH && SAFE_INLINE_AVATAR.test(candidate)
      ? candidate
      : undefined;

  return (
    <span
      data-aiteam-avatar="true"
      data-aiteam-avatar-palette={traits.palette.key}
      data-aiteam-avatar-preset={traits.preset}
      data-aiteam-avatar-expression={traits.expression}
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
        borderRadius: "999px",
        background: traits.palette.background,
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
  const palette = choose(PALETTES);
  const preset = variant === "human" ? "operations" : choose(PRESETS);
  const face = choose(FACES);
  const hair = choose(HAIR);
  const glasses = choose(GLASSES);
  const outfit = choose(OUTFITS);
  const accessory = choose(ACCESSORIES);
  const expression = choose(EXPRESSIONS);
  const styleId = [palette.key, preset, face, hair, glasses, outfit, accessory, expression].join("-");
  return { palette, preset, face, hair, glasses, outfit, accessory, expression, styleId };
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
      <rect width="120" height="120" fill={traits.palette.background} />
      <circle cx="93" cy="18" r="30" fill="#fff" opacity="0.18" />
      <circle cx="19" cy="105" r="36" fill="#171717" opacity="0.07" />
      {renderOutfit(traits)}
      <path d="M50 77v15l10 9 10-9V77" fill={traits.palette.skin} stroke="#171717" strokeWidth="2.5" />
      <path d="M44 90 60 106 76 90" fill="none" stroke={traits.palette.shirtEdge} strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx="39" cy="61" r="6" fill={traits.palette.skin} stroke="#171717" strokeWidth="2.5" />
      <circle cx="81" cy="61" r="6" fill={traits.palette.skin} stroke="#171717" strokeWidth="2.5" />
      {renderFace(traits)}
      {renderHair(traits)}
      {renderEyesAndMouth(traits)}
      {renderGlasses(traits.glasses)}
      {renderPresetDetail(traits)}
      {renderAccessory(traits)}
      {variant === "human" ? <path d="M47 96h26" fill="none" stroke={traits.palette.shirtEdge} strokeWidth="2.5" strokeLinecap="round" /> : null}
    </svg>
  );
}

function renderOutfit(traits: AvatarTraits): ReactNode {
  const { palette } = traits;
  const base = <path d="M12 121c5-24 20-37 48-37s43 13 48 37H12Z" fill={palette.shirt} stroke="#171717" strokeWidth="3" strokeLinejoin="round" />;
  switch (traits.outfit) {
    case "crew":
      return <>{base}<path d="M48 88c3 7 21 7 24 0" fill="none" stroke={palette.shirtEdge} strokeWidth="3" strokeLinecap="round" /></>;
    case "jacket":
      return <>{base}<path d="M60 86v35M43 90l17 16 17-16" fill="none" stroke={palette.shirtEdge} strokeWidth="3" strokeLinejoin="round" /><path d="M28 102c7-6 13-9 19-11M92 102c-7-6-13-9-19-11" fill="none" stroke="#171717" strokeWidth="2" strokeLinecap="round" /></>;
    case "turtleneck":
      return <>{base}<path d="M48 86c1 8 23 8 24 0v8c-3 6-21 6-24 0Z" fill={palette.shirtEdge} stroke="#171717" strokeWidth="2.5" /></>;
    case "collar":
    default:
      return <>{base}<path d="M50 87 60 101 70 87" fill={palette.shirtEdge} stroke="#171717" strokeWidth="2.5" strokeLinejoin="round" /></>;
  }
}

function renderFace(traits: AvatarTraits): ReactNode {
  const { skin, skinShadow } = traits.palette;
  const face = traits.face === "round"
    ? "M40 47c0-15 9-26 20-26s20 11 20 26v20c0 14-9 24-20 24S40 81 40 67V47Z"
    : traits.face === "square"
      ? "M40 48c0-15 9-25 20-25s20 10 20 25v20c0 14-8 23-20 23S40 82 40 68V48Z"
      : "M43 45c0-15 7-24 17-24s17 9 17 24v24c0 14-7 22-17 22s-17-8-17-22V45Z";
  return <><path d={face} fill={skin} stroke="#2d2622" strokeWidth="2.5" strokeLinejoin="round" /><circle cx="47" cy="70" r="3" fill={skinShadow} opacity="0.35" /><circle cx="73" cy="70" r="3" fill={skinShadow} opacity="0.35" /></>;
}

function renderHair(traits: AvatarTraits): ReactNode {
  const fill = traits.palette.hair;
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
  const eyes = <><circle cx="52" cy="59" r="3.2" fill="#171717" /><circle cx="68" cy="59" r="3.2" fill="#171717" /><circle cx="53" cy="58" r="1.1" fill="#fff" /><circle cx="69" cy="58" r="1.1" fill="#fff" /></>;
  const nose = <path d="M60 61c0 4-1 7-3 9l3 1" fill="none" stroke="#2d2622" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />;
  const mouth = traits.expression === "open"
    ? <><path d="M52 73c5 5 11 5 16 0-1 8-15 8-16 0Z" fill={traits.palette.shirtEdge} stroke="#2d2622" strokeWidth="1.8" /><path d="M55 77h10" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></>
    : traits.expression === "soft"
      ? <path d="M55 75c3 2 7 2 10 0" fill="none" stroke="#2d2622" strokeWidth="1.8" strokeLinecap="round" />
      : <path d="M52 73c5 5 11 5 16 0" fill="none" stroke="#2d2622" strokeWidth="1.8" strokeLinecap="round" />;
  return <>{eyes}{nose}{mouth}</>;
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

function renderAccessory(traits: AvatarTraits): ReactNode {
  const { shirtEdge } = traits.palette;
  switch (traits.accessory) {
    case "earring":
      return <><circle cx="39" cy="72" r="2.5" fill={shirtEdge} stroke="#171717" strokeWidth="1.5" /><circle cx="81" cy="72" r="2.5" fill={shirtEdge} stroke="#171717" strokeWidth="1.5" /></>;
    case "badge":
      return <><rect x="84" y="98" width="8" height="10" rx="1.5" fill="#fff" stroke={shirtEdge} strokeWidth="1.8" /><path d="M86 101h4M86 104h3" stroke={shirtEdge} strokeWidth="1.2" strokeLinecap="round" /></>;
    case "headset":
      return <><path d="M35 60c0-17 10-27 25-27s25 10 25 27" fill="none" stroke={shirtEdge} strokeWidth="2.5" /><path d="M33 59v10M87 59v10" stroke={shirtEdge} strokeWidth="3" strokeLinecap="round" /></>;
    case "none":
    default:
      return null;
  }
}
