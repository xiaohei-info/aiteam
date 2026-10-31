/**
 * 电脑屏幕动画（纯绘制函数，不依赖 Pixi，便于单测与无头校验）。
 *
 * 屏幕按工作状态演不同的小剧场，全部用小方块 / 折线拼出来，和俯视软风格的办公室保持同一语言：
 *   thinking —— 任务执行：窗口标题栏 + 逐行敲出的代码 + 光标 + 进度条
 *   talking  —— 对话：气泡依次弹出，随后是「正在输入」三点
 *   idle     —— 待命：心跳线匀速扫过 + 在线指示灯
 *   error    —— 离线：暗屏 + 雪花噪点 + 滚动扫描带 + 闪烁的 ×
 *
 * `t` 是带座位相位的秒数；同一个 t 画出的画面是确定的。所有图形都夹在 area 内，不会画出屏幕。
 */

/** Pixi Graphics 的最小子集：用结构类型而不是直接 import，保持本文件可在 node 下单测 */
export interface ScreenPen {
  rect(x: number, y: number, width: number, height: number): ScreenPen
  fill(style: { color: number; alpha?: number }): ScreenPen
  moveTo(x: number, y: number): ScreenPen
  lineTo(x: number, y: number): ScreenPen
  stroke(style: { width: number; color: number; alpha?: number }): ScreenPen
}

export type ScreenTone = 'idle' | 'thinking' | 'talking' | 'error'

export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenSceneOptions {
  tone: ScreenTone
  /** 基调色（与状态对应：待命绿 / 思考蓝 / 对话黄 / 离线红） */
  color: number
  /** 场景时间（秒） */
  t: number
  /** 0–1，传了就画确定进度条；不传时「思考」场景画循环流动的进度条 */
  progress?: number
  /** 屏幕上叠了文字（标题 / 行）时只画框架，主体区域让给文字 */
  textOverlay?: boolean
}

const PANEL = 0x16202f
const PANEL_OFFLINE = 0x140d10
const BAR = 0x1e293b
const DIM = 0x334155
const SLATE = 0x475569
const MINT = 0x5eead4
const SOFT = 0x8fb3ad
const INK = 0x0f172a

/** 画面最低刷新所需的帧率：调用方按这个频率重画即可，更高没有意义 */
export const SCREEN_SCENE_FPS = 12

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const fract = (v: number): number => v - Math.floor(v)
/** 0→1→0 往复 */
const pingPong = (p: number): number => 1 - Math.abs(fract(p) * 2 - 1)
const easeOutBack = (p: number): number => {
  const x = p - 1
  return 1 + 2.70158 * x * x * x + 1.70158 * x * x
}
/** 确定性伪随机 [0, 1)：噪点用，同一 (a, b) 永远得到同一个值 */
const hash = (a: number, b: number): number => fract(Math.sin(a * 127.1 + b * 311.7) * 43758.5453)

/** 把矩形夹进 area 再画；空矩形直接跳过 */
function box(g: ScreenPen, a: ScreenArea, x: number, y: number, w: number, h: number, color: number, alpha = 1): void {
  const x0 = Math.max(a.x, x)
  const y0 = Math.max(a.y, y)
  const x1 = Math.min(a.x + a.width, x + w)
  const y1 = Math.min(a.y + a.height, y + h)
  if (x1 - x0 <= 0 || y1 - y0 <= 0 || alpha <= 0) return
  g.rect(x0, y0, x1 - x0, y1 - y0).fill({ color, alpha })
}

/** 一个循环快结束时整体淡出，下一轮从空白重新开始 */
function cycleFade(c: number, fadeStart: number, cycle: number): number {
  return c <= fadeStart ? 1 : clamp01(1 - (c - fadeStart) / (cycle - fadeStart))
}

export function drawScreenScene(g: ScreenPen, area: ScreenArea, opts: ScreenSceneOptions): void {
  switch (opts.tone) {
    case 'thinking':
      drawWorking(g, area, opts)
      break
    case 'talking':
      drawChat(g, area, opts)
      break
    case 'error':
      drawOffline(g, area, opts)
      break
    default:
      drawStandby(g, area, opts)
  }
}

// ---------------------------------------------------------------- 任务执行：敲代码

type TokenColor = 'accent' | 'mint' | 'soft'
const CODE_LINES: ReadonlyArray<{ indent: number; tokens: ReadonlyArray<readonly [number, TokenColor]> }> = [
  { indent: 0, tokens: [[0.14, 'accent'], [0.2, 'mint'], [0.1, 'soft']] },
  { indent: 0.08, tokens: [[0.18, 'mint'], [0.12, 'soft'], [0.24, 'mint']] },
  { indent: 0.08, tokens: [[0.1, 'accent'], [0.3, 'soft']] },
  { indent: 0, tokens: [[0.22, 'mint'], [0.1, 'accent'], [0.16, 'soft'], [0.14, 'mint']] },
]
const TOKEN_GAP = 0.03
const CODE_CYCLE = 7.2
const CODE_START = 0.35
const CODE_PER_LINE = 1.25
const CODE_TYPE = 1.0
const CODE_FADE = 6.6

function drawWorking(g: ScreenPen, a: ScreenArea, o: ScreenSceneOptions): void {
  const { color, t } = o
  box(g, a, a.x, a.y, a.width, a.height, PANEL)

  // 标题栏：三个窗口点 + 右侧四格转圈
  const barH = a.height * 0.17
  box(g, a, a.x, a.y, a.width, barH, BAR)
  const dot = barH * 0.38
  for (let i = 0; i < 3; i++) {
    box(g, a, a.x + a.width * 0.05 + i * dot * 1.9, a.y + (barH - dot) / 2, dot, dot, i === 0 ? color : SLATE)
  }
  const cell = barH * 0.26
  const spinX = a.x + a.width * 0.93 - cell * 2.4
  const spinY = a.y + (barH - cell * 2.4) / 2
  const lit = Math.floor(t * 8) % 4
  ;[[0, 0], [1, 0], [1, 1], [0, 1]].forEach(([cx, cy], i) => {
    box(g, a, spinX + cx * cell * 1.4, spinY + cy * cell * 1.4, cell, cell, i === lit ? color : SLATE)
  })

  // 底部进度条：给了 progress 就画确定值，否则一段亮条来回流动
  const left = a.x + a.width * 0.06
  const span = a.width * 0.88
  const progH = a.height * 0.07
  const progY = a.y + a.height - progH - a.height * 0.06
  box(g, a, left, progY, span, progH, BAR)
  if (typeof o.progress === 'number') {
    box(g, a, left, progY, span * clamp01(o.progress), progH, color)
  } else {
    const seg = span * 0.3
    box(g, a, left + (span - seg) * pingPong(t / 1.8), progY, seg, progH, color)
  }
  if (o.textOverlay) return

  // 代码行：逐行敲出，写满后停一会儿再淡出重来
  const c = t % CODE_CYCLE
  const fade = cycleFade(c, CODE_FADE, CODE_CYCLE)
  const bodyTop = a.y + barH + a.height * 0.1
  const bodyBottom = progY - a.height * 0.08
  const pitch = (bodyBottom - bodyTop) / CODE_LINES.length
  const lineH = pitch * 0.45
  const colors: Record<TokenColor, number> = { accent: color, mint: MINT, soft: SOFT }
  let caret: { x: number; y: number } | null = null
  let typing = false

  CODE_LINES.forEach((line, index) => {
    const progress = clamp01((c - CODE_START - index * CODE_PER_LINE) / CODE_TYPE)
    if (progress <= 0) return
    const total = line.tokens.reduce((sum, [w]) => sum + w, 0) + TOKEN_GAP * (line.tokens.length - 1)
    const typed = progress * total
    const y = bodyTop + index * pitch + (pitch - lineH) / 2
    let cursor = line.indent
    let drawn = 0
    for (const [width, key] of line.tokens) {
      const visible = Math.min(width, typed - drawn)
      if (visible <= 0) break
      box(g, a, left + cursor * span, y, visible * span, lineH, colors[key], fade)
      cursor += width + TOKEN_GAP
      drawn += width + TOKEN_GAP
    }
    caret = { x: left + (line.indent + Math.min(typed, total)) * span, y }
    if (progress < 1) typing = true
  })

  // 光标：敲字时常亮，停下来后闪烁
  if (caret && fade > 0.5 && (typing || fract(t * 2.2) < 0.55)) {
    const { x, y } = caret as { x: number; y: number }
    box(g, a, x + 0.8, y - lineH * 0.25, Math.max(1, a.width * 0.02), lineH * 1.5, 0xdff7f0)
  }
}

// ---------------------------------------------------------------- 对话：气泡依次弹出

const CHAT_CYCLE = 7.4
const CHAT_FADE = 6.8
const CHAT_BUBBLES: ReadonlyArray<{ slot: number; right: boolean; width: number; appear: number; lines: number[] }> = [
  { slot: 0, right: false, width: 0.52, appear: 0.3, lines: [0.8, 0.5] },
  { slot: 1, right: true, width: 0.58, appear: 1.9, lines: [0.85, 0.6] },
  { slot: 2, right: false, width: 0.44, appear: 5.0, lines: [0.7] },
]
const TYPING_FROM = 3.3
const TYPING_UNTIL = 5.0

function drawChat(g: ScreenPen, a: ScreenArea, o: ScreenSceneOptions): void {
  const { color, t } = o
  box(g, a, a.x, a.y, a.width, a.height, PANEL)

  // 标题栏：头像方块 + 名字条 + 在线灯
  const barH = a.height * 0.17
  box(g, a, a.x, a.y, a.width, barH, BAR)
  const avatar = barH * 0.56
  box(g, a, a.x + a.width * 0.05, a.y + (barH - avatar) / 2, avatar, avatar, color)
  box(g, a, a.x + a.width * 0.05 + avatar * 1.5, a.y + barH * 0.3, a.width * 0.26, barH * 0.16, SOFT)
  box(g, a, a.x + a.width * 0.05 + avatar * 1.5, a.y + barH * 0.56, a.width * 0.16, barH * 0.12, SLATE)
  const lamp = barH * 0.3
  box(g, a, a.x + a.width * 0.92 - lamp, a.y + (barH - lamp) / 2, lamp, lamp, MINT, 0.55 + 0.45 * pingPong(t / 1.6))
  if (typeof o.progress === 'number') {
    const left = a.x + a.width * 0.06
    const span = a.width * 0.88
    const progH = a.height * 0.05
    const progY = a.y + a.height - progH - a.height * 0.04
    box(g, a, left, progY, span, progH, BAR)
    box(g, a, left, progY, span * clamp01(o.progress), progH, color)
  }
  if (o.textOverlay) return

  const c = t % CHAT_CYCLE
  const fade = cycleFade(c, CHAT_FADE, CHAT_CYCLE)
  const left = a.x + a.width * 0.06
  const span = a.width * 0.88
  const bodyTop = a.y + barH + a.height * 0.06
  const bodyBottom = a.y + a.height - a.height * 0.06
  const pitch = (bodyBottom - bodyTop) / 3
  const bubbleH = pitch * 0.82

  for (const bubble of CHAT_BUBBLES) {
    const pop = clamp01((c - bubble.appear) / 0.28)
    if (pop <= 0) continue
    const scale = easeOutBack(pop)
    const w = span * bubble.width
    const h = bubbleH * scale
    const x = bubble.right ? left + span - w : left
    const y = bodyTop + bubble.slot * pitch + (pitch - h) / 2
    const filled = bubble.right
    box(g, a, x, y, w, h, filled ? color : DIM, fade)
    bubble.lines.forEach((ratio, i) => {
      const lineH = Math.max(0.8, bubbleH * 0.14)
      const rows = bubble.lines.length
      const ly = y + h / 2 + (i - (rows - 1) / 2) * bubbleH * 0.3 - lineH / 2
      box(g, a, x + w * 0.1, ly, w * 0.8 * ratio * Math.min(1, scale), lineH, filled ? INK : 0xcbd5e1, fade * (filled ? 0.55 : 0.7))
    })
  }

  // 「正在输入」三点：第三条消息出现前在对应位置弹跳
  if (c >= TYPING_FROM && c < TYPING_UNTIL) {
    const w = span * 0.3
    const y = bodyTop + 2 * pitch + (pitch - bubbleH) / 2
    box(g, a, left, y, w, bubbleH, DIM)
    const size = Math.max(1, bubbleH * 0.18)
    for (let k = 0; k < 3; k++) {
      const hop = Math.max(0, Math.sin(t * 7 - k * 0.9)) * size * 0.9
      box(g, a, left + w * 0.24 + k * size * 1.7, y + bubbleH / 2 - size / 2 - hop, size, size, SOFT)
    }
  }
}

// ---------------------------------------------------------------- 待命：心跳线

/** 一次心跳的波形，p∈[0,1)，返回 -0.5…1 */
function heartbeat(p: number): number {
  if (p < 0.3) return 0
  if (p < 0.36) return 0.15 * Math.sin(((p - 0.3) / 0.06) * Math.PI)
  if (p < 0.5) return 0
  if (p < 0.54) return -0.25 * ((p - 0.5) / 0.04)
  if (p < 0.6) return -0.25 + 1.25 * ((p - 0.54) / 0.06)
  if (p < 0.66) return 1 - 1.5 * ((p - 0.6) / 0.06)
  if (p < 0.7) return -0.5 + 0.5 * ((p - 0.66) / 0.04)
  if (p < 0.8) return 0
  if (p < 0.9) return 0.2 * Math.sin(((p - 0.8) / 0.1) * Math.PI)
  return 0
}

const HEARTBEAT_SAMPLES = 40

function drawStandby(g: ScreenPen, a: ScreenArea, o: ScreenSceneOptions): void {
  const { color, t } = o
  box(g, a, a.x, a.y, a.width, a.height, PANEL)

  // 标题栏：呼吸的在线灯 + 两条状态条
  const barH = a.height * 0.17
  box(g, a, a.x, a.y, a.width, barH, BAR)
  const lamp = barH * 0.4
  box(g, a, a.x + a.width * 0.05, a.y + (barH - lamp) / 2, lamp, lamp, color, 0.45 + 0.55 * pingPong(t / 2.4))
  box(g, a, a.x + a.width * 0.05 + lamp * 2, a.y + barH * 0.3, a.width * 0.3, barH * 0.16, SOFT)
  box(g, a, a.x + a.width * 0.05 + lamp * 2, a.y + barH * 0.56, a.width * 0.2, barH * 0.12, SLATE)

  const left = a.x + a.width * 0.06
  const span = a.width * 0.88
  if (typeof o.progress === 'number') {
    const progH = a.height * 0.06
    const progY = a.y + a.height - progH - a.height * 0.05
    box(g, a, left, progY, span, progH, BAR)
    box(g, a, left, progY, span * clamp01(o.progress), progH, color)
  }
  if (o.textOverlay) return

  const top = a.y + barH + a.height * 0.12
  const bottom = a.y + a.height - a.height * 0.12
  const mid = (top + bottom) / 2
  const amp = (bottom - top) * 0.46
  // 网格：中线 + 上下两条浅线
  box(g, a, left, mid, span, Math.max(0.5, a.height * 0.015), DIM, 0.9)
  box(g, a, left, top, span, Math.max(0.5, a.height * 0.01), DIM, 0.45)
  box(g, a, left, bottom, span, Math.max(0.5, a.height * 0.01), DIM, 0.45)

  // 心跳线：整条向左匀速滚动
  const width = Math.max(0.9, a.height * 0.05)
  let lastY = mid
  for (let i = 0; i <= HEARTBEAT_SAMPLES; i++) {
    const u = i / HEARTBEAT_SAMPLES
    const y = mid - heartbeat(fract(u * 0.9 + t * 0.32)) * amp
    if (i === 0) g.moveTo(left, y)
    else g.lineTo(left + u * span, y)
    lastY = y
  }
  g.stroke({ width, color, alpha: 0.95 })
  // 线头的光点
  const head = Math.max(1.4, a.height * 0.075)
  box(g, a, left + span - head / 2, lastY - head / 2, head, head, 0xdff7f0, 0.55 + 0.45 * pingPong(t / 0.7))
}

// ---------------------------------------------------------------- 离线：无信号

function drawOffline(g: ScreenPen, a: ScreenArea, o: ScreenSceneOptions): void {
  const { color, t } = o
  box(g, a, a.x, a.y, a.width, a.height, PANEL_OFFLINE)
  if (o.textOverlay) {
    box(g, a, a.x, a.y, a.width, a.height * 0.17, BAR, 0.6)
    return
  }

  // 缓慢下移的扫描带
  const bandH = a.height * 0.24
  const bandY = a.y - bandH + fract(t * 0.3) * (a.height + bandH)
  box(g, a, a.x, bandY, a.width, bandH, color, 0.1)

  // 雪花噪点：每个画面帧一组
  const frame = Math.floor(t * SCREEN_SCENE_FPS)
  const speck = Math.max(0.9, a.height * 0.035)
  for (let k = 0; k < 16; k++) {
    const x = a.x + hash(frame, k) * (a.width - speck)
    const y = a.y + hash(k, frame + 17) * (a.height - speck)
    box(g, a, x, y, speck, speck, 0x94a3b8, 0.14 + hash(frame + 3, k) * 0.2)
  }
  // 偶发的撕裂线
  if (hash(Math.floor(t * 3), 1) > 0.8) {
    box(g, a, a.x, a.y + hash(frame, 9) * a.height, a.width, Math.max(0.6, a.height * 0.02), 0xe2e8f0, 0.22)
  }

  // 居中的 ×：每秒亮 0.6 秒
  const cx = a.x + a.width / 2
  const cy = a.y + a.height * 0.46
  const half = Math.min(a.width, a.height) * 0.14
  if (fract(t * 0.9) < 0.62) {
    g.moveTo(cx - half, cy - half).lineTo(cx + half, cy + half)
    g.moveTo(cx + half, cy - half).lineTo(cx - half, cy + half)
    g.stroke({ width: Math.max(1, a.height * 0.06), color, alpha: 0.95 })
  }
  box(g, a, cx - a.width * 0.2, a.y + a.height * 0.74, a.width * 0.4, Math.max(0.8, a.height * 0.05), SLATE, 0.6)
}
