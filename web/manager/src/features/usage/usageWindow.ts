import type { UsageWindow } from "./types";

const HOUR_MS = 3_600_000;

function floorUtcHour(time: number): number {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

function iso(time: number): string {
  return new Date(time).toISOString().replace(".000Z", "Z");
}

/**
 * 统计接口只接受 UTC 整点窗口：起点为 days-1 天前本地午夜向下取整到 UTC 整点，
 * 终点为当前小时之后的下一个 UTC 整点。非整点时区（如 UTC+5:30）会多算半小时，属已知局限。
 */
export function lastLocalDaysWindow(days: number, now: Date = new Date()): UsageWindow {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() - (days - 1));
  return {
    window_start: iso(floorUtcHour(midnight.getTime())),
    window_end: iso(floorUtcHour(now.getTime()) + HOUR_MS),
  };
}
