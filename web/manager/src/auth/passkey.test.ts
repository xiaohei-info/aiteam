import { afterEach, expect, it, vi } from "vitest";
import { authenticatePasskey, registerPasskey, type PasskeyOptions } from "./passkey";
const bytes = () => new Uint8Array([1, 2, 3]).buffer;
const options: PasskeyOptions = { challenge: "AQID", rp: { id: "manager.example", name: "Manager" }, user: { id: "AQID", name: "a", displayName: "A" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], excludeCredentials: [{ type: "public-key", id: "AQID" }], allowCredentials: [{ type: "public-key", id: "AQID" }] };
afterEach(() => vi.unstubAllGlobals());
it("converts browser registration and assertion binary fields to wire base64url", async () => {
  const create = vi.fn(async () => ({ response: { clientDataJSON: bytes(), attestationObject: bytes() } }));
  const get = vi.fn(async () => ({ id: "AQID", rawId: bytes(), type: "public-key", response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes(), userHandle: bytes() } }));
  vi.stubGlobal("navigator", { credentials: { create, get } });
  expect(await registerPasskey(options)).toEqual({ clientDataJSON: "AQID", attestationObject: "AQID" });
  const input = create.mock.calls[0] as unknown as [{ publicKey: { user: { id: ArrayBuffer }; challenge: ArrayBuffer } }];
  expect(new Uint8Array(input[0].publicKey.challenge)).toEqual(new Uint8Array([1, 2, 3]));
  const result = await authenticatePasskey(options);
  expect(result).toMatchObject({ id: "AQID", rawId: "AQID", response: { signature: "AQID", userHandle: "AQID" } });
  get.mockImplementationOnce(async () => ({ id: "AQID", rawId: bytes(), type: "public-key", response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes(), userHandle: null as unknown as ArrayBuffer } }));
  expect(await authenticatePasskey({ challenge: "AQID" })).toMatchObject({ response: { userHandle: null } });
});
it("surfaces cancellation and invalid options instead of claiming success", async () => {
  vi.stubGlobal("navigator", { credentials: { create: vi.fn(async () => null), get: vi.fn(async () => null) } });
  await expect(registerPasskey(options)).rejects.toThrow("取消");
  await expect(authenticatePasskey(options)).rejects.toThrow("取消");
  await expect(registerPasskey({ challenge: "AQID" })).rejects.toThrow("不完整");
});
