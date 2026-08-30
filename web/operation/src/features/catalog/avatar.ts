const AVATAR_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Maximum decoded bytes accepted for an Operator catalog avatar. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function hasImageSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === "image/png") {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/gif") {
    const header = new TextDecoder().decode(bytes.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  if (mimeType === "image/webp") {
    const riff = new TextDecoder().decode(bytes.slice(0, 4));
    const webp = new TextDecoder().decode(bytes.slice(8, 12));
    return bytes.length >= 12 && riff === "RIFF" && webp === "WEBP";
  }
  return false;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function dataUrlParts(value: string): { mimeType: string; encoded: string } | null {
  const match = /^data:(image\/(?:gif|jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(value);
  if (!match || !match[2]) return null;
  return { mimeType: match[1]!, encoded: match[2] };
}

/** Validate a server-provided inline avatar before allowing it into an <img>. */
export function isSafeAvatarDataUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = dataUrlParts(value);
  if (!parts || !AVATAR_MIME_TYPES.has(parts.mimeType)) return false;
  try {
    const decoded = atob(parts.encoded);
    if (btoa(decoded) !== parts.encoded || decoded.length > AVATAR_MAX_BYTES) return false;
    return hasImageSignature(parts.mimeType, Uint8Array.from(decoded, (character) => character.charCodeAt(0)));
  } catch {
    return false;
  }
}

/** Read a user-selected image and return the legacy Catalog avatar field encoding. */
export async function readAvatarFile(file: File): Promise<string> {
  if (!AVATAR_MIME_TYPES.has(file.type)) {
    throw new Error("头像仅支持 PNG、JPEG、GIF 或 WEBP 图片");
  }
  if (file.size > AVATAR_MAX_BYTES) {
    throw new Error("头像图片不能超过 2 MiB");
  }
  const bytes = await readFileBytes(file);
  if (bytes.length === 0 || bytes.length > AVATAR_MAX_BYTES || !hasImageSignature(file.type, bytes)) {
    throw new Error("头像文件内容与图片类型不匹配");
  }
  return `data:${file.type};base64,${bytesToBase64(bytes)}`;
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  const readable = file as File & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof readable.arrayBuffer === "function") return new Uint8Array(await readable.arrayBuffer());
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("无法读取头像文件"));
    };
    reader.onerror = () => reject(new Error("无法读取头像文件"));
    reader.readAsArrayBuffer(file);
  });
}
