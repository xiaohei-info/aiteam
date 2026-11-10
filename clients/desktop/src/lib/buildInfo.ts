import { describeBuildInfo, type BuildInfo } from './buildInfoFormat'

// 由 vite.config.ts 的 define 在构建 / 启动时注入
export const BUILD_INFO: BuildInfo = {
  version: __APP_VERSION__,
  commit: __APP_COMMIT__,
  builtAt: __APP_BUILT_AT__,
  dev: import.meta.env.DEV,
}

export const BUILD_INFO_ROWS = describeBuildInfo(BUILD_INFO)
