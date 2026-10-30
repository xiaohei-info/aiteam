/**
 * 员工形象（Spine Chibi Stickers）注册表
 *
 * - 员工模型来自参考工程 ai-office-react/dist/assets/characters/chibi-stickers
 * - 一套 Spine skeleton + atlas，包含 9 套皮肤（不同角色外观）
 * - 皮肤按座位索引稳定分配（同一 seatIndex 每次结果一致，超过 9 循环复用）
 */

export type ChibiFacing = 'front' | 'back' | 'left' | 'right'

export const CHIBI_CHARACTER_SKINS = [
  'misaki',
  'erikari',
  'nate',
  'harri',
  'luke',
  'soeren',
  'mario',
  'sinisa',
  'spineboy',
] as const

export type ChibiCharacterSkin = (typeof CHIBI_CHARACTER_SKINS)[number]

/** Spine 动画名映射（与参考工程 chibi-stickers.json 对齐） */
export const CHIBI_ANIM = {
  idleFront: 'movement/idle-front',
  idleBack: 'movement/idle-back',
  idleLeft: 'movement/idle-left',
  idleRight: 'movement/idle-right',
  trotFront: 'movement/trot-front',
  trotBack: 'movement/trot-back',
  trotLeft: 'movement/trot-left',
  trotRight: 'movement/trot-right',
  thinking: 'emotes/thinking',
  wave: 'emotes/wave',
  determined: 'emotes/determined',
} as const

/** Spine 资源路径（相对 public/） */
export const CHIBI_SPINE_ASSETS = {
  id: 'chibi-stickers',
  /**
   * 渲染用骨骼：AIFred 原骨架 + 左右行走膝盖方向修正（chibi-stickers-walk.json，派生文件）。
   * 修正只动 movement/trot-left|right：小腿旋转取反 + 去掉单腿反向的 IK bendPositive，
   * 使膝盖朝行进方向弯曲。原文件 chibi-stickers.json 保持 byte-exact 不动。
   */
  skeleton: '/assets/characters/chibi-stickers/chibi-stickers-walk.json',
  atlas: '/assets/characters/chibi-stickers/chibi-stickers.atlas',
} as const

/** 默认座位朝向：背对镜头（专注工作） */
export const DEFAULT_SEAT_FACING: ChibiFacing = 'back'

/** 依据座位索引稳定选取皮肤（伪随机、可复现） */
export function pickCharacterSkin(seatIndex: number, seed = 0): ChibiCharacterSkin {
  const h = Math.imul(seatIndex + 1 + seed * 37, 2654435761) >>> 0
  return CHIBI_CHARACTER_SKINS[h % CHIBI_CHARACTER_SKINS.length]!
}

/**
 * 屏幕朝左 / 朝右对应的「角色自身左右」动画名。
 *
 * 注意：chibi-stickers 资源里 left/right 是按角色自身左右命名的（角色正面朝镜头，
 * 所以角色自己的左边 = 屏幕右边），与屏幕左右相反：`idle-left` / `trot-left`
 * 在屏幕上其实是朝右的姿势。原工程 SpineCharacter 的 CHIBI_DIR_ANIM 注释即
 * 「Chibi 资源里 left/right 与屏幕左右相反」，并同样做了这层对调。
 * 这里如果直接按同名映射，员工左右移动时动作（身体/朝向/膝盖）和运动方向就是反的。
 */
export function idleAnimByFacing(facing: ChibiFacing): string {
  switch (facing) {
    case 'back':
      return CHIBI_ANIM.idleBack
    case 'left':
      return CHIBI_ANIM.idleRight
    case 'right':
      return CHIBI_ANIM.idleLeft
    default:
      return CHIBI_ANIM.idleFront
  }
}

/** 根据朝向获取对应的走动动画（left/right 与屏幕左右相反，见上） */
export function trotAnimByFacing(facing: ChibiFacing): string {
  switch (facing) {
    case 'back':
      return CHIBI_ANIM.trotBack
    case 'left':
      return CHIBI_ANIM.trotRight
    case 'right':
      return CHIBI_ANIM.trotLeft
    default:
      return CHIBI_ANIM.trotFront
  }
}
