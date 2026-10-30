// Snapshot of AIFred's src/config/office/characters.ts and DeskChairEntity.ts.
// Original artwork is synced byte-for-byte; this module contains only bindings.
export const AIFRED_RESOURCE_ID = 'aifred-chibi-stickers'
export const AIFRED_SKINS = ['misaki', 'erikari', 'nate', 'harri', 'luke', 'soeren', 'mario', 'sinisa', 'spineboy']
export const EMPLOYEE_ANIMATIONS = { idle: '待机', thinking: '思考', talking: '挥手 / 说话', walking: '原地走动预览' }
export const AIFRED_SKELETON_ORIGINAL = 'assets/aifred/characters/chibi-stickers/chibi-stickers.json'
// 渲染用骨架：原骨架 byte-exact 快照 + 工作打字动画（派生文件，见 src/work-anim.js；走路动画保持原样）
export const AIFRED_SKELETON = 'assets/aifred/characters/chibi-stickers/chibi-stickers-walk.json'
export const AIFRED_ATLAS = 'assets/aifred/characters/chibi-stickers/chibi-stickers.atlas'
export const WORKSTATION_WIDTH = 144
export const AIFRED_DESK_HEIGHT = WORKSTATION_WIDTH * 582 / 920
export const AIFRED_CHAIR_WIDTH = WORKSTATION_WIDTH * 0.58
export const AIFRED_CHAIR_HEIGHT = AIFRED_CHAIR_WIDTH * 492 / 474
// 电脑：贴图基准 82.5×55（screen 矩形的 1× 坐标系），放置时默认放大 1.25×。
// 放大上限 ≈ 1.25×：屏幕要落在「员工右缘」与「桌右缘」之间（可用宽约 72，1× 屏幕宽 55.1），再大会贴员工或伸出桌沿。
// 电脑底边（键盘）位置不变，只向桌后方长高，所以 computerOffset.y 比 1× 时小。
export const AIFRED_COMPUTER_SCALE = 1.25
export const AIFRED_COMPUTER_OFFSET = { x: 0.75, y: 0.27 }
export function pickEmployeeSkin(index) {
  const h = Math.imul(index + 1, 2654435761) >>> 0
  return AIFRED_SKINS[h % AIFRED_SKINS.length]
}
// chibi-stickers 里 left/right 按角色自身命名（角色正面朝镜头），与屏幕左右相反：
// 名为 left 的动画在屏幕上其实朝右。工位 facing 记的是屏幕朝向，所以要取反，
// 否则预览/前端里员工的动作会和移动方向相反。
const SCREEN_SIDE_TO_ANIM_SIDE = { left: 'right', right: 'left' }

export function employeeAnimation(employee, facing) {
  if (employee.animation === 'thinking') return 'emotes/thinking'
  if (employee.animation === 'talking') return 'emotes/wave'
  const side = SCREEN_SIDE_TO_ANIM_SIDE[facing] ?? facing
  return `movement/${employee.animation === 'walking' ? 'trot' : 'idle'}-${side}`
}
export const AIFRED_TEMPLATES = [
  { id: 'aifred-desk', name: 'AIFred 原有办公桌', category: '工位 · AIFred', kind: 'image', src: 'assets/aifred/office/desk.png', width: WORKSTATION_WIDTH, height: AIFRED_DESK_HEIGHT, blocksMovement: true, footprints: [{ x: 6, y: AIFRED_DESK_HEIGHT * 0.46, width: 132, height: AIFRED_DESK_HEIGHT * 0.51 }] },
  { id: 'aifred-chair', name: 'AIFred 原有办公椅', category: '工位 · AIFred', kind: 'image', src: 'assets/aifred/office/chair.png', width: AIFRED_CHAIR_WIDTH, height: AIFRED_CHAIR_HEIGHT, blocksMovement: false, zIndex: 12 },
  { id: 'aifred-computer', name: 'AIFred 原有电脑显示器', category: '工位 · AIFred', kind: 'image', src: 'assets/aifred/office/office_computer_bg.png', width: 82.5, height: 55, defaultScale: AIFRED_COMPUTER_SCALE, blocksMovement: false, zIndex: 6, screen: { x: 13.7, y: 3.8, width: 55.1, height: 35.4 } },
]
