/** S01 账号管理页 — 企业列表 + 搜索 + 统计卡片 + 操作。 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, GlassPanel, Input } from "@aiteam/shared/ui";
import { useAccountsApi } from "./useAccountsApi.js";
import type { EnterpriseAccount, EnterpriseStats } from "./types.js";
import { EnterpriseActions } from "./EnterpriseActions.js";

export function AccountsPage(): ReactNode {
  const api = useAccountsApi();
  const [list, setList] = useState<EnterpriseAccount[]>([]);
  const [stats, setStats] = useState<EnterpriseStats | null>(null);
  const [keyword, setKeyword] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [items, s] = await Promise.all([
        api.list({ keyword: keyword || undefined, status: statusFilter || undefined }),
        api.getStats(),
      ]);
      setList(items);
      setStats(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api, keyword, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="flex flex-col gap-md">
      <h1 className="m-0 text-xl font-bold text-text-primary">企业账号管理</h1>

      {/* 统计卡片 */}
      {stats && (
        <div className="grid grid-cols-4 gap-md">
          {[
            { label: "总企业数", value: stats.total_enterprises },
            { label: "本月新增", value: stats.new_this_month },
            { label: "月活企业", value: stats.monthly_active },
            { label: "总充值(万)", value: stats.total_recharged },
          ].map((c) => (
            <GlassPanel key={c.label} className="rounded-window p-md">
              <p className="m-0 text-xs text-text-muted">{c.label}</p>
              <p className="m-0 mt-xs text-lg font-bold text-gold-bright">{c.value}</p>
            </GlassPanel>
          ))}
        </div>
      )}

      {/* 搜索栏 */}
      <div className="flex gap-sm">
        <Input
          placeholder="搜索企业名称/手机号"
          value={keyword}
          onChange={(e) => setKeyword((e.target as HTMLInputElement).value)}
          className="flex-1"
        />
        <Button variant="ghost" onClick={() => void load()}>搜索</Button>
        <Button variant="ghost" onClick={() => void api.exportAll()}>导出</Button>
      </div>

      {/* 列表 */}
      {loading ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      ) : error ? (
        <GlassPanel className="rounded-window border border-danger/30 p-lg text-sm text-danger">{error}</GlassPanel>
      ) : list.length === 0 ? (
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">暂无企业</GlassPanel>
      ) : (
        <GlassPanel className="rounded-window p-md">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gold/15 text-left text-xs text-text-muted">
                <th className="pb-sm">企业名称</th>
                <th className="pb-sm">联系人/手机</th>
                <th className="pb-sm">注册时间</th>
                <th className="pb-sm">累计充值</th>
                <th className="pb-sm">Token消耗</th>
                <th className="pb-sm">状态</th>
                <th className="pb-sm">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e) => (
                <tr key={e.org_id} className="border-b border-gold/5 hover:bg-surface-raised/50">
                  <td className="py-sm text-text-primary">{e.enterprise_name}</td>
                  <td className="py-sm text-text-secondary">{e.contact_name} / {e.contact_phone}</td>
                  <td className="py-sm text-text-secondary">{e.registered_at?.slice(0, 10)}</td>
                  <td className="py-sm text-gold-bright">¥{e.total_recharged}</td>
                  <td className="py-sm text-text-secondary">{(e.token_consumed / 1e6).toFixed(1)}M</td>
                  <td className="py-sm">
                    <span className={e.status === "normal" ? "text-success" : e.status === "banned" ? "text-danger" : "text-warning"}>
                      {e.status === "normal" ? "正常" : e.status === "banned" ? "封禁" : "欠费"}
                    </span>
                  </td>
                  <td className="py-sm">
                    <EnterpriseActions api={api} enterprise={e} onDone={() => void load()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </GlassPanel>
      )}
    </section>
  );
}
