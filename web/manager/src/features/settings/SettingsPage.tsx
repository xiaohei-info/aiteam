/** B08 设置页 — 企业设置 + 子管理员邀请。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Field, GlassPanel, Input } from "@aiteam/shared/ui";
import { useSettingsApi } from "./useSettingsApi";
import type { EnterpriseSettings, AdminInvite } from "./types";

export function SettingsPage(): ReactNode {
  const api = useSettingsApi();
  const [settings, setSettings] = useState<EnterpriseSettings | null>(null);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [newPhone, setNewPhone] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, ivs] = await Promise.all([api.get(), api.listInvites()]);
      setSettings(s); setInvites(ivs);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    try { await api.update({ enterprise_name: settings.enterprise_name }); await load(); } catch { /* ignore */ }
  }, [api, settings, load]);

  const handleInvite = useCallback(async () => {
    if (!newPhone) return;
    try { await api.createInvite(newPhone); setNewPhone(""); await load(); } catch { /* ignore */ }
  }, [api, newPhone, load]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">企业设置</h1>

      {settings && (
        <GlassPanel className="rounded-window p-md">
          <Field label="企业名称"><Input value={settings.enterprise_name} onChange={(e) => setSettings({ ...settings, enterprise_name: (e.target as HTMLInputElement).value })} /></Field>
          <div className="mt-sm"><Button variant="metal" size="sm" onClick={handleSave}>保存</Button></div>
        </GlassPanel>
      )}

      <h2 className="m-0 text-sm font-bold text-text-primary">子管理员邀请</h2>
      <GlassPanel className="rounded-window p-md">
        <div className="flex gap-sm">
          <Input placeholder="手机号" value={newPhone} onChange={(e) => setNewPhone((e.target as HTMLInputElement).value)} className="flex-1" />
          <Button variant="metal" size="sm" onClick={handleInvite}>发送邀请</Button>
        </div>
        {invites.length > 0 && (
          <div className="mt-md space-y-xs">
            {invites.map((iv) => (
              <div key={iv.invite_id} className="flex items-center justify-between border-b border-gold/5 py-xs text-sm">
                <span className="text-text-secondary">{iv.phone} — {iv.display_name}</span>
                <span className="text-text-muted">{iv.status}</span>
                <Button variant="ghost" size="sm" onClick={() => { void api.deleteInvite(iv.invite_id).then(load); }}>撤销</Button>
              </div>
            ))}
          </div>
        )}
      </GlassPanel>
    </section>
  );
}
