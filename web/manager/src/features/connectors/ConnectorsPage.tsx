/** B05 连接器页 — 预设列表 + 状态/测试。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel } from "@aiteam/shared/ui";
import { useConnectorsApi } from "./useConnectorsApi";
import type { ConnectorPreset } from "./types";

export function ConnectorsPage(): ReactNode {
  const api = useConnectorsApi();
  const [presets, setPresets] = useState<ConnectorPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { setPresets(await api.getPresets()); } catch { /* ignore */ } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const handleTest = useCallback(async (presetId: string) => {
    setTestResult(null);
    try { const r = await api.test(presetId); setTestResult(r ? `${r.success ? "✅" : "❌"} ${r.message} (${r.latency_ms}ms)` : "测试完成"); }
    catch (e) { setTestResult(e instanceof Error ? e.message : "测试失败"); }
  }, [api]);

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">连接器</h1>
      {testResult && <GlassPanel className="rounded-window p-md text-sm text-text-secondary">{testResult}</GlassPanel>}
      <div className="grid grid-cols-4 gap-md">
        {presets.map((p) => (
          <GlassPanel key={p.preset_id} className="rounded-window p-md">
            <div className="flex items-center gap-sm"><span className="text-lg">{p.icon ? "🔌" : "⚙"}</span><span className="text-sm font-bold text-text-primary">{p.name}</span></div>
            <p className="m-0 mt-xs text-xs text-text-muted">{p.description}</p>
            <p className="m-0 mt-xs text-xs text-text-muted">类型: {p.type}</p>
            <div className="mt-sm"><Button variant="ghost" size="sm" onClick={() => void handleTest(p.preset_id)}>测试连接</Button></div>
          </GlassPanel>
        ))}
      </div>
    </section>
  );
}
