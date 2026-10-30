import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SCREEN_SCENE_FPS,
  drawScreenScene,
  type ScreenArea,
  type ScreenPen,
  type ScreenTone,
} from '../src/scene/office/officeMap/screenScenes.ts'

interface Rect {
  x: number
  y: number
  width: number
  height: number
  color: number
  alpha: number
}

/** 记录绘制调用的假画笔：rect 要等 fill 才算数，折线要等 stroke 才算数 */
function recorder() {
  const rects: Rect[] = []
  const points: Array<{ x: number; y: number }> = []
  let pending: Omit<Rect, 'color' | 'alpha'> | null = null
  const pen: ScreenPen = {
    rect(x, y, width, height) {
      pending = { x, y, width, height }
      return pen
    },
    fill({ color, alpha = 1 }) {
      assert.ok(pending, 'fill 之前必须先 rect')
      rects.push({ ...pending, color, alpha })
      pending = null
      return pen
    },
    moveTo(x, y) {
      points.push({ x, y })
      return pen
    },
    lineTo(x, y) {
      points.push({ x, y })
      return pen
    },
    stroke() {
      return pen
    },
  }
  return { pen, rects, points }
}

const AREA: ScreenArea = { x: 10, y: 20, width: 64, height: 38 }
const TONES: ScreenTone[] = ['idle', 'thinking', 'talking', 'error']
const COLORS: Record<ScreenTone, number> = { idle: 0x4ade80, thinking: 0x38bdf8, talking: 0xfbbf24, error: 0xf87171 }

function draw(tone: ScreenTone, t: number, extra: { progress?: number; textOverlay?: boolean } = {}) {
  const { pen, rects, points } = recorder()
  drawScreenScene(pen, AREA, { tone, color: COLORS[tone], t, ...extra })
  return { rects, points }
}

const EPS = 1e-9

test('每种状态、任意时刻：所有方块和折线点都落在屏幕矩形内', () => {
  for (const tone of TONES) {
    for (const overlay of [false, true]) {
      for (let step = 0; step < 240; step++) {
        const { rects, points } = draw(tone, step / SCREEN_SCENE_FPS, { textOverlay: overlay, progress: step % 3 === 0 ? 0.4 : undefined })
        for (const r of rects) {
          assert.ok(r.width > 0 && r.height > 0, `${tone}@${step} 不应画空方块`)
          assert.ok(r.x >= AREA.x - EPS && r.y >= AREA.y - EPS, `${tone}@${step} 左上越界`)
          assert.ok(r.x + r.width <= AREA.x + AREA.width + EPS, `${tone}@${step} 右侧越界`)
          assert.ok(r.y + r.height <= AREA.y + AREA.height + EPS, `${tone}@${step} 底部越界`)
          assert.ok(r.alpha > 0 && r.alpha <= 1, `${tone}@${step} alpha 非法：${r.alpha}`)
        }
        for (const p of points) {
          assert.ok(p.x >= AREA.x - EPS && p.x <= AREA.x + AREA.width + EPS, `${tone}@${step} 折线 x 越界`)
          assert.ok(p.y >= AREA.y - EPS && p.y <= AREA.y + AREA.height + EPS, `${tone}@${step} 折线 y 越界`)
        }
      }
    }
  }
})

test('同一时刻画出的画面是确定的', () => {
  for (const tone of TONES) {
    assert.deepEqual(draw(tone, 3.25), draw(tone, 3.25))
  }
})

test('四种状态的画面互不相同，且都会随时间变化', () => {
  const frames = TONES.map((tone) => JSON.stringify(draw(tone, 2.1).rects))
  assert.equal(new Set(frames).size, TONES.length)
  for (const tone of TONES) {
    const seen = new Set<string>()
    for (let step = 0; step < 48; step++) seen.add(JSON.stringify(draw(tone, step / SCREEN_SCENE_FPS).rects) + JSON.stringify(draw(tone, step / SCREEN_SCENE_FPS).points))
    assert.ok(seen.size >= 10, `${tone} 4 秒内只出现 ${seen.size} 种画面，动画太静`)
  }
})

test('思考场景：代码逐行敲出，写满后整体淡出重来', () => {
  const codeRects = (t: number) => draw('thinking', t).rects.filter((r) => r.color !== COLORS.thinking || r.height < 3)
  const early = codeRects(0.2).length
  const mid = codeRects(2.5).length
  const full = codeRects(5.8).length
  assert.ok(early < mid && mid < full, `代码块应逐步增多：${early} < ${mid} < ${full}`)
  const fading = draw('thinking', 6.9).rects.filter((r) => r.alpha < 1)
  assert.ok(fading.length > 0, '循环末尾应淡出')
})

test('思考场景：给了 progress 就画确定进度，没给就画流动进度', () => {
  const trackY = (rects: Rect[]) => rects.filter((r) => r.color === COLORS.thinking && r.y > AREA.y + AREA.height * 0.8)
  const fixed = trackY(draw('thinking', 1, { progress: 0.5 }).rects)
  const fixedLater = trackY(draw('thinking', 4, { progress: 0.5 }).rects)
  assert.equal(fixed.length, 1)
  assert.ok(Math.abs(fixed[0].width - AREA.width * 0.88 * 0.5) < EPS)
  assert.deepEqual(fixed, fixedLater, '确定进度不随时间变')
  const a = trackY(draw('thinking', 0.2).rects)[0]
  const b = trackY(draw('thinking', 1.0).rects)[0]
  assert.ok(a && b && Math.abs(a.x - b.x) > 1, '流动进度条应当位移')
})

test('离线场景：噪点逐帧变化，且不画确定进度之外的假任务内容', () => {
  const f0 = draw('error', 0)
  const f1 = draw('error', 1 / SCREEN_SCENE_FPS)
  assert.notDeepEqual(f0.rects, f1.rects)
  assert.equal(draw('error', 0, { textOverlay: true }).points.length, 0, '叠文字时不画 ×')
})

test('叠加文字时让出主体：矩形数明显少于纯动画', () => {
  for (const tone of ['thinking', 'talking', 'idle'] as const) {
    const plain = draw(tone, 5.8).rects.length
    const overlay = draw(tone, 5.8, { textOverlay: true }).rects.length
    assert.ok(overlay < plain, `${tone}: ${overlay} 应少于 ${plain}`)
  }
})
