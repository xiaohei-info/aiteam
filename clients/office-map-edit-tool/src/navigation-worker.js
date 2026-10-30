import { findPath } from './model.js'

self.onmessage = event => {
  const { requestId, map, start, end, radius, mode } = event.data
  try { self.postMessage({ requestId, path: findPath(map, start, end, radius, mode) }) }
  catch { self.postMessage({ requestId, path: null, error: '路径验证失败，请检查地图配置' }) }
}
