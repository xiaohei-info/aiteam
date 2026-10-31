import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockers, clearSegment, isBlocked, seatAnchors } from '../src/scene/office/officeMap/geometry.ts'
import {
  CHAIR,
  CHAIR_TIMING,
  ChairAnimator,
  HAND,
  HANDLE,
  LEAVE_STEPS,
  PULL_STEPS,
  SEAT_STEPS,
  TUCK_STEPS,
  chairGates,
  chairPoses,
  chairTravel,
  handAngle,
  handPose,
  handleDuration,
  handleSteps,
  stepsDuration,
  behindChairZ,
} from '../src/scene/office/officeMap/chair.ts'
import { buildSpeedProfile } from '../src/scene/office/officeMap/locomotion.ts'
import { samplePath } from '../src/scene/office/officeMap/geometry.ts'
import type { MapPoint, OfficeMap } from '../src/scene/office/officeMap/types.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

function readMap(): OfficeMap {
  const file = path.join(root, 'public/assets/office/map/office-10-person.json')
  try {
    // SAFETY: 同步产物由编辑器按 office-map/v1.1 导出，schema 在 officeMapScene.test.ts 里断言
    return JSON.parse(readFileSync(file, 'utf8')) as OfficeMap
  } catch (error) {
    throw new Error(`无法读取 ${file}`, { cause: error })
  }
}

// 取自真实地图 seat-01：落座 (116,787)，塞进桌下约在其上方 24px
const seated: MapPoint = { x: 116, y: 787 }
const tucked: MapPoint = { x: 116, y: 762.3 }
const poses = chairPoses(seated, tucked)
const dist = (a: MapPoint, b: MapPoint) => Math.hypot(a.x - b.x, a.y - b.y)

function runTo(animator: ChairAnimator, seconds: number, dt = 1 / 60): void {
  for (let t = 0; t < seconds - 1e-9; t += dt) animator.update(Math.min(dt, seconds - t))
}

test('姿态：拉出位置在「桌下 → 落座」的延长线上，离落座位置 pullDistance', () => {
  assert.deepEqual(poses.seated, seated)
  assert.deepEqual(poses.tucked, tucked)
  assert.ok(Math.abs(dist(poses.pulled, seated) - CHAIR.pullDistance) < 1e-9)
  // 三点共线、顺序是 tucked → seated → pulled
  assert.ok(Math.abs(poses.pulled.x - seated.x) < 1e-9)
  assert.ok(tucked.y < seated.y && seated.y < poses.pulled.y)
})

test('姿态：桌下与落座重合时（没有可推算的方向）默认朝屏幕下方拉出，不产生 NaN', () => {
  const same = chairPoses(seated, seated)
  assert.ok(Number.isFinite(same.pulled.x) && Number.isFinite(same.pulled.y))
  assert.equal(same.pulled.y, seated.y + CHAIR.pullDistance)
})

test('拉出：用力一拉，到位后停住；之后没有动作了', () => {
  const chair = new ChairAnimator(poses.seated)
  chair.play(PULL_STEPS, poses)
  assert.ok(chair.busy)
  runTo(chair, 0.16)
  assert.ok(chair.pos.y > seated.y && chair.pos.y < poses.pulled.y, '拉出途中')
  runTo(chair, 0.2)
  assert.ok(dist(chair.pos, poses.pulled) < 1e-6)
  assert.equal(chair.busy, false)
})

test('放回桌下：先等一下（人走开）再推回，推完空闲', () => {
  const chair = new ChairAnimator(poses.pulled)
  chair.play(TUCK_STEPS, poses)
  runTo(chair, TUCK_STEPS[0].wait - 0.02)
  assert.ok(dist(chair.pos, poses.pulled) < 1e-6, '等待期间椅子不动')
  runTo(chair, 0.02 + TUCK_STEPS[0].duration / 2)
  assert.ok(chair.pos.y < poses.pulled.y && chair.pos.y > tucked.y, '推回途中')
  runTo(chair, TUCK_STEPS[0].duration)
  assert.ok(dist(chair.pos, tucked) < 1e-6)
  assert.equal(chair.busy, false)
})

test('坐下：椅子从拉出位置连人挪回落座位置', () => {
  const chair = new ChairAnimator(poses.pulled)
  chair.play(SEAT_STEPS, poses)
  runTo(chair, stepsDuration(SEAT_STEPS))
  assert.ok(dist(chair.pos, seated) < 1e-6)
  assert.equal(chair.busy, false)
})

test('没有侧门的退路 LEAVE_STEPS：拉出 → 停住等人走开 → 推回桌下', () => {
  const chair = new ChairAnimator(poses.seated)
  chair.play(LEAVE_STEPS, poses)
  runTo(chair, 0.32)
  assert.ok(dist(chair.pos, poses.pulled) < 1e-6, '0.32s 拉到位')
  runTo(chair, 0.3)
  assert.ok(dist(chair.pos, poses.pulled) < 1e-6, '员工起身走开期间椅子停在拉出位置')
  runTo(chair, stepsDuration(LEAVE_STEPS))
  assert.ok(dist(chair.pos, tucked) < 1e-6)
  assert.equal(chair.busy, false)
})

test('拉出再推回：沿单一方向推进、只在拉出到位处折返一次（没有抖动 / 过冲）', () => {
  const chair = new ChairAnimator(poses.seated)
  chair.play(PULL_STEPS, poses)
  let last = chair.pos.y
  let direction = 0
  let reversals = 0
  const track = (): void => {
    const delta = chair.pos.y - last
    if (Math.abs(delta) > 1e-9) {
      const sign = Math.sign(delta)
      if (direction !== 0 && sign !== direction) reversals++
      direction = sign
    }
    assert.ok(chair.pos.y >= tucked.y - 1e-9 && chair.pos.y <= poses.pulled.y + 1e-9, '不越出 tucked ~ pulled 范围')
    last = chair.pos.y
  }
  for (let i = 0; i < 100 && chair.busy; i++) {
    chair.update(1 / 60)
    track()
  }
  chair.play(TUCK_STEPS, poses)
  for (let i = 0; i < 200 && chair.busy; i++) {
    chair.update(1 / 60)
    track()
  }
  assert.equal(reversals, 1)
  assert.ok(dist(chair.pos, tucked) < 1e-6)
})

test('帧率无关：大步长（一次 update 跨过多段）与小步长结果一致', () => {
  const a = new ChairAnimator(poses.seated)
  const b = new ChairAnimator(poses.seated)
  a.play(LEAVE_STEPS, poses)
  b.play(LEAVE_STEPS, poses)
  runTo(a, 0.9, 1 / 240)
  b.update(0.9)
  assert.ok(dist(a.pos, b.pos) < 0.2, `大步长 ${JSON.stringify(b.pos)} 与小步长 ${JSON.stringify(a.pos)} 不一致`)
  b.update(10)
  assert.ok(dist(b.pos, tucked) < 1e-6 && !b.busy, '一次跨过全部步骤也能正确落到终点')
})

test('被打断：椅子在半路又要换动作，从当前位置接着走，不瞬移', () => {
  const chair = new ChairAnimator(poses.tucked)
  chair.play(PULL_STEPS, poses)
  runTo(chair, 0.15)
  const before = { ...chair.pos }
  assert.ok(dist(before, poses.tucked) > 1 && dist(before, poses.pulled) > 1, '确实停在半路')
  chair.play(TUCK_STEPS, poses)
  assert.deepEqual(chair.pos, before, 'play 本身不改变位置')
  chair.update(1 / 60)
  assert.ok(dist(chair.pos, before) < 3, `下一帧位移 ${dist(chair.pos, before)}px，应是平滑接续`)
})

test('snap：立即停在指定位置并取消排队动作', () => {
  const chair = new ChairAnimator(poses.seated)
  chair.play(LEAVE_STEPS, poses)
  runTo(chair, 0.2)
  chair.snap(poses.seated)
  assert.deepEqual(chair.pos, seated)
  assert.equal(chair.busy, false)
  chair.update(1)
  assert.deepEqual(chair.pos, seated)
})

test('时序约束：员工动作都发生在椅子拉出到位之后', () => {
  const pullDone = PULL_STEPS[0].wait + PULL_STEPS[0].duration
  assert.ok(CHAIR_TIMING.leaveWalkAt >= pullDone, '离开：椅子拉出后员工才转身迈步')
  assert.ok(CHAIR_TIMING.enterSitAt >= pullDone, '无侧门退路：椅子拉出后员工才转身坐下')
  assert.ok(stepsDuration(LEAVE_STEPS) > CHAIR_TIMING.leaveWalkAt, '退路：员工迈步之后椅子才推回')
})

test('侧门：在椅子精灵左右两侧、与员工同一排、离边缘 gateMargin', () => {
  const gates = chairGates({ x: 116, y: 787 }, 83.5, 790)
  assert.equal(gates.left.y, 790)
  assert.equal(gates.right.y, 790)
  assert.ok(Math.abs(gates.left.x - (116 - 83.5 / 2 - CHAIR.gateMargin)) < 1e-9)
  assert.ok(Math.abs(gates.right.x - (116 + 83.5 / 2 + CHAIR.gateMargin)) < 1e-9)
  assert.ok(gates.left.x < gates.right.x)
})

test('真实地图：每个工位至少一个侧门站得下，且从落座位置笔直走到侧门不撞桌子（侧身挤出椅子）', () => {
  const map = readMap()
  const polygons = blockers(map, 'employee')
  assert.equal(map.seats?.length, 10)
  for (const seat of map.seats ?? []) {
    const desk = map.elements.find((e) => e.id === seat.deskElementId)
    const chairEl = map.elements.find((e) => e.id === seat.chairElementId)
    assert.ok(desk && chairEl, `${seat.id} 缺少桌子或椅子`)
    const home = seatAnchors(desk, seat.seatOffset, seat.approachOffset).seat
    const gates = chairGates({ x: chairEl.x, y: chairEl.y }, chairEl.width, home.y)
    const usable = [gates.left, gates.right].filter(
      (gate) => !isBlocked(map, gate, 12, 'employee', polygons) && clearSegment(map, home, gate, 12, 'employee', polygons),
    )
    assert.ok(usable.length >= 1, `${seat.id} 两个侧门都走不通`)
    // 访客站位（visitSpot）依赖左侧：左侧门也应当可用，访客才不会占不到椅子左边
    assert.ok(usable.includes(gates.left), `${seat.id} 左侧门不可用`)
  }
})

test('椅子摆动幅度：拉出只比落座多一小截，整个进出一趟的总行程受控', () => {
  assert.ok(CHAIR.pullDistance <= 12, `拉出距离 ${CHAIR.pullDistance}px 太大，椅子会晃得很明显`)
  const tuckedToSeated = dist(poses.tucked, poses.seated)
  const sweep = CHAIR.pullDistance + dist(poses.pulled, poses.tucked)
  assert.ok(sweep <= tuckedToSeated + 2 * CHAIR.pullDistance + 1e-9)
})

test('椅子行程：桌下 = 0、拉出 = 1，越界取边界；落座位置在中间', () => {
  assert.equal(chairTravel(poses.tucked, poses), 0)
  assert.equal(chairTravel(poses.pulled, poses), 1)
  const mid = chairTravel(poses.seated, poses)
  assert.ok(mid > 0 && mid < 1)
  assert.equal(chairTravel({ x: poses.tucked.x, y: poses.tucked.y - 50 }, poses), 0)
  assert.equal(chairTravel({ x: poses.pulled.x, y: poses.pulled.y + 50 }, poses), 1)
  assert.equal(chairTravel(poses.seated, chairPoses(seated, seated, 0)), 0, '没有行程可言时返回 0 而不是 NaN')
})

test('手臂角度：椅子在桌下时手抬得高，拉出来时落低；随椅子位置连续变化', () => {
  assert.equal(handAngle(0), HAND.tucked)
  assert.equal(handAngle(1), HAND.pulled)
  assert.ok(HAND.tucked > HAND.pulled)
  let last = Infinity
  for (let t = 0; t <= 1.0001; t += 0.1) {
    const angle = handAngle(t)
    assert.ok(angle <= last + 1e-9, '角度随拉出单调下降')
    last = angle
  }
  assert.equal(handAngle(-1), HAND.tucked)
  assert.equal(handAngle(2), HAND.pulled)
})

test('手扶动作时序：先抬手（权重 0→1），椅子动的整段握住，椅子到位后松手（1→0）', () => {
  for (const kind of ['pull', 'tuck'] as const) {
    const move = stepsDuration(handleSteps(kind))
    assert.equal(handPose(kind, 0, 1).weight, 0, `${kind} 开始时手还在下面`)
    assert.ok(Math.abs(handPose(kind, HANDLE.raise, 1).weight - 1) < 1e-9, `${kind} 抬手结束时握住`)
    for (let t = HANDLE.raise; t <= HANDLE.raise + move; t += 0.02) {
      assert.ok(Math.abs(handPose(kind, t, 0.5).weight - 1) < 1e-9, `${kind} 椅子动的整段手都握着（t=${t.toFixed(2)}）`)
    }
    assert.equal(handPose(kind, handleDuration(kind), 0).weight, 0, `${kind} 结束时松手`)
    let last = -1
    for (let t = 0; t <= HANDLE.raise; t += 0.01) {
      const w = handPose(kind, t, 1).weight
      assert.ok(w >= last - 1e-9, `${kind} 抬手阶段权重单调上升`)
      last = w
    }
    assert.equal(handleDuration(kind), HANDLE.raise + move + HANDLE.release)
  }
})

test('手扶动作里手跟着椅子走：椅子从拉出推向桌下时，手的角度逐步抬高', () => {
  const chair = new ChairAnimator(poses.pulled)
  chair.play(handleSteps('tuck'), poses)
  let last = -Infinity
  for (let i = 0; i < 60 && chair.busy; i++) {
    chair.update(1 / 60)
    const angle = handPose('tuck', HANDLE.raise + i / 60, chairTravel(chair.pos, poses)).angle
    assert.ok(angle >= last - 1e-9, '推回桌下时手越抬越高')
    last = angle
  }
  assert.ok(Math.abs(last - HAND.tucked) < 1e-6)
})

test('手扶动作不能慢于人离开 / 回座的节奏太多：整套动作在 1 秒内', () => {
  assert.ok(handleDuration('pull') <= 1, `拉椅子 ${handleDuration('pull')}s`)
  assert.ok(handleDuration('tuck') <= 1, `推椅子 ${handleDuration('tuck')}s`)
})

test('速度曲线：途中指定的停靠点速度上限为 0，之前按制动曲线提前收步，之后仍能起步', () => {
  const samples = samplePath([{ x: 0, y: 0 }, { x: 300, y: 0 }], 6)
  const stopAt = 25
  const profile = buildSpeedProfile(samples, 60, undefined, [stopAt])
  assert.equal(profile[stopAt], 0)
  // 采样步长 6px、制动 170px/s²：紧邻停靠点的一格上限约 45px/s，再往前一两格才超过巡航被封顶
  assert.ok(profile[stopAt - 1] > 0 && profile[stopAt - 1] < 60, '紧邻停靠点的一格在收步')
  assert.ok(profile[stopAt - 1] < profile[stopAt - 2] || profile[stopAt - 2] === 60, '越靠近停靠点上限越低')
  assert.equal(profile[stopAt - 24], 60, '离停靠点够远的地方保持巡航')
  assert.ok(profile[stopAt + 5] > 0, '停靠点之后可以重新起步')
  assert.equal(profile[profile.length - 1], 0)
  assert.deepEqual(buildSpeedProfile(samples, 60), buildSpeedProfile(samples, 60, undefined, []), '不传停靠点与以前一致')
})

test('椅背后面的层级：在电脑 / 屏幕之上、椅子之下（起身离座 / 回座进座时不被屏幕盖住）', () => {
  // 样板地图的层级：桌 0，落座 = 桌 + 2，电脑 6（屏幕 7），椅子 12
  const z = behindChairZ(2, 6, 12)
  assert.ok(z > 6 + 1, `应高于屏幕（${z}）`)
  assert.ok(z < 12, `应低于椅子（${z}）`)
  assert.ok(z > 2, '应高于落座层级')
})

test('椅背后面的层级：夹不出区间 / 缺少电脑或椅子时退回落座层级', () => {
  assert.equal(behindChairZ(2, 6, undefined), 2, '没有椅子：没有侧门行程，保持落座层级')
  assert.equal(behindChairZ(2, undefined, 12), 2, '没有电脑：没有可遮挡的东西')
  assert.equal(behindChairZ(2, 6, 7), 2, '椅子只比屏幕高 0：夹不出区间')
  assert.equal(behindChairZ(2, 6, 5), 2, '椅子在屏幕之下')
})

test('样板地图每个工位的椅背后面层级都在其电脑屏幕之上、椅子之下', () => {
  const mapData = JSON.parse(readFileSync(path.join(root, 'public/assets/office/map/office-10-person.json'), 'utf8')) as OfficeMap
  const byId = new Map(mapData.elements.map((e) => [e.id, e]))
  const seats = mapData.seats ?? []
  assert.ok(seats.length > 0)
  for (const seat of seats) {
    const desk = byId.get(seat.deskElementId)
    const computer = seat.computerElementId ? byId.get(seat.computerElementId) : undefined
    const chair = seat.chairElementId ? byId.get(seat.chairElementId) : undefined
    assert.ok(desk && computer && chair, `${seat.id} 缺少桌 / 电脑 / 椅子`)
    const z = behindChairZ(desk.zIndex + 2, computer.zIndex, chair.zIndex)
    assert.ok(z > computer.zIndex + 1 && z < chair.zIndex, `${seat.id}: ${z} 不在 (${computer.zIndex + 1}, ${chair.zIndex}) 内`)
  }
})
