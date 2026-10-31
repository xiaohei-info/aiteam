/**
 * 工位（办公桌）图形注册表
 *
 * - 每张桌子是一个 PNG/JPG 素材，可换色/换风格
 * - 通过 `pickDeskAsset(seatIndex)` 稳定地把座位与素材映射（同一 seatIndex 每次结果一致）
 * - 后续新增素材，只需向 `DESK_ASSETS` 追加一条即可
 */

export interface DeskAsset {
  /** 唯一 id */
  id: string
  /** 中文名（UI 展示） */
  label: string
  /** 图片路径（public/ 起） */
  src: string
  /** 原图像素尺寸，用于计算宽高比 */
  imageSize: { w: number; h: number }
  /**
   * 员工"坐"在桌子上的锚点相对高度（0–1）
   * - 0 表示锚定在图片顶部，1 表示底部
   * - 用于把员工 Sprite 对齐到桌前座位
   */
  seatAnchorY: number
}

export const DESK_ASSETS: DeskAsset[] = [
  {
    id: 'desk-white',
    label: '白色办公桌',
    src: '/assets/office/icon_office_desk_white.jpg',
    imageSize: { w: 222, h: 220 },
    seatAnchorY: 0.62,
  },
  {
    id: 'desk-wooden',
    label: '原木办公桌',
    src: '/assets/office/icon_office_desk_wooden.jpg',
    imageSize: { w: 274, h: 212 },
    seatAnchorY: 0.62,
  },
]

/**
 * 依据座位索引稳定选取一张桌子（伪随机、可复现）
 * - 通过 `seed` 参数可控制批次差异（如按办公室 id 隔离）
 */
export function pickDeskAsset(seatIndex: number, seed = 0): DeskAsset {
  if (DESK_ASSETS.length === 0) {
    throw new Error('[desks] DESK_ASSETS 至少需要一条')
  }
  // 简易哈希：让相邻座位得到不同桌子
  const h = Math.imul(seatIndex + 1 + seed * 37, 2654435761) >>> 0
  return DESK_ASSETS[h % DESK_ASSETS.length]!
}

export function getDeskAssetById(id: string): DeskAsset | null {
  return DESK_ASSETS.find((d) => d.id === id) ?? null
}
