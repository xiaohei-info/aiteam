/** B05 连接器页 — 预设列表 + 状态/测试。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { useConnectorsApi } from "./useConnectorsApi";
import type { ConnectorPreset } from "./types";

export function ConnectorsPage(): ReactNode {
  const api = useConnectorsApi();
  const [presets, setPresets] = useState<ConnectorPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setPresets(await api.getPresets()); } catch (err) {
      setError(err instanceof ApiError ? err.message : "连接器列表加载失败");
    } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const handleTest = useCallback(async (presetId: string) => {
    setTestResult(null);
    try { const r = await api.test(presetId); setTestResult(r ? `${r.success ? "✅" : "❌"} ${r.message} (${r.latency_ms}ms)` : "测试完成"); }
    catch (e) { setTestResult(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "测试失败"); }
  }, [api]);

  if (loading) return <Card padding={4} role="status" aria-label="连接器加载中"><Skeleton height={120} /></Card>;

  return (
    <VStack gap={4}>
      <Heading level={1}>连接器</Heading>
      {error && <Banner status="error" title={error} />}
      {testResult && <Banner status={testResult.startsWith("✅") ? "success" : "error"} title={testResult} />}
      {presets.length === 0 ? <EmptyState title="暂无连接器" /> : <Grid columns={{ minWidth: 220, max: 4 }} gap={4}>
        {presets.map((p) => (
          <Card key={p.preset_id} padding={4}>
            <VStack gap={2}>
              <Heading level={2}>{p.name}</Heading>
              <Text type="supporting">{p.description}</Text>
              <Text type="supporting">类型：{p.type}</Text>
              <Button label="测试连接" variant="secondary" size="sm" onClick={() => void handleTest(p.preset_id)} />
            </VStack>
          </Card>
        ))}
      </Grid>}
    </VStack>
  );
}
