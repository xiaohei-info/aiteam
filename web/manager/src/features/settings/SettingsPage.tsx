/** B08 设置页 — 企业设置 + 子管理员邀请。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { VStack } from "@astryxdesign/core/VStack";
import { AccountSecurityPanel } from "./AccountSecurityPanel";
import { useSession } from "../../auth/session";
import { useSettingsApi } from "./useSettingsApi";
import type { EnterpriseSettings, AdminInvite } from "./types";

export function SettingsPage(): ReactNode {
  const { session } = useSession();
  const canAdmin = session?.claims.roles.some((role) => ["owner", "enterprise_admin"].includes(role));
  return <VStack gap={4}><AccountSecurityPanel />{canAdmin && <EnterpriseSettingsPanel />}</VStack>;
}

function EnterpriseSettingsPanel(): ReactNode {
  const api = useSettingsApi();
  const [settings, setSettings] = useState<EnterpriseSettings | null>(null);
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newPhone, setNewPhone] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, ivs] = await Promise.all([api.get(), api.listInvites()]);
      setSettings(s); setInvites(ivs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "设置加载失败");
    } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = useCallback(async () => {
    if (!settings) return;
    setActionError(null);
    try { await api.update({ enterprise_name: settings.enterprise_name }); await load(); } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "保存失败，请重试");
    }
  }, [api, settings, load]);

  const handleInvite = useCallback(async () => {
    if (!newPhone) return;
    setActionError(null);
    try { await api.createInvite(newPhone); setNewPhone(""); await load(); } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "邀请发送失败，请重试");
    }
  }, [api, newPhone, load]);

  const handleRevoke = useCallback(async (inviteId: string) => {
    setActionError(null);
    try { await api.deleteInvite(inviteId); await load(); } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "撤销失败，请重试");
    }
  }, [api, load]);

  if (loading) return <Card padding={4} role="status" aria-label="企业设置加载中"><Skeleton height={120} /></Card>;

  return (
    <VStack gap={4}>
      <Heading level={1}>企业设置</Heading>
      {error && <Banner status="error" title={error} />}
      {actionError && <Banner status="error" title={actionError} />}

      {settings && (
        <Card padding={4}><VStack gap={3}><FormLayout><TextInput label="企业名称" value={settings.enterprise_name} onChange={(value) => setSettings({ ...settings, enterprise_name: value })} /></FormLayout><Button label="保存" variant="primary" size="sm" onClick={() => void handleSave()} /></VStack></Card>
      )}

      <Heading level={2}>子管理员邀请</Heading>
      <Card padding={4}><VStack gap={3}>
        <HStack gap={2} align="end"><TextInput label="手机号" isLabelHidden placeholder="手机号" value={newPhone} onChange={setNewPhone} width="100%" /><Button label="发送邀请" variant="primary" size="sm" onClick={() => void handleInvite()} /></HStack>
        {invites.length === 0 ? <EmptyState title="暂无待处理邀请" isCompact /> : <VStack gap={2}>
            {invites.map((iv) => (
              <Card key={iv.invite_id} variant="muted" padding={3} data-testid="invite-row"><HStack justify="between" align="center"><Text>{iv.phone} — {iv.display_name}</Text><Text type="supporting">{iv.status}</Text><Button label="撤销" variant="destructive" size="sm" onClick={() => void handleRevoke(iv.invite_id)} /></HStack></Card>
            ))}
          </VStack>}
      </VStack></Card>
    </VStack>
  );
}
