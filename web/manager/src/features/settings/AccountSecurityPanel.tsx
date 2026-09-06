import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { VStack } from "@astryxdesign/core/VStack";
import { useSession } from "../../auth/session";
import { createManagerApiClient } from "../../api/client";
import { registerPasskey, type PasskeyOptions } from "../../auth/passkey";
import { startOAuth } from "../../auth/factors";

interface Passkey { credential_id: string; label: string }
interface Connection { provider: string; profile_email: string | null }

export function AccountSecurityPanel(): React.ReactNode {
  const { token, session, onUnauthorized } = useSession();
  const client = useMemo(() => createManagerApiClient({ getToken: () => token, onUnauthorized }), [token, onUnauthorized]);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const [keys, links, configured] = await Promise.all([
      client.get<Passkey[]>("/api/manager/passkeys"), client.get<Connection[]>("/api/manager/oauth/connections"),
      client.get<string[]>("/api/auth/oauth/providers"),
    ]);
    setPasskeys(keys ?? []); setConnections(links ?? []); setProviders(configured ?? []);
  }, [client]);
  useEffect(() => { void load().catch((err: Error) => setError(err.message)); }, [load]);
  async function perform(action: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(null);
    try { await action(); await load(); } catch (err) { setError(err instanceof Error ? err.message : "账号操作失败"); }
    finally { setBusy(false); }
  }
  async function enroll(): Promise<void> {
    const options = await client.post<PasskeyOptions>("/api/manager/passkeys/registration-options");
    if (!options) throw new Error("Passkey 未配置");
    const response = await registerPasskey(options);
    await client.post("/api/manager/passkeys", { body: { label: "浏览器 Passkey", response } });
  }
  return <Card padding={4}><VStack gap={3}>
    <Heading level={2}>账号安全</Heading>
    {error && <Banner status="error" title={error} />}
    <Button label="添加 Passkey" isDisabled={busy} onClick={() => void perform(enroll)} />
    {passkeys.map((key) => <div key={key.credential_id}>{key.label}<Button label={`删除 ${key.label}`} isDisabled={busy} onClick={() => void perform(() => client.del(`/api/manager/passkeys/${encodeURIComponent(key.credential_id)}`))} /></div>)}
    {connections.map((connection) => <div key={connection.provider}>{connection.provider} {connection.profile_email}<Button label={`解绑 ${connection.provider}`} isDisabled={busy} onClick={() => void perform(() => client.del(`/api/manager/oauth/${encodeURIComponent(connection.provider)}`))} /></div>)}
    {providers.filter((provider) => !connections.some((c) => c.provider === provider)).map((provider) => <Button key={provider} label={`绑定 ${provider}`} isDisabled={busy} onClick={() => void perform(() => startOAuth(client, session!.claims.tenant_id!, provider, "link", session!.claims.user_id))} />)}
  </VStack></Card>;
}
