// 多选 / 框选 / 批量移动的纯逻辑：不依赖 DOM，可直接被 node:test 覆盖。
// 画布交互只负责把画布坐标换算成这里的矩形与包围范围。
import { rectIntersectsPolygon } from './model.js'

/** 画布上可被点选或框选命中的对象：隐藏图层与锁定对象都排除在外 */
export const canSelect = item => !!item && item.visible !== false && item.locked !== true

/**
 * 矩形是否命中一个对象。
 * 有 polygon（元素/区域）时按矩形与多边形重叠判定，包含“只框住一部分”“只压住一条边”；
 * 只有锚点（活动点）时按点是否落在矩形内判定。
 */
export function rectHitsItem(rect, { polygon = null, x, y } = {}) {
  if (polygon && polygon.length >= 3) return rectIntersectsPolygon(rect, polygon)
  return Number.isFinite(x) && Number.isFinite(y) && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/** 一组对象各自的包围范围：多边形用顶点包围盒，其余用中心点 */
export function groupRanges(items) {
  return items.map(item => {
    const points = Array.isArray(item?.points) && item.points.length ? item.points : null
    if (!points) return { loX: item.x, hiX: item.x, loY: item.y, hiY: item.y }
    const xs = points.map(p => p.x), ys = points.map(p => p.y)
    return { loX: Math.min(...xs), hiX: Math.max(...xs), loY: Math.min(...ys), hiY: Math.max(...ys) }
  })
}

/** 整体位移的允许区间：让所有选中对象都不越出地图，同时保持相互位置不变 */
export function moveLimits(ranges, width, height) {
  if (!ranges.length) return { dxMin: -Infinity, dxMax: Infinity, dyMin: -Infinity, dyMax: Infinity }
  return {
    dxMin: -Math.min(...ranges.map(r => r.loX)), dxMax: width - Math.max(...ranges.map(r => r.hiX)),
    dyMin: -Math.min(...ranges.map(r => r.loY)), dyMax: height - Math.max(...ranges.map(r => r.hiY)),
  }
}

/** 把位移夹紧到允许区间；对象比地图还大导致区间非法时退回下界，而不是反向弹回 */
export function clampDelta(value, min, max) { return Math.min(Math.max(value, min), Math.max(min, max)) }

/** 归一化框选矩形，保证宽高为正 */
export function normalizeRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}
