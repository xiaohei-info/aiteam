import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { blockers, clearSegment, findPath, isBlocked, segmentDistance } from '../src/scene/office/officeMap/geometry.ts'
import { CROWD, computeAvoidance, findFreePoint, hasRightOfWay, isPointFree, type CrowdNeighbor, type CrowdSelf } from '../src/scene/office/officeMap/crowd.ts'
import { REROUTE_CLEARANCE, createWalkState, pathNearPeople, planWalkSamples, stepWalk, walkRank, type WalkState } from '../src/scene/office/officeMap/walker.ts'
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

const map = readMap()
const polygons = blockers(map, 'employee')
const isClear = (a: MapPoint, b: MapPoint) => clearSegment(map, a, b, 12, 'employee', polygons)
const isBlockedAt = (p: MapPoint) => isBlocked(map, p, 9, 'employee', polygons)

const me = (over: Partial<CrowdSelf> = {}): CrowdSelf => ({ id: 'me', x: 0, y: 0, tx: 1, ty: 0, lateral: 0, speed: 60, ...over })
const other = (over: Partial<CrowdNeighbor> = {}): CrowdNeighbor => ({ id: 'o', x: 40, y: 0, vx: 0, vy: 0, ...over })
const open = () => false

test('避让：路径前方站着一个人，向右手边绕开且不必减速', () => {
  const result = computeAvoidance(me(), [other()], open)
  // 向 +x 走时右手边是 +y（屏幕下方）
  assert.ok(result.lateralTarget >= CROWD.clearance, `让位量 ${result.lateralTarget}`)
  assert.equal(result.blocked, false)
  assert.equal(result.speedLimit, Infinity)
})

test('避让：迎面相遇双方各靠自己的右手边，世界坐标里正好错开', () => {
  const a = computeAvoidance(me({ id: 'a' }), [other({ id: 'b', x: 60, vx: -60 })], open)
  const b = computeAvoidance(me({ id: 'b', x: 60, tx: -1 }), [other({ id: 'a', x: 0, vx: 60 })], open)
  // A 向 +x，右手边 = +y；B 向 -x，右手边 = -y
  const worldA = a.lateralTarget
  const worldB = -b.lateralTarget
  assert.ok(worldA > 0 && worldB < 0, `A 偏 ${worldA}，B 偏 ${worldB}`)
})

test('避让：同向且不比我慢的人在前面带路，不用绕', () => {
  const result = computeAvoidance(me(), [other({ vx: 60 })], open)
  assert.equal(result.lateralTarget, 0)
  assert.equal(result.speedLimit, Infinity)
})

test('避让：已经走到身后的人不算威胁', () => {
  const result = computeAvoidance(me(), [other({ x: -30 })], open)
  assert.equal(result.lateralTarget, 0)
})

test('避让：两侧都是墙时停下来等，离得越近限速越低，贴脸时降到 0', () => {
  const walls = (p: MapPoint) => Math.abs(p.y) > 1
  const far = computeAvoidance(me(), [other({ x: 50 })], walls)
  const near = computeAvoidance(me(), [other({ x: 30 })], walls)
  const touching = computeAvoidance(me(), [other({ x: 20 })], walls)
  assert.equal(far.blocked, true)
  assert.ok(far.speedLimit > near.speedLimit && near.speedLimit > 0)
  assert.equal(touching.speedLimit, 0)
})

test('通行先后：号小的先走；号相同按 id 定，双方各自算出的结论互补', () => {
  assert.equal(hasRightOfWay(1, 'b', 2, 'a'), true)
  assert.equal(hasRightOfWay(2, 'a', 1, 'b'), false)
  assert.equal(hasRightOfWay(3, 'a', 3, 'b'), true)
  assert.equal(hasRightOfWay(3, 'b', 3, 'a'), false)
})

test('礼让：窄道里迎面相遇，后出发的让（停下等），先出发的不算礼让', () => {
  const walls = (p: MapPoint) => Math.abs(p.y) > 1
  const first = computeAvoidance(me({ id: 'a', rank: 1 }), [other({ id: 'b', x: 50, vx: -60, rank: 2 })], walls)
  const second = computeAvoidance(me({ id: 'b', rank: 2 }), [other({ id: 'a', x: 50, vx: -60, rank: 1 })], walls)
  assert.equal(second.yielding, true)
  assert.equal(second.blocked, true)
  assert.equal(first.yielding, false)
  // 让的一方先刹住，先走的一方还能再靠近一点
  assert.ok(first.speedLimit > second.speedLimit, `先走 ${first.speedLimit}，让 ${second.speedLimit}`)
})

test('礼让：开阔处即使有先后也不必停，各靠右手边错开，没人让', () => {
  const result = computeAvoidance(me({ rank: 2 }), [other({ x: 60, vx: -60, rank: 1 })], open)
  assert.equal(result.blocked, false)
  assert.equal(result.yielding, false)
  assert.ok(result.lateralTarget > 0)
})

test('礼让：挡路的是站着的人（没有号）时只能等，不算礼让', () => {
  const walls = (p: MapPoint) => Math.abs(p.y) > 1
  const result = computeAvoidance(me({ rank: 1 }), [other({ x: 40 })], walls)
  assert.equal(result.blocked, true)
  assert.equal(result.yielding, false)
})

test('排号：起身 / 转身的停顿里不排号，迈步后才带号参与礼让', () => {
  const walk = createWalkState({ samples: [{ x: 0, y: 0 }, { x: 100, y: 0 }], cruise: 60, delay: 0.5, rank: 7 })
  assert.equal(walkRank(walk), undefined)
  walk.delay = 0
  assert.equal(walkRank(walk), 7)
})

test('站位：理想点没人就用它，被占了就挪到不挡路且不进障碍的空位', () => {
  assert.deepEqual(findFreePoint({ x: 100, y: 100 }, [], open), { x: 100, y: 100 })
  const taken = [{ x: 100, y: 100 }]
  const spot = findFreePoint({ x: 100, y: 100 }, taken, open, 28)
  assert.ok(spot && isPointFree(spot, taken, 28))
  assert.equal(findFreePoint({ x: 100, y: 100 }, taken, () => true), null, '四周全是障碍时找不到')
})

interface Route {
  from: MapPoint
  to: MapPoint
  delay?: number
}

interface SimResult {
  allArrived: boolean
  seconds: number
  minDistance: number
  inObstacleFrames: number
  /** 被逼到「挤一挤」（间距收窄）/「穿过」（放弃避让）档的帧数合计：越少说明礼让越顺畅 */
  tightFrames: number
  ghostFrames: number
  /** 礼让（对方先走，自己让到路边等）的帧数合计 */
  yieldFrames: number
}

/**
 * 与场景同样的每帧流程：先拍快照，再让每个人按快照里别人的位置避让。
 * ranked：按出发顺序排号（场景里每次出发领一个号）；关掉就是没有先来后到、只会双方一起刹停的旧行为。
 */
function simulate(routes: Route[], maxSeconds = 120, ranked = true): SimResult {
  const dt = 1 / 60
  const agents = routes.map((route, index) => {
    const found = findPath(map, route.from, route.to, 12)
    if (!found) throw new Error(`第 ${index} 条路线没有通路`)
    const samples = planWalkSamples(found, isClear)
    return {
      id: `a${index}`,
      pos: { ...route.from },
      vel: { x: 0, y: 0 },
      walk: createWalkState({ samples, cruise: 60, delay: route.delay ?? 0, rank: ranked ? index + 1 : undefined }) as WalkState | null,
    }
  })
  let t = 0
  let minDistance = Infinity
  let inObstacleFrames = 0
  let tightFrames = 0
  let ghostFrames = 0
  let yieldFrames = 0
  while (t < maxSeconds && agents.some((agent) => agent.walk)) {
    const snapshot: CrowdNeighbor[] = agents.map((a) => ({ id: a.id, x: a.pos.x, y: a.pos.y, vx: a.vel.x, vy: a.vel.y, rank: a.walk ? walkRank(a.walk) : undefined }))
    for (const agent of agents) {
      if (!agent.walk) continue
      const step = stepWalk(agent.walk, dt, { selfId: agent.id, neighbors: snapshot.filter((n) => n.id !== agent.id), isBlockedAt })
      if (step.yielding) yieldFrames++
      if (agent.walk.relax === 1) tightFrames++
      if (agent.walk.relax === 2) ghostFrames++
      agent.vel = { x: (step.x - agent.pos.x) / dt, y: (step.y - agent.pos.y) / dt }
      agent.pos = { x: step.x, y: step.y }
      if (step.arrived) {
        agent.walk = null
        agent.vel = { x: 0, y: 0 }
      }
      if (agent.walk && isBlockedAt(agent.pos)) inObstacleFrames++
    }
    t += dt
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        minDistance = Math.min(minDistance, Math.hypot(agents[i].pos.x - agents[j].pos.x, agents[i].pos.y - agents[j].pos.y))
      }
    }
  }
  return { allArrived: agents.every((agent) => !agent.walk), seconds: t, minDistance, inObstacleFrames, tightFrames, ghostFrames, yieldFrames }
}

const lane = (x0: number, y0: number, x1: number, y1: number, delay = 0): Route => ({ from: { x: x0, y: y0 }, to: { x: x1, y: y1 }, delay })

test('仿真：过道里两人迎面走，擦肩而过不重叠，都能走到', () => {
  const result = simulate([lane(120, 436, 820, 436), lane(820, 436, 120, 436)])
  assert.ok(result.allArrived)
  assert.ok(result.minDistance >= 20, `最小间距 ${result.minDistance}`)
  assert.equal(result.inObstacleFrames, 0)
})

test('仿真：过道里 3 对 3 挤在同一条线上，不死锁、不叠人', () => {
  const result = simulate([
    lane(120, 450, 820, 450), lane(160, 450, 860, 450), lane(200, 450, 900, 450),
    lane(820, 450, 120, 450), lane(860, 450, 160, 450), lane(900, 450, 200, 450),
  ])
  assert.ok(result.allArrived)
  assert.ok(result.minDistance >= 14, `最小间距 ${result.minDistance}`)
  assert.equal(result.inObstacleFrames, 0)
})

test('仿真：十字交叉的两对人互不穿过', () => {
  const result = simulate([lane(200, 436, 800, 520), lane(800, 436, 200, 520), lane(500, 424, 500, 556), lane(500, 556, 500, 424)])
  assert.ok(result.allArrived)
  assert.ok(result.minDistance >= 18, `最小间距 ${result.minDistance}`)
  assert.equal(result.inObstacleFrames, 0)
})

test('仿真：10 个人同时两两互换工位（极端拥挤）也能全部走到，且不走进障碍', () => {
  const seats = (map.seats ?? []).map((seat) => seat.approachPoint as MapPoint)
  assert.equal(seats.length, 10)
  const result = simulate(seats.map((from, index) => ({ from, to: seats[9 - index] })), 180)
  assert.ok(result.allArrived, `${result.seconds.toFixed(1)}s 内没走完`)
  assert.equal(result.inObstacleFrames, 0)
  // 窄过道里实在让不开时允许「挤一挤」，但不能整个人叠在一起
  assert.ok(result.minDistance >= 8, `最小间距 ${result.minDistance}`)
})

test('仿真：10 人互换工位，按先来后到礼让后不再被逼到「挤一挤」，且仍然全部走到', () => {
  const seats = (map.seats ?? []).map((seat) => seat.approachPoint as MapPoint)
  const routes = seats.map((from, index) => ({ from, to: seats[9 - index] }))
  const unranked = simulate(routes, 180, false)
  const ranked = simulate(routes, 180, true)
  assert.ok(ranked.allArrived, `${ranked.seconds.toFixed(1)}s 内没走完`)
  assert.equal(ranked.inObstacleFrames, 0)
  assert.ok(ranked.yieldFrames > 0, '拥挤时应当出现礼让')
  assert.ok(ranked.tightFrames < unranked.tightFrames, `挤一挤 ${ranked.tightFrames} 帧，无先后时 ${unranked.tightFrames} 帧`)
  assert.ok(ranked.minDistance >= 13, `最小间距 ${ranked.minDistance}`)
})

test('重新规划：前方路线擦过静止的人才触发；够远、在身后或在终点附近的人不算', () => {
  const samples = planWalkSamples([{ x: 120, y: 436 }, { x: 820, y: 436 }], isClear)
  const walk = createWalkState({ samples, cruise: 60 })
  assert.equal(pathNearPeople(walk, [{ x: 200, y: 440 }], 18), true)
  assert.equal(pathNearPeople(walk, [{ x: 200, y: 470 }], 18), false, '离路线 34px 不算')
  assert.equal(pathNearPeople(walk, [{ x: 600, y: 436 }], 18), false, '超出前瞻距离不算')
  assert.equal(pathNearPeople(walk, [{ x: 818, y: 440 }], 18), false, '终点附近的人重新规划也绕不开')
  walk.distance = 300
  assert.equal(pathNearPeople(walk, [{ x: 200, y: 440 }], 18), false, '已经走过的不算')
})

test('重新规划：绕开人的路线（含 8px 回退半径）不会再被判定为擦过，否则会反复改道', () => {
  const from = { x: 120, y: 436 }
  const to = { x: 820, y: 436 }
  const person = { x: 470, y: 436 }
  const block: MapPoint[] = [
    { x: person.x - 8, y: person.y - 8 }, { x: person.x + 8, y: person.y - 8 },
    { x: person.x + 8, y: person.y + 8 }, { x: person.x - 8, y: person.y + 8 },
  ]
  for (const radius of [12, 8]) {
    const around = findPath(map, from, to, radius, 'employee', [block])
    if (!around) throw new Error(`半径 ${radius}：过道够宽，应当能绕过去`)
    const clear = (a: MapPoint, b: MapPoint) => clearSegment(map, a, b, radius, 'employee', [...polygons, block])
    const walk = createWalkState({ samples: planWalkSamples(around, clear), cruise: 60 })
    assert.equal(pathNearPeople(walk, [person], REROUTE_CLEARANCE, walk.total), false, `半径 ${radius} 的绕行路线又被判定擦过人`)
  }
  // 而直接穿过去的原路线必须被判定为擦过
  const straight = createWalkState({ samples: planWalkSamples([from, to], isClear), cruise: 60 })
  assert.equal(pathNearPeople(straight, [person], REROUTE_CLEARANCE, straight.total), true)
})

test('改道沿用被挡住的进度：blockedFor / relax / relaxFor 不被清零，放宽避让的兜底才不失效', () => {
  const samples = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
  const fresh = createWalkState({ samples, cruise: 60 })
  assert.deepEqual([fresh.blockedFor, fresh.relax, fresh.relaxFor], [0, 0, 0])
  const rerouted = createWalkState({ samples, cruise: 60, inherit: { blockedFor: 1.8, relax: 1, relaxFor: 0.9 } })
  assert.deepEqual([rerouted.blockedFor, rerouted.relax, rerouted.relaxFor], [1.8, 1, 0.9])
})

/** 折线到某点的最近距离 */
function polylineDistance(points: MapPoint[], p: MapPoint): number {
  let best = Infinity
  for (let i = 1; i < points.length; i++) best = Math.min(best, segmentDistance(p, points[i - 1], points[i]))
  return best
}

test('寻路：把静止的人当临时障碍，路线绕开他们；起点贴着人时找不到绕行路线而不是穿过去', () => {
  const from = { x: 120, y: 436 }
  const to = { x: 820, y: 436 }
  const person = { x: 470, y: 436 }
  const square = (c: MapPoint, h = 8): MapPoint[] => [
    { x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }, { x: c.x - h, y: c.y + h },
  ]
  const plain = findPath(map, from, to, 12)
  if (!plain) throw new Error('过道里起终点之间应当有通路')
  assert.ok(polylineDistance(plain, person) < 1, '没有临时障碍时路线直接穿过这个人')

  const around = findPath(map, from, to, 12, 'employee', [square(person)])
  if (!around) throw new Error('过道够宽，应当能绕过去')
  assert.ok(polylineDistance(around, person) >= 18, `绕行路线离人只有 ${polylineDistance(around, person)}px`)

  const crowded = findPath(map, from, to, 12, 'employee', [square(from)])
  assert.equal(crowded, null, '起点就在别人身上：返回 null，由调用方退回普通路线')
})
