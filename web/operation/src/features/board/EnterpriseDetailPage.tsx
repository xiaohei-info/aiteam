/**
 * 单企业下钻详情页（W-O.4）。
 *
 * GET /api/operation/rollup/enterprises/{enterprise_id} → 单企业 rollup 详情。
 * D13：只展示脱敏聚合摘要，绝不渲染会话内容/执行明细/raw event。
 * 黑金玻璃质感，复用 shared 组件（Button/GlassPanel/Table）。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button, GlassPanel, Table } from "@aiteam/shared/ui";
import { type EnterpriseRollup, useBoardApi } from "./useBoardApi.js";

function fmt(val: number): string {
  return val.toLocaleString("zh-CN");
}

function fmtCost(cents: number): string {
  const yuan = cents / 100;
  if (yuan >= 10000) {
    return `${(yuan / 10000).toFixed(2)} 万元`;
  }
  return `¥${yuan.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)} 秒`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
}

interface MetricProps {
  label: string;
  value: string;
}

function Metric({ label, value }: MetricProps): ReactNode {
  return (
    <GlassPanel className="flex flex-col gap-xs rounded-window p-md">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-xl font-bold text-text-primary">{value}</span>
    </GlassPanel>
  );
}

export function EnterpriseDetailPage(): ReactNode {
  const { enterprise_id } = useParams<{ enterprise_id: string }>();
  const api = useBoardApi();
  const navigate = useNavigate();
  const [data, setData] = useState<EnterpriseRollup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!enterprise_id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.getEnterpriseRollup(enterprise_id);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api, enterprise_id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (loading) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-secondary">加载中…</GlassPanel>
      </section>
    );
  }

  if (error) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="flex flex-col gap-md rounded-window border border-danger/30 p-lg">
          <p className="m-0 text-sm text-danger">{error}</p>
          <Button type="button" variant="ghost" size="sm" className="self-start" onClick={fetchDetail}>
            重试
          </Button>
        </GlassPanel>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="flex flex-col gap-md">
        <GlassPanel className="rounded-window p-lg text-sm text-text-muted">暂无数据</GlassPanel>
      </section>
    );
  }

  const summary = data.audit_summary;

  return (
    <section className="flex flex-col gap-lg">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => navigate("/board")}
      >
        &larr; 返回总览
      </Button>

      <div className="flex flex-col gap-xs">
        <h1 className="m-0 text-xl font-bold text-text-primary">{data.enterprise_name}</h1>
        <p className="m-0 text-sm text-text-muted">
          统计周期：{data.window_start} ~ {data.window_end}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-md sm:grid-cols-3">
        <Metric label="执行次数" value={fmt(data.run_count)} />
        <Metric label="消耗" value={fmtCost(data.cost_cents)} />
        <Metric label="总 Token" value={fmt(data.total_tokens)} />
      </div>

      {summary && (
        <div className="flex flex-col gap-md">
          <h2 className="m-0 text-base font-semibold text-text-primary">审计摘要</h2>
          <GlassPanel className="overflow-hidden rounded-window">
            <Table>
              <tbody>
                <tr>
                  <td>总执行</td>
                  <td>{fmt(summary.total_runs)}</td>
                </tr>
                <tr>
                  <td>成功</td>
                  <td>{fmt(summary.success_runs)}</td>
                </tr>
                <tr>
                  <td>失败</td>
                  <td>{fmt(summary.failed_runs)}</td>
                </tr>
                <tr>
                  <td>平均耗时</td>
                  <td>{fmtDuration(summary.avg_duration_seconds)}</td>
                </tr>
              </tbody>
            </Table>
          </GlassPanel>
          {summary.top_error_codes.length > 0 && (
            <GlassPanel className="rounded-window p-lg">
              <h3 className="m-0 mb-md text-sm font-semibold text-text-primary">高频错误码</h3>
              <ul className="m-0 flex flex-col gap-xs">
                {summary.top_error_codes.map((code) => (
                  <li key={code} className="text-sm text-text-secondary">
                    <code className="text-gold-bright">{code}</code>
                  </li>
                ))}
              </ul>
            </GlassPanel>
          )}
        </div>
      )}
    </section>
  );
}
