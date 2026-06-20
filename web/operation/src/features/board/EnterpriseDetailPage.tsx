/**
 * 单企业下钻详情页（W-O.4）。
 *
 * GET /api/operation/rollup/enterprises/{enterprise_id} → 单企业 rollup 详情。
 * D13：只展示脱敏聚合摘要，绝不渲染会话内容/执行明细/raw event。
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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

export function EnterpriseDetailPage(): React.ReactNode {
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
      <section className="board-detail board-detail--loading">
        <p className="board-detail__status">加载中…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="board-detail board-detail--error">
        <p className="board-detail__status board-detail__status--error">{error}</p>
        <button
          className="board-detail__retry"
          onClick={fetchDetail}
          type="button"
        >
          重试
        </button>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="board-detail board-detail--empty">
        <p className="board-detail__status">暂无数据</p>
      </section>
    );
  }

  const summary = data.audit_summary;

  return (
    <section className="board-detail">
      <button
        className="board-detail__back"
        onClick={() => navigate("/board")}
        type="button"
      >
        &larr; 返回总览
      </button>

      <h1 className="board-detail__title">{data.enterprise_name}</h1>
      <p className="board-detail__window">
        统计周期：{data.window_start} ~ {data.window_end}
      </p>

      <div className="board-detail__cards">
        <div className="board-detail-card">
          <span className="board-detail-card__label">执行次数</span>
          <span className="board-detail-card__value">{fmt(data.run_count)}</span>
        </div>
        <div className="board-detail-card">
          <span className="board-detail-card__label">消耗</span>
          <span className="board-detail-card__value">{fmtCost(data.cost_cents)}</span>
        </div>
        <div className="board-detail-card">
          <span className="board-detail-card__label">总 Token</span>
          <span className="board-detail-card__value">{fmt(data.total_tokens)}</span>
        </div>
      </div>

      {summary && (
        <div className="board-detail__audit">
          <h2 className="board-detail__audit-title">审计摘要</h2>
          <div className="board-detail__audit-grid">
            <div className="board-detail-audit-item">
              <span className="board-detail-audit-item__label">总执行</span>
              <span className="board-detail-audit-item__value">{fmt(summary.total_runs)}</span>
            </div>
            <div className="board-detail-audit-item">
              <span className="board-detail-audit-item__label">成功</span>
              <span className="board-detail-audit-item__value">{fmt(summary.success_runs)}</span>
            </div>
            <div className="board-detail-audit-item">
              <span className="board-detail-audit-item__label">失败</span>
              <span className="board-detail-audit-item__value">{fmt(summary.failed_runs)}</span>
            </div>
            <div className="board-detail-audit-item">
              <span className="board-detail-audit-item__label">平均耗时</span>
              <span className="board-detail-audit-item__value">{fmtDuration(summary.avg_duration_seconds)}</span>
            </div>
          </div>
          {summary.top_error_codes.length > 0 && (
            <div className="board-detail__audit-errors">
              <h3>高频错误码</h3>
              <ul>
                {summary.top_error_codes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
