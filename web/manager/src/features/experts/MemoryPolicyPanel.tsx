import { useEffect, useMemo, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { createManagerApiClient } from "../../api/client";
import { useSession } from "../../auth/session";

interface MemorySetting {
  policy: { enabled: boolean; allowed_operations: string[]; explicit_auto_retain: boolean };
  retention_days: number | null;
  retention_status: "unlimited" | "fact_only";
  retention_guarded: boolean;
  revision: number;
  source: string;
}

/** The independent setting is effective immediately; the main drawer must not echo stale policy. */
export function MemoryPolicyPanel({ employeeId }: { employeeId: string }) {
  const { token, onUnauthorized } = useSession();
  const api = useMemo(() => createManagerApiClient({ getToken: () => token, onUnauthorized }), [token, onUnauthorized]);
  const path = `/api/manager/employees/${encodeURIComponent(employeeId)}/memory-setting`;
  const [setting, setSetting] = useState<MemorySetting>();
  const [enabled, setEnabled] = useState(false);
  const [recall, setRecall] = useState(false);
  const [retain, setRetain] = useState(false);
  const [auto, setAuto] = useState(false);
  const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  function apply(value: MemorySetting | null) {
    if (value === null) throw new Error("Memory policy unavailable");
    setSetting(value); setEnabled(value.policy.enabled);
    setRecall(value.policy.allowed_operations.includes("recall"));
    setRetain(value.policy.allowed_operations.includes("retain"));
    setAuto(value.policy.explicit_auto_retain); setDays(value.retention_days === null ? "" : String(value.retention_days));
  }
  useEffect(() => {
    let alive = true;
    setSetting(undefined); setError(undefined);
    api.get<MemorySetting>(path).then((value) => { if (alive) apply(value); })
      .catch(() => { if (alive) setError("记忆策略加载失败，未修改权限"); });
    return () => { alive = false; };
  }, [api, path]);
  async function save(remove = false) {
    if (!remove && days !== "" && (!Number.isInteger(Number(days)) || Number(days) < 1 || Number(days) > 36500)) {
      setError("保留天数须为1至36500的整数，留空表示无期限"); return;
    }
    setBusy(true); setError(undefined);
    try {
      if (remove) await api.del(path);
      else await api.patch(path, { body: {
        policy: { enabled, allowed_operations: enabled ? [recall ? "recall" : null, retain ? "retain" : null].filter(Boolean) : [],
          explicit_auto_retain: enabled && retain && auto },
        retention_days: days === "" ? null : Number(days),
      } });
      apply(await api.get<MemorySetting>(path));
    } catch { setSetting(undefined); setError("记忆策略更新或重新读取失败，请重新打开确认；不视为已成功"); }
    finally { setBusy(false); }
  }
  return <VStack gap={3}>
    <Heading level={3}>员工记忆策略</Heading>
    <Text type="supporting">独立立即保存。记忆内容只存于员工专属Hindsight bank；撤销保留拒绝记录，不物理擦除历史数据。</Text>
    {error && <Banner status="error" title={error} />}
    {!setting ? <Text>记忆策略尚未载入</Text> : <>
      <Text>有效来源：{setting.source} · 修订 {setting.revision}</Text>
      <label><input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setEnabled(e.target.checked)} />启用员工记忆</label>
      <label><input type="checkbox" checked={recall} disabled={busy || !enabled} onChange={(e) => setRecall(e.target.checked)} />允许召回</label>
      <label><input type="checkbox" checked={retain} disabled={busy || !enabled} onChange={(e) => setRetain(e.target.checked)} />允许手工写入</label>
      <label><input type="checkbox" checked={auto} disabled={busy || !enabled || !retain} onChange={(e) => setAuto(e.target.checked)} />明确授权自动提炼并写入会话记忆</label>
      <label>保留天数（空为无期限）<input type="number" min={1} max={36500} value={days} disabled={busy} onChange={(e) => setDays(e.target.value)} /></label>
      <Text type="supporting">有限期限到期后排除召回并原生失效，不等于物理擦除。受保留治理的bank只召回可信原始事实，不返回派生观察或原始片段；延长或取消未来期限不会恢复已过期信息或派生输出。上游不符合已验证协议时能力503；历史首次清理须另行预检批准。</Text>
      <Text>召回输出模式：{setting.retention_status === "fact_only" ? "可信原始事实（持久保留治理）" : "未施加有限保留治理"}</Text>
      <HStack gap={2}>
        <Button type="button" label="保存记忆策略" isDisabled={busy} onClick={() => void save()} />
        <Button type="button" label="撤销记忆能力" isDisabled={busy} onClick={() => void save(true)} />
      </HStack>
    </>}
  </VStack>;
}
