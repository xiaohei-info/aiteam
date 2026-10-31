import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChibiFacing } from '../src/config/office/characters.ts'
import {
  GAIT,
  footCycle,
  gaitAmplitude,
  gaitCadence,
  gaitGate,
  gaitPose,
  kneeBend,
  legFit,
  walkDir,
} from '../src/scene/office/officeMap/gait.ts'

const FACINGS: ChibiFacing[] = ['right', 'left', 'front', 'back']
const PHASES = Array.from({ length: 240 }, (_, i) => i / 240)

test('单脚周期：站立相脚匀速后移，摆动相首尾与站立相衔接', () => {
  const eps = 1e-4
  const at = (p: number) => footCycle(p).fwd
  // 站立相线性后移，速度 = -1/stance
  const speed = (at(0.3 + eps) - at(0.3)) / eps
  assert.ok(Math.abs(speed + 1 / GAIT.stance) < 1e-3, `站立相速度 ${speed}`)
  // 周期首尾连续（最后摆到最前、落地即开始后移）
  assert.ok(Math.abs(at(0) - 0.5) < 1e-9)
  assert.ok(Math.abs(at(1 - 1e-9) - 0.5) < 1e-3)
  // 站立相贴地，摆动相才离地
  assert.equal(footCycle(0.2).lift, 0)
  assert.ok(footCycle((GAIT.stance + 1) / 2).lift > 0.9)
  assert.ok(footCycle(0.999999).lift < 0.01)
})

test('左右脚相差半个周期：任意时刻至少一只脚着地（有双支撑）', () => {
  for (const p of PHASES) {
    const grounded = Number(footCycle(p).lift === 0) + Number(footCycle(p + 0.5).lift === 0)
    assert.ok(grounded >= 1, `phase ${p} 两脚同时离地`)
  }
})

test('侧向步态：足端始终够得着（腿骨不被拉伸），腿长恒定由 IK 保证', () => {
  for (const facing of ['right', 'left'] as const) {
    for (const amp of [0.3, 0.7, 1]) {
      for (const p of PHASES) {
        const pose = gaitPose(p, facing, amp)
        for (const side of ['l', 'r'] as const) {
          // 髋关节在站姿时正好是一整条腿长（腿长 = 1）高；足端目标相对站姿偏移
          const vertical = 1 + pose.hipsY - pose.legs[side].y
          const chord = Math.hypot(pose.legs[side].x, vertical)
          assert.ok(chord <= 1 + 1e-6, `${facing} amp ${amp} phase ${p} ${side} chord ${chord}`)
          assert.ok(pose.legs[side].y >= 0, '足端不应陷入地面')
        }
      }
    }
  }
})

test('正/背面步态：足端最多缩短到 minLegScale，腿保持笔直不外弯', () => {
  for (const facing of ['front', 'back'] as const) {
    for (const p of PHASES) {
      const pose = gaitPose(p, facing)
      for (const side of ['l', 'r'] as const) {
        const vertical = 1 + pose.hipsY - pose.legs[side].y
        const chord = Math.hypot(pose.legs[side].x, vertical)
        const scale = legFit(facing, chord, 1)
        assert.ok(scale >= GAIT.minLegScale && scale <= 1)
        // 缩放后腿长 ≥ 弦长，才能完全伸直（IK 不会弯膝）
        assert.ok(scale >= Math.min(1, chord) - 1e-9 || scale === GAIT.minLegScale)
      }
    }
  }
  assert.equal(legFit('right', 0.5, 1), 1, '侧向由 IK 弯膝，不缩放')
})

test('膝盖方向：侧向时左右腿都弯向行进方向（骨架左右腿镜像，bendDirection 相反）', () => {
  assert.equal(walkDir('right'), 1)
  assert.equal(walkDir('left'), -1)
  assert.equal(walkDir('front'), 0)
  assert.equal(kneeBend('right', 'l'), 1)
  assert.equal(kneeBend('right', 'r'), -1)
  assert.equal(kneeBend('left', 'l'), -1)
  assert.equal(kneeBend('left', 'r'), 1)
})

test('对侧手脚同步：左腿在前时右臂在前', () => {
  for (const facing of ['right', 'left'] as const) {
    const xs: number[][] = []
    for (const p of PHASES) {
      const pose = gaitPose(p, facing)
      xs.push([pose.legs.l.x * walkDir(facing), pose.arm.r])
    }
    const n = xs.length
    const mx = xs.reduce((a, b) => a + b[0], 0) / n
    const my = xs.reduce((a, b) => a + b[1], 0) / n
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (const [x, y] of xs) {
      sxy += (x - mx) * (y - my)
      sxx += (x - mx) ** 2
      syy += (y - my) ** 2
    }
    assert.ok(sxy / Math.sqrt(sxx * syy) > 0.8, `${facing} 手脚相关性过低`)
  }
})

test('幅度为 0 时回到站姿，所有朝向一致', () => {
  for (const facing of FACINGS) {
    const pose = gaitPose(0.37, facing, 0)
    assert.equal(Math.abs(pose.hipsY), 0)
    assert.equal(Math.abs(pose.legs.l.x) + Math.abs(pose.legs.l.y) + Math.abs(pose.legs.r.x) + Math.abs(pose.legs.r.y), 0)
    assert.equal(Math.abs(pose.arm.l) + Math.abs(pose.arm.r), 0)
  }
})

test('步态幅度与步频：低速收起、速度越快步子越大、步频有上下限', () => {
  assert.equal(gaitAmplitude(0), 0)
  assert.equal(gaitGate(GAIT.gateFrom), 0)
  assert.equal(gaitGate(GAIT.gateTo), 1)
  assert.ok(gaitAmplitude(30) > gaitAmplitude(10))
  const leg = 24.2 // 实际渲染下的腿长（px）
  let last = 0
  for (const speed of [10, 27, 45, 60, 85, 120]) {
    const amp = gaitAmplitude(speed)
    const cadence = gaitCadence(speed, amp, leg)
    assert.ok(cadence >= GAIT.minCadence && cadence <= GAIT.maxCadence)
    assert.ok(cadence >= last - 1e-9, '步频应随速度单调不减')
    last = cadence
  }
  // 常见步速下脚的打滑不超过 25%
  for (const speed of [27, 45, 60, 85]) {
    const amp = gaitAmplitude(speed)
    const cadence = gaitCadence(speed, amp, leg)
    const footSpeed = ((GAIT.stride * amp * leg) / GAIT.stance) * cadence
    assert.ok(footSpeed / speed >= 0.75, `speed ${speed} 打滑 ${(1 - footSpeed / speed) * 100}%`)
  }
})
