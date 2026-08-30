import { describe, expect, it } from "vitest";
import { AVATAR_MAX_BYTES, isSafeAvatarDataUrl, readAvatarFile } from "./avatar";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function file(bytes: Uint8Array, type = "image/png"): File {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new File([copy], "avatar.png", { type });
}

describe("catalog avatar data", () => {
  it("encodes a local image as a canonical data URL", async () => {
    const value = await readAvatarFile(file(PNG_SIGNATURE));
    expect(value).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(isSafeAvatarDataUrl(value)).toBe(true);
  });

  it("accepts the supported raster signatures", async () => {
    const variants: Array<[string, Uint8Array]> = [
      ["image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0x00])],
      ["image/gif", new TextEncoder().encode("GIF89a\0")],
      ["image/webp", new TextEncoder().encode("RIFF\0\0\0\0WEBP")],
    ];
    for (const [type, bytes] of variants) {
      expect(await readAvatarFile(file(bytes, type))).toMatch(new RegExp(`^data:${type};base64,`));
    }
  });

  it("rejects an unsupported MIME type and a mismatched signature", async () => {
    await expect(readAvatarFile(file(PNG_SIGNATURE, "image/svg+xml"))).rejects.toThrow("仅支持");
    await expect(readAvatarFile(file(new Uint8Array([0xff, 0xd8, 0xff]), "image/png"))).rejects.toThrow("不匹配");
    await expect(readAvatarFile(file(new Uint8Array([0x89]), "image/png"))).rejects.toThrow("不匹配");
    expect(isSafeAvatarDataUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
  });

  it("rejects files over the decoded size limit", async () => {
    const bytes = new Uint8Array(AVATAR_MAX_BYTES + 1);
    bytes.set(PNG_SIGNATURE);
    await expect(readAvatarFile(file(bytes))).rejects.toThrow("2 MiB");
  });
});
