// 办公室派生骨骼的「方向动作」补丁（纯函数，浏览器 / Node 通用，便于单测）。
//
// 原骨架只有待机、走路分前后左右四个方向，思考、挥手等表情只有正面一版。这里在派生骨骼里补齐：
//   think 思考、talk 挥手、rest 闭目养神、sit 坐下、tea 喝茶、coffee 喝咖啡，每个动作 4 个方向。
//
// 动画按屏幕朝向命名：office/<action>-<facing>，facing 是 front / back / left / right。
// 原骨架里名为 left 的动画在屏幕上朝右（见 aifred-resources.js），新动画不沿用这个反向命名。
//
// 做法：
//   - 方向版 = 正面动作 + (该方向待机 − 正面待机) 的静态差，再换上该方向待机的绘制顺序。
//     Spine 4 的骨骼时间轴记录的是相对 setup 的偏移，所以差值可以直接叠加（贝塞尔曲线的取值点同步平移）。
//   - 坐下按地图上的俯视椅子对位：屁股落在锚点（座位中心），上身往上画，腿朝面向的一侧伸。
//     正 / 背面大腿朝镜头透视缩短、小腿垂下；侧面大腿水平朝前、小腿竖直，膝盖朝上。
//   - 喝茶 / 喝咖啡给两只手各加一根不随手臂旋转的杯子骨骼，杯子和热气的贴图放在派生图集的道具页里。
//     面向哪边就用不被身体挡住的那只手；背面看不到杯子，只保留抬手动作。
// 新骨骼 / 插槽只追加在列表末尾：绘制顺序时间轴按原下标记录偏移，插在中间会打乱原有动画。

export const OFFICE_ACTIONS = ['think', 'talk', 'rest', 'sit', 'tea', 'coffee']
export const OFFICE_FACINGS = ['front', 'back', 'left', 'right']
const ANIM_SIDE = { front: 'front', back: 'back', left: 'right', right: 'left' }
const idleOf = (facing) => `movement/idle-${ANIM_SIDE[facing]}`

/** 方向动作的动画名（facing 为屏幕朝向） */
export function officeActionAnimation(action, facing) {
  return `office/${action}-${facing}`
}

/** 道具页：区域坐标与 scripts/office-props/props.svg 的布局一致 */
export const OFFICE_PROPS_PAGE = 'chibi-office-props.png'
export const OFFICE_PROPS_SIZE = { width: 300, height: 110 }
export const OFFICE_PROP_REGIONS = {
  'office/teacup': { x: 0, y: 0, width: 124, height: 96 },
  'office/mug': { x: 128, y: 0, width: 104, height: 104 },
  'office/steam': { x: 236, y: 0, width: 60, height: 96 },
}

/** 派生图集追加的道具页（普通透明度，不预乘） */
export function officePropsAtlasPage() {
  const lines = [OFFICE_PROPS_PAGE, `\tsize: ${OFFICE_PROPS_SIZE.width}, ${OFFICE_PROPS_SIZE.height}`, '\tfilter: Linear, Linear']
  for (const [name, r] of Object.entries(OFFICE_PROP_REGIONS)) lines.push(name, `\tbounds: ${r.x}, ${r.y}, ${r.width}, ${r.height}`)
  return `${lines.join('\n')}\n`
}

/** 派生图集 = 原图集 + 空行 + 道具页 */
export function deriveOfficeAtlas(originalAtlas) {
  return `${originalAtlas.replace(/\s*$/, '')}\n\n${officePropsAtlasPage()}`
}

const ROUND = (value) => Math.round(value * 100) / 100
const SCALE_DEFAULT = (type) => (type === 'scale' ? 1 : 0)

function firstValue(animation, bone, type) {
  const key = animation?.bones?.[bone]?.[type]?.[0]
  if (type === 'rotate') return { value: key?.value ?? 0 }
  return { x: key?.x ?? SCALE_DEFAULT(type), y: key?.y ?? SCALE_DEFAULT(type) }
}

const isZero = (type, d) => (type === 'rotate' ? d.value === 0 : d.x === 0 && d.y === 0)

/** 时间轴整体平移 d；贝塞尔曲线的取值点（奇数位）一起平移 */
function shiftKeys(keys, type, d) {
  return keys.map((key) => {
    const next = { ...key }
    if (type === 'rotate') {
      next.value = ROUND((key.value ?? 0) + d.value)
      if (Array.isArray(key.curve)) next.curve = key.curve.map((c, i) => (i % 2 ? ROUND(c + d.value) : c))
      return next
    }
    next.x = ROUND((key.x ?? 0) + d.x)
    next.y = ROUND((key.y ?? 0) + d.y)
    if (Array.isArray(key.curve)) next.curve = key.curve.map((c, i) => (i % 2 ? ROUND(c + (i < 4 ? d.x : d.y)) : c))
    return next
  })
}

/** 给骨骼叠加静态偏移：已有时间轴整体平移，没有就新建单帧 */
function addOffset(animation, bone, type, d) {
  const tracks = (animation.bones[bone] ??= {})
  if (tracks[type]) tracks[type] = shiftKeys(tracks[type], type, d)
  else tracks[type] = [type === 'rotate' ? { value: ROUND(d.value) } : { x: ROUND(d.x), y: ROUND(d.y) }]
}

/** 正面动作 → 某方向：叠加（方向待机 − 正面待机）的静态差，并换上方向待机的绘制顺序 */
function toFacing(animations, action, facing) {
  const result = structuredClone(action)
  result.bones ??= {}
  if (facing === 'front') return result
  const base = animations[idleOf(facing)], front = animations[idleOf('front')]
  const bones = new Set([...Object.keys(base.bones ?? {}), ...Object.keys(front.bones ?? {})])
  for (const bone of bones) {
    for (const type of ['rotate', 'translate']) {
      const b = firstValue(base, bone, type), f = firstValue(front, bone, type)
      const d = type === 'rotate' ? { value: b.value - f.value } : { x: b.x - f.x, y: b.y - f.y }
      if (!isZero(type, d)) addOffset(result, bone, type, d)
    }
  }
  if (base.drawOrder) result.drawOrder = structuredClone(base.drawOrder)
  else delete result.drawOrder
  return result
}

/** 时间整体拉伸 factor 倍（曲线的时间点在偶数位） */
function stretch(animation, factor) {
  const scaleTime = (t) => ROUND(t * factor)
  const result = structuredClone(animation)
  for (const tracks of Object.values(result.bones ?? {})) {
    for (const keys of Object.values(tracks)) {
      for (const key of keys) {
        if (key.time !== undefined) key.time = scaleTime(key.time)
        if (Array.isArray(key.curve)) key.curve = key.curve.map((c, i) => (i % 2 ? c : scaleTime(c)))
      }
    }
  }
  for (const frame of result.drawOrder ?? []) if (frame.time !== undefined) frame.time = scaleTime(frame.time)
  return result
}

const keyed = (times, make) => times.map((time, i) => ({ ...(i ? { time } : {}), ...make(i) }))

// ---------------------------------------------------------------- 闭目养神

const REST_STRETCH = 2
function buildRest(animations, facing) {
  const rest = stretch(animations[idleOf(facing)], REST_STRETCH)
  rest.bones['head-base'] = { ...(rest.bones['head-base'] ?? {}), rotate: [{ value: 0 }, { time: 1.3, value: -5 }, { time: 2.6, value: 0 }] }
  rest.slots = {
    'eye-l': { attachment: [{ name: 'eye-equal' }] },
    'eye-r': { attachment: [{ name: 'eye-equal' }] },
    mouth: { attachment: [{ name: 'mouth-line' }] },
  }
  return rest
}

// ---------------------------------------------------------------- 坐下

/** 坐姿参数（骨架单位）；HIPS_Y 是 setup 里髋部离脚底的高度 */
export const SIT = { hipsY: 155.08, thigh: 82.42, foreshorten: 0.45, sideDrop: 76 }
const sideOf = (facing) => (facing === 'left' ? -1 : facing === 'right' ? 1 : 0)

function buildSit(animations, facing) {
  const sit = structuredClone(animations[idleOf(facing)])
  const side = sideOf(facing)
  if (!side) {
    // 正 / 背面：大腿朝镜头透视缩短，小腿反向缩放保持原长（子骨骼会继承缩放）
    const k = SIT.foreshorten, drop = SIT.thigh * (1 - k)
    addOffset(sit, 'hips', 'translate', { x: 0, y: -drop })
    addOffset(sit, 'root', 'translate', { x: 0, y: -(SIT.hipsY - drop) })
    for (const leg of ['l', 'r']) {
      sit.bones[`leg-up-${leg}`] = { ...(sit.bones[`leg-up-${leg}`] ?? {}), scale: [{ x: k, y: 1 }] }
      sit.bones[`leg-down-${leg}`] = { ...(sit.bones[`leg-down-${leg}`] ?? {}), scale: [{ x: ROUND(1 / k), y: 1 }] }
    }
    // 关掉腿部 IK：腿缩短后 IK 仍把脚拉回原位，会把膝盖往外折（穿裤子的皮肤看得出来）；关掉后小腿笔直垂下
    sit.ik = { 'leg-target-r': [{ mix: 0 }], 'leg-target-l': [{ mix: 0 }] }
    return sit
  }
  // 侧面：大腿水平朝前、小腿竖直；IK 弯向让膝盖朝上
  addOffset(sit, 'hips', 'translate', { x: 0, y: -SIT.sideDrop })
  addOffset(sit, 'root', 'translate', { x: 0, y: -(SIT.hipsY - SIT.sideDrop) })
  for (const leg of ['l', 'r']) {
    const current = sit.bones[`leg-target-${leg}`]?.translate?.[0] ?? {}
    sit.bones[`leg-target-${leg}`] = { translate: [{ x: ROUND((current.x ?? 0) + side * SIT.thigh), y: current.y ?? 0 }] }
  }
  sit.ik = { 'leg-target-r': [{ bendPositive: side < 0 }], 'leg-target-l': [{ bendPositive: side > 0 }] }
  return sit
}

// ---------------------------------------------------------------- 喝茶 / 喝咖啡

export const OFFICE_CUPS = { tea: 'office/teacup', coffee: 'office/mug' }
export const OFFICE_STEAM = 'office/steam'
const PROP_SCALE = 0.8
const CUP_BONE_X = 62
const CUP_OFFSET_Y = { 'office/teacup': -4, 'office/mug': 0 }
const STEAM_Y = 70
/** 面向哪边就用哪只手：转向一侧时，另一只手会被换到身体后面 */
export const DRINK_HAND = { front: 'l', back: 'l', right: 'l', left: 'r' }
// 左右手的手臂骨骼不对称（左臂挂在 scaleY=-1 的骨骼上）：上臂角度同号，小臂角度取反
const DRINK_POSE = {
  l: { hold: { holder: -55, down: 115 }, sip: { holder: -105.63, down: 101.23 } },
  r: { hold: { holder: -35, down: -115 }, sip: { holder: -105.63, down: -101.23 } },
}
const DRINK_TIMES = [0, 1.4, 1.8, 2.6, 3, 4]
const DRINK_STEPS = ['hold', 'hold', 'sip', 'sip', 'hold', 'hold']

function buildDrinkFront(animations, kind, hand, showCup) {
  const drink = structuredClone(animations[idleOf('front')])
  const pose = DRINK_POSE[hand]
  drink.bones[`arm-holder-${hand}`] = { rotate: keyed(DRINK_TIMES, (i) => ({ value: pose[DRINK_STEPS[i]].holder })) }
  drink.bones[`arm-down-${hand}`] = { rotate: keyed(DRINK_TIMES, (i) => ({ value: pose[DRINK_STEPS[i]].down })) }
  drink.bones['head-base'] = {
    ...(drink.bones['head-base'] ?? {}),
    rotate: [{ value: 0 }, { time: 1.6, value: 0 }, { time: 2, value: 5 }, { time: 2.6, value: 5 }, { time: 3, value: 0 }],
  }
  drink.slots = {
    'eye-l': { attachment: [{ time: 1.9, name: 'eye-closed-happy' }, { time: 2.7, name: 'eye-dafault' }] },
    'eye-r': { attachment: [{ time: 1.9, name: 'eye-closed-happy' }, { time: 2.7, name: 'eye-dafault' }] },
  }
  if (!showCup) return drink
  drink.bones[`office-steam-${hand}`] = { translate: [{ y: -6 }, { time: 1.3, y: 14 }, { time: 2.7, y: -6 }, { time: 4, y: 14 }] }
  drink.slots[`office-cup-${hand}`] = { attachment: [{ name: OFFICE_CUPS[kind] }] }
  drink.slots[`office-steam-${hand}`] = {
    attachment: [{ name: OFFICE_STEAM }, { time: 1.5, name: null }, { time: 3, name: OFFICE_STEAM }],
    rgba: [{ color: 'ffffff00' }, { time: 0.5, color: 'ffffffdd' }, { time: 1.4, color: 'ffffff00' }, { time: 3, color: 'ffffff00' }, { time: 3.5, color: 'ffffffdd' }, { time: 4, color: 'ffffff00' }],
  }
  return drink
}

function addPropRig(skeleton) {
  const defaultSkin = skeleton.skins.find((skin) => skin.name === 'default')
  if (!defaultSkin) throw new Error('骨架缺少 default 皮肤，无法挂道具贴图')
  defaultSkin.attachments ??= {}
  const region = (name, y) => ({ x: 0, y, width: OFFICE_PROP_REGIONS[name].width * PROP_SCALE, height: OFFICE_PROP_REGIONS[name].height * PROP_SCALE })
  for (const hand of ['l', 'r']) {
    skeleton.bones.push({ name: `office-cup-${hand}`, parent: `arm-down-${hand}`, x: CUP_BONE_X, inherit: 'noRotationOrReflection' })
    skeleton.bones.push({ name: `office-steam-${hand}`, parent: `office-cup-${hand}` })
    skeleton.slots.push({ name: `office-cup-${hand}`, bone: `office-cup-${hand}` })
    skeleton.slots.push({ name: `office-steam-${hand}`, bone: `office-steam-${hand}` })
    defaultSkin.attachments[`office-cup-${hand}`] = Object.fromEntries(Object.values(OFFICE_CUPS).map((name) => [name, region(name, CUP_OFFSET_Y[name])]))
    defaultSkin.attachments[`office-steam-${hand}`] = { [OFFICE_STEAM]: region(OFFICE_STEAM, STEAM_Y) }
  }
}

// ---------------------------------------------------------------- 汇总

/** 在骨架上追加方向动作与道具（就地修改；调用方负责先 structuredClone） */
export function addOfficeActions(skeleton) {
  const animations = skeleton.animations
  for (const name of [...OFFICE_FACINGS.map(idleOf), 'emotes/thinking', 'emotes/wave']) {
    if (!animations[name]) throw new Error(`骨架缺少底动画 ${name}`)
  }
  if (OFFICE_ACTIONS.some((action) => animations[officeActionAnimation(action, 'front')])) throw new Error('骨架已包含方向动作，不能重复添加')
  addPropRig(skeleton)
  for (const facing of OFFICE_FACINGS) {
    const hand = DRINK_HAND[facing]
    const built = {
      think: toFacing(animations, animations['emotes/thinking'], facing),
      talk: toFacing(animations, animations['emotes/wave'], facing),
      rest: buildRest(animations, facing),
      sit: buildSit(animations, facing),
      tea: toFacing(animations, buildDrinkFront(animations, 'tea', hand, facing !== 'back'), facing),
      coffee: toFacing(animations, buildDrinkFront(animations, 'coffee', hand, facing !== 'back'), facing),
    }
    for (const action of OFFICE_ACTIONS) animations[officeActionAnimation(action, facing)] = built[action]
  }
  return OFFICE_ACTIONS.length * OFFICE_FACINGS.length
}

const PROP_NAMES = ['l', 'r'].flatMap((hand) => [`office-cup-${hand}`, `office-steam-${hand}`])

/** 撤掉 addOfficeActions 加的内容（就地修改），用于在已打过补丁的骨架上重新生成 */
export function removeOfficeActions(skeleton) {
  for (const name of Object.keys(skeleton.animations ?? {})) if (name.startsWith('office/')) delete skeleton.animations[name]
  const props = new Set(PROP_NAMES)
  skeleton.bones = skeleton.bones.filter((bone) => !props.has(bone.name))
  skeleton.slots = skeleton.slots.filter((slot) => !props.has(slot.name))
  const attachments = skeleton.skins.find((skin) => skin.name === 'default')?.attachments
  if (attachments) for (const name of PROP_NAMES) delete attachments[name]
  return skeleton
}

/** 骨架是否已带齐全部方向动作与道具插槽 */
export function hasOfficeActions(skeleton) {
  const animations = skeleton?.animations ?? {}
  const slots = new Set((skeleton?.slots ?? []).map((slot) => slot.name))
  return OFFICE_ACTIONS.every((action) => OFFICE_FACINGS.every((facing) => animations[officeActionAnimation(action, facing)]))
    && ['l', 'r'].every((hand) => slots.has(`office-cup-${hand}`) && slots.has(`office-steam-${hand}`))
}
