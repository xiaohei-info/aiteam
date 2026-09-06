/** Standard WebAuthn JSON/base64url boundary; credentials never leave this Manager origin. */
function decode(value: string): ArrayBuffer {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
}
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
interface Descriptor { type: "public-key"; id: string }
export interface PasskeyOptions {
  challenge: string;
  rp?: PublicKeyCredentialRpEntity;
  rpId?: string;
  user?: { id: string; name: string; displayName: string };
  pubKeyCredParams?: PublicKeyCredentialParameters[];
  excludeCredentials?: Descriptor[];
  allowCredentials?: Descriptor[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  userVerification?: UserVerificationRequirement;
  timeout?: number;
  attestation?: AttestationConveyancePreference;
}
export async function registerPasskey(options: PasskeyOptions): Promise<Record<string, string>> {
  if (!options.rp || !options.user || !options.pubKeyCredParams) throw new Error("Passkey 注册配置不完整");
  const credential = await navigator.credentials.create({ publicKey: {
    ...options, rp: options.rp, user: { ...options.user, id: decode(options.user.id) },
    pubKeyCredParams: options.pubKeyCredParams, challenge: decode(options.challenge),
    excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey 注册已取消");
  const response = credential.response as AuthenticatorAttestationResponse;
  return { clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject) };
}
export async function authenticatePasskey(options: PasskeyOptions): Promise<Record<string, unknown>> {
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: decode(options.challenge), rpId: options.rpId, timeout: options.timeout,
    userVerification: options.userVerification,
    allowCredentials: options.allowCredentials?.map((item) => ({ ...item, id: decode(item.id) })),
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey 登录已取消");
  const response = credential.response as AuthenticatorAssertionResponse;
  return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: {
    clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData),
    signature: encode(response.signature), userHandle: response.userHandle ? encode(response.userHandle) : null,
  } };
}
