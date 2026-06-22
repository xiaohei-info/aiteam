import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "@aiteam/shared";
import { GlassPanel, Table } from "@aiteam/shared/ui";
import { useCapabilityApi } from "./useCapabilityApi";
import type { SkillCatalog, ConnectorCatalog, MemoryPolicyCatalog } from "./types";

export function CapabilityPage(): ReactNode {
  const api = useCapabilityApi();
  const [skills, setSkills] = useState<SkillCatalog[]>([]);
  const [connectors, setConnectors] = useState<ConnectorCatalog[]>([]);
  const [memories, setMemories] = useState<MemoryPolicyCatalog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [s, c, m] = await Promise.all([api.listSkills(), api.listConnectors(), api.listMemoryPolicies()]);
      setSkills(s); setConnectors(c); setMemories(m);
    } catch (err) { setError(err instanceof ApiError ? err.message : "加载失败"); }
    finally { setLoading(false); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
      <GlassPanel className="flex flex-col gap-md rounded-window p-lg">
        <h2 className="m-0 text-base font-semibold text-text-primary">{title}</h2>
        {children}
      </GlassPanel>
    );
  }

  if (loading) return <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>;
  if (error) return <GlassPanel className="rounded-window border border-danger/30 p-md text-sm text-danger">{error}</GlassPanel>;

  return (
    <section className="flex flex-col gap-lg">
      <h1 className="m-0 text-xl font-bold text-text-primary">能力目录</h1>
      <Section title={`技能（${skills.length}）`}>
        {skills.length === 0 ? <p className="m-0 text-sm text-text-muted">暂无技能</p> : (
          <GlassPanel className="overflow-hidden rounded-window">
            <Table><thead><tr><th>ID</th><th>名称</th><th>版本</th><th>可见性</th></tr></thead>
              <tbody>{skills.map((s) => <tr key={s.catalog_id}><td>{s.skill_id}</td><td>{s.display_name||"—"}</td><td>{s.version}</td><td>{s.visibility}</td></tr>)}</tbody>
            </Table>
          </GlassPanel>
        )}
      </Section>
      <Section title={`连接器（${connectors.length}）`}>
        {connectors.length === 0 ? <p className="m-0 text-sm text-text-muted">暂无连接器</p> : (
          <GlassPanel className="overflow-hidden rounded-window">
            <Table><thead><tr><th>ID</th><th>名称</th><th>授权范围</th><th>可见性</th></tr></thead>
              <tbody>{connectors.map((c) => <tr key={c.catalog_id}><td>{c.connector_id}</td><td>{c.display_name||"—"}</td><td>{c.grant_scope}</td><td>{c.visibility}</td></tr>)}</tbody>
            </Table>
          </GlassPanel>
        )}
      </Section>
      <Section title={`记忆策略（${memories.length}）`}>
        {memories.length === 0 ? <p className="m-0 text-sm text-text-muted">暂无记忆策略</p> : (
          <GlassPanel className="overflow-hidden rounded-window">
            <Table><thead><tr><th>ID</th><th>名称</th><th>保留期（天）</th><th>可见性</th></tr></thead>
              <tbody>{memories.map((m) => <tr key={m.catalog_id}><td>{m.policy_id}</td><td>{m.display_name||"—"}</td><td>{m.retention_days ?? "不限"}</td><td>{m.visibility}</td></tr>)}</tbody>
            </Table>
          </GlassPanel>
        )}
      </Section>
    </section>
  );
}
