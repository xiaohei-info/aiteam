/**
 * 锚定浮层（下拉、气泡、弹出面板）的统一定位：渲染到 body（见 PopoverPortal），按锚点用 fixed 定位，
 * 放不下时换方向、贴边收进视口；锚点移动（侧栏开合、输入框变高、滚动）时自动跟随。
 *
 * 为什么要渲染到 body：输入栏和输入框自身带 backdrop-filter，会形成独立的层叠上下文和背景采样根，
 * 浮层留在里面既会被消息列表（z-index 更高）盖住、点不到，毛玻璃也只能模糊输入栏内部。
 * 定位与跟随交给 Floating UI，不再在各组件里手写 getBoundingClientRect。
 */
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
  type OffsetOptions,
  type Placement,
  type ReferenceType,
} from '@floating-ui/react'

/** 浮层与视口边缘至少留出的距离 */
export const POPOVER_VIEWPORT_MARGIN = 12

export interface AnchoredPopoverOptions {
  open: boolean
  /** 首选方向，默认在锚点上方左对齐 */
  placement?: Placement
  /** 首选方向放不下时依次尝试的方向；缺省取反方向 */
  fallbackPlacements?: Placement[]
  /** 与锚点的间距，或 Floating UI 的 offset 配置（需要横向微调时用） */
  offset?: OffsetOptions
  /** 按可用空间限制宽高（可滚动的面板用）；同时给出上限 */
  fit?: { maxWidth?: number; maxHeight?: number }
}

export function useAnchoredPopover<R extends ReferenceType = Element>({
  open,
  placement = 'top-start',
  fallbackPlacements,
  offset: offsetOptions = 8,
  fit,
}: AnchoredPopoverOptions) {
  const maxWidth = fit?.maxWidth
  const maxHeight = fit?.maxHeight
  return useFloating<R>({
    open,
    placement,
    strategy: 'fixed',
    // 用 top/left 定位而不是 transform：各浮层的入场动画会改 transform，两者叠加会让浮层先闪到左上角
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(offsetOptions),
      flip({ fallbackPlacements, padding: POPOVER_VIEWPORT_MARGIN }),
      shift({ padding: POPOVER_VIEWPORT_MARGIN }),
      fit && size({
        padding: POPOVER_VIEWPORT_MARGIN,
        apply({ availableWidth, availableHeight, elements }) {
          const width = maxWidth === undefined ? availableWidth : Math.min(maxWidth, availableWidth)
          const height = maxHeight === undefined ? availableHeight : Math.min(maxHeight, availableHeight)
          Object.assign(elements.floating.style, {
            maxWidth: `${Math.max(0, width)}px`,
            maxHeight: `${Math.max(0, height)}px`,
          })
        },
      }),
    ],
  })
}

/** 浮层当前所在的一侧（top / right / bottom / left），用于小三角等随方向变化的样式 */
export function placementSide(placement: Placement): string {
  return placement.split('-')[0]
}
