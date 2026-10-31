// 办公室渲染派生骨骼的「工作动画」补丁（纯函数，浏览器/Node 通用，便于单测）。
//
// 背景：前端在员工「工作中」时需要在 思考(emotes/thinking) 与 打字 之间切换，
// 但 chibi-stickers 原骨架里没有打字动画。这里在派生骨骼里合成一个最小、可循环的
// emotes/typing：
//   - 以 movement/idle-back 为底（员工坐姿背对镜头，最贴近工位姿态），保留它的
//     身体/头部/髋部轨道与 drawOrder，保证坐姿正确；
//   - 只覆盖左右上臂(arm-holder-*)、小臂(arm-down-*)与手(arm-up-*)的 rotate 轨道，
//     用「抬起—落回」的等价往返关键帧模拟双手交替敲键盘；
//   - 关键帧首尾取值一致，循环播放不会跳变。
// 原骨架 chibi-stickers.json 保持 byte-exact 不动，结果输出到派生文件
// chibi-stickers-walk.json（文件名沿用历史命名，现在只多一个打字动画）。
//
// 走路动画不做任何改动：曾经的「左右行走膝盖取反」补丁与 left/right 朝向对调是同一问题的
// 两种修法，两者叠加后膝盖又反了。现在只保留朝向对调（名为 left 的动画在屏幕上朝右），
// 原骨架在这个映射下两条腿的膝盖都朝行进方向弯，由 tests/aifred-assets.test.mjs 用 spine-core 实算校验。

export const TYPING_ANIMATION = 'emotes/typing'
export const TYPING_SOURCE_ANIMATION = 'movement/idle-back'
/** 打字动画总时长（秒）；与 idle-back 一致，避免混合时长度突变 */
export const TYPING_DURATION = 1.3

/**
 * 每条手臂轨道：相对 idle-back 静息姿势的摆幅（度）。
 * 左右摆幅取相反符号，让两只手上下交替；offset 让右手比左手错开半拍。
 */
const TYPING_TRACKS = [
  { bone: 'arm-holder-l', amplitude: 1.8, taps: 2, offset: 0 },
  { bone: 'arm-holder-r', amplitude: -1.8, taps: 2, offset: 1 },
  { bone: 'arm-down-l', amplitude: 7.5, taps: 6, offset: 0 },
  { bone: 'arm-down-r', amplitude: -7.5, taps: 6, offset: 1 },
  { bone: 'arm-up-l', amplitude: 3.2, taps: 4, offset: 1 },
  { bone: 'arm-up-r', amplitude: -3.2, taps: 4, offset: 0 },
]
const HEAD_TRACK = { bone: 'head-base', amplitude: -1.8, taps: 1, offset: 0 }
/** 打字动画里参与摆动的手臂骨骼（供测试与文档引用） */
export const TYPING_ARM_BONES = [...TYPING_TRACKS.map((track) => track.bone)]
export const TYPING_HEAD_BONE = HEAD_TRACK.bone
const ROUND = (value) => Math.round(value * 100) / 100

/** 从已有动画里取某骨骼 rotate 轨道的首个关键帧值（缺失时返回 0） */
function restRotation(animation, bone) {
  const first = animation?.bones?.[bone]?.rotate?.[0]
  return typeof first?.value === 'number' ? first.value : 0
}

/**
 * 生成一条「抬起—落回」循环轨道：len 个关键帧里每隔一帧抬到 base+amplitude，
 * 其余帧回到 base；首尾取值一致（steps 为偶数且 offset 只整体错相），循环无跳变。
 */
function tapTrack(duration, base, { amplitude, taps, offset }) {
  const steps = Math.max(1, taps) * 2
  const keys = []
  for (let k = 0; k <= steps; k++) {
    const lifted = (k + offset) % 2 === 1
    const key = { value: ROUND(base + (lifted ? amplitude : 0)) }
    if (k > 0) key.time = ROUND((k * duration) / steps)
    keys.push(key)
  }
  return keys
}

/** 在派生骨骼里合成 emotes/typing（返回新对象，不修改入参） */
export function buildTypingAnimation(skeleton) {
  const source = skeleton?.animations?.[TYPING_SOURCE_ANIMATION]
  if (!source) throw new Error(`骨架缺少底动画 ${TYPING_SOURCE_ANIMATION}`)
  const animation = structuredClone(source)
  for (const track of [...TYPING_TRACKS, HEAD_TRACK]) {
    const base = restRotation(source, track.bone)
    if (track.bone === HEAD_TRACK.bone) {
      // head-base 在 idle-back 里用的是 translate，额外补一条 rotate 轻微点头。
      animation.bones[track.bone] = {
        ...(animation.bones[track.bone] ?? {}),
        rotate: tapTrack(TYPING_DURATION, base, track),
      }
      continue
    }
    animation.bones[track.bone] = {
      ...(animation.bones[track.bone] ?? {}),
      rotate: tapTrack(TYPING_DURATION, base, track),
    }
  }
  animation.__typingPatched = true
  return animation
}

/**
 * 完整派生：原骨架 + 打字动画。
 * 幂等保护：对已经打过补丁的骨骼再跑一次会报错，避免重复叠加。
 */
export function patchOfficeAnimation(skeleton) {
  const patched = structuredClone(skeleton)
  if (patched.animations?.[TYPING_ANIMATION]) {
    throw new Error(`骨架已包含 ${TYPING_ANIMATION}，不能重复添加`)
  }
  const typing = buildTypingAnimation(patched)
  patched.animations[TYPING_ANIMATION] = typing
  return {
    patched,
    stats: {
      typingTracks: Object.keys(typing.bones).length,
      typingKeys: Object.values(typing.bones).reduce((sum, tracks) => sum + (tracks.rotate?.length ?? 0), 0),
    },
  }
}

/** 骨架是否已经带有打字动画（用于判断派生文件是否最新） */
export function hasTypingAnimation(skeleton) {
  const typing = skeleton?.animations?.[TYPING_ANIMATION]
  if (!typing || typing.__typingPatched !== true) return false
  return [...TYPING_TRACKS, HEAD_TRACK].every(({ bone }) => (typing.bones?.[bone]?.rotate?.length ?? 0) >= 2)
}

/** 是否已经整体打过办公室补丁 */
export function hasOfficeAnimationPatch(skeleton) {
  return hasTypingAnimation(skeleton)
}

/**
 * 结构对比：返回相对原骨架有差异的动画名与顶层字段。
 * 正确的派生骨骼只应多出 emotes/typing，其它动画与骨架结构必须逐字节一致。
 */
export function officeAnimationDiff(original, patched) {
  const changed = []
  for (const name of Object.keys(original?.animations ?? {})) {
    if (JSON.stringify(original.animations[name]) !== JSON.stringify(patched?.animations?.[name])) changed.push(name)
  }
  for (const key of Object.keys(original ?? {})) {
    if (key === 'animations') continue
    if (JSON.stringify(original[key]) !== JSON.stringify(patched?.[key])) changed.push(key)
  }
  for (const name of Object.keys(patched?.animations ?? {})) {
    if (!(name in (original?.animations ?? {}))) changed.push(name)
  }
  return changed
}
