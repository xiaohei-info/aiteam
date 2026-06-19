/**
 * 业务时间线事件镜像（07 §8，D6）。来源 `server/shared/contracts/events.py`。
 *
 * 铁律：前端**只**消费 BusinessTimelineEvent（归一后的产品时间线），
 * 绝不绑定 runtime-native event，也不镜像 Gateway 内部 AgentRuntimeEvent（D6）。
 * 因此本文件不导出 AgentRuntimeEvent / RuntimeEventType——它们不暴露前端。
 */

/** 对外 numeric cursor（07 §8 / 02 §10.3.7）。禁对外暴露内部 {timestamp}-{sequence}。 */
export interface TimelineCursor {
  value: number;
}

/**
 * 业务时间线事件（RunTimelineEvent，07 §8）。
 *
 * 面向对话页/任务树/工具调用/审计回放；payload 为**已脱敏**的产品展示载荷。
 * 具体 payload 形状由各端 OpenAPI 定稿，本类型为最小稳定骨架。
 */
export interface BusinessTimelineEvent {
  cursor: number;
  run_id: string;
  conversation_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}
