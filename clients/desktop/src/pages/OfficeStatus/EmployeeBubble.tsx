/**
 * 办公室里点击员工后，在员工头部右侧弹出的半透明介绍气泡：员工名、介绍和「对话」按钮。
 *
 * 气泡是 OfficeCanvas 宿主元素里的绝对定位层，位置由场景给的员工包围盒推出；
 * 默认在员工右侧（尖角朝左）；右侧放不下时翻到员工左侧（尖角朝右），再放不下才夹在宿主范围内。
 *
 * 气泡与尖角是同一个形状：量出内容高度后拼出一条闭合路径（圆角矩形 + 尖角），
 * 用 clip-path 裁出轮廓，背景、模糊与描边都按这一条路径，所以没有接缝。
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { EmployeeAnchor } from '../../scene/office/officeMap/MapOfficeScene'

export interface EmployeeBubbleInfo {
  id: number | string
  name: string
  /** 岗位 / 部门等副标题 */
  subtitle?: string
  /** 员工介绍；没有时显示占位文案 */
  intro?: string
}

interface EmployeeBubbleProps {
  employee: EmployeeBubbleInfo
  anchor: EmployeeAnchor
  /** 宿主元素尺寸，用来夹取位置 */
  bounds: { width: number; height: number }
  onChat: () => void
}

const BUBBLE_WIDTH = 240
const BUBBLE_MAX_HEIGHT = 190
const RADIUS = 12
const TAIL_WIDTH = 8
/** 尖角底边的一半 */
const TAIL_HALF = 7
/** 气泡与员工之间的空隙（尖角占其中一部分） */
const GAP = 4
const MARGIN = 6
/** 尖角尖端离气泡顶部的距离，也是尖角对准的「头部」高度 */
const TAIL_OFFSET = 22
/** 头部大约在包围盒顶部往下这么多（上限） */
const HEAD_DEPTH = 34
/** 浅色玻璃上的文字色 */
const INK = '#141a26'
const INK_PRIMARY = 'rgba(20,26,38,0.92)'
const INK_SECONDARY = 'rgba(20,26,38,0.72)'
const INK_MUTED = 'rgba(20,26,38,0.55)'
/** 整个形状（含尖角）的宽度 */
const SHAPE_WIDTH = BUBBLE_WIDTH + TAIL_WIDTH

/**
 * 圆角矩形加一个侧面尖角的闭合路径，坐标系原点在形状左上角。
 * onRight = 气泡在员工右侧，尖角在左边朝左；否则尖角在右边朝右。ty = 尖角尖端的纵坐标。
 */
function bubblePath(height: number, onRight: boolean, ty: number): string {
  const x0 = onRight ? TAIL_WIDTH : 0
  const x1 = x0 + BUBBLE_WIDTH
  const r = RADIUS
  const arc = (x: number, y: number) => `A ${r} ${r} 0 0 1 ${x} ${y}`
  const tail = onRight
    ? `V ${ty + TAIL_HALF} L 0 ${ty} L ${x0} ${ty - TAIL_HALF}`
    : `V ${ty - TAIL_HALF} L ${SHAPE_WIDTH} ${ty} L ${x1} ${ty + TAIL_HALF}`
  // 顺时针：上边 → 右边 → 下边 → 左边；尖角在哪边，那条边就在中间插入尖角
  const rightEdge = onRight ? `V ${height - r}` : `${tail} V ${height - r}`
  const leftEdge = onRight ? `${tail} V ${r}` : `V ${r}`
  return [
    `M ${x0 + r} 0 H ${x1 - r} ${arc(x1, r)}`,
    rightEdge,
    `${arc(x1 - r, height)} H ${x0 + r} ${arc(x0, height - r)}`,
    leftEdge,
    `${arc(x0 + r, 0)} Z`,
  ].join(' ')
}

export function EmployeeBubble({ employee, anchor, bounds, onChat }: EmployeeBubbleProps) {
  const shapeRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  const edgeId = useId()

  // 内容高度随文字变化；在绘制前量好，路径才能贴合
  useLayoutEffect(() => {
    const el = shapeRef.current
    if (!el) return
    setHeight(el.offsetHeight)
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const right = anchor.x + anchor.width
  const onRight = right + GAP + SHAPE_WIDTH <= bounds.width - MARGIN
  const rawLeft = onRight ? right + GAP : anchor.x - GAP - SHAPE_WIDTH
  // 取整：避免形状边缘落在小数像素上发虚
  const left = Math.round(Math.max(MARGIN, Math.min(rawLeft, bounds.width - SHAPE_WIDTH - MARGIN)))

  const headY = anchor.y + Math.min(anchor.height * 0.2, HEAD_DEPTH)
  const top = Math.round(Math.min(
    Math.max(MARGIN, headY - TAIL_OFFSET),
    Math.max(MARGIN, bounds.height - BUBBLE_MAX_HEIGHT - MARGIN),
  ))
  const minTy = RADIUS + TAIL_HALF
  const ty = Math.round(Math.min(Math.max(minTy, headY - top), Math.max(minTy, height - minTy)))
  const path = height > 0 ? bubblePath(height, onRight, ty) : null

  return (
    <div
      ref={shapeRef}
      role="dialog"
      aria-label={`${employee.name} 的介绍`}
      data-testid="office-employee-bubble"
      data-office-bubble
      style={{
        ...shapeStyle,
        left,
        top,
        // 尖角那一侧多留出尖角的宽度，内容仍然落在圆角矩形里
        paddingLeft: 12 + (onRight ? TAIL_WIDTH : 0),
        paddingRight: 12 + (onRight ? 0 : TAIL_WIDTH),
        clipPath: path ? `path('${path}')` : undefined,
      }}
    >
      {path && (
        <svg width={SHAPE_WIDTH} height={height} style={outlineStyle} aria-hidden="true">
          <defs>
            <linearGradient id={edgeId} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.7" />
              <stop offset="0.35" stopColor="#fff" stopOpacity="0.14" />
              <stop offset="0.7" stopColor="#fff" stopOpacity="0.1" />
              <stop offset="1" stopColor="#fff" stopOpacity="0.4" />
            </linearGradient>
          </defs>
          {/* 内侧一圈柔光 + 一条渐变高光边：左上、右下亮，其余几乎透明 */}
          <path d={path} fill="none" stroke="#fff" strokeOpacity="0.1" strokeWidth={8} />
          <path d={path} fill="none" stroke={INK} strokeOpacity="0.14" strokeWidth={2} />
          <path d={path} fill="none" stroke={`url(#${edgeId})`} strokeWidth={2} />
        </svg>
      )}
      <div style={{ fontSize: 14, fontWeight: 600, color: INK_PRIMARY, wordBreak: 'break-all' }}>
        {employee.name}
      </div>
      {employee.subtitle && (
        <div style={{ fontSize: 11, color: INK_MUTED, marginTop: 2, wordBreak: 'break-all' }}>
          {employee.subtitle}
        </div>
      )}
      <div style={introStyle}>{employee.intro || '暂无介绍'}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" onClick={onChat} style={chatBtnStyle}>
          对话
        </button>
      </div>
    </div>
  )
}

const shapeStyle: CSSProperties = {
  position: 'absolute', zIndex: 5,
  width: SHAPE_WIDTH, maxHeight: BUBBLE_MAX_HEIGHT, boxSizing: 'border-box',
  paddingTop: 10, paddingBottom: 10,
  // 办公室地图是浅色的：用浅色玻璃 + 深色文字（跟随深色主题变量会在浅底上看不清）
  // 类 iOS 26 液态玻璃：底色很淡，只用一层斜向高光 + 轻微模糊，并提高饱和度让透出的底图更通透
  background: [
    'linear-gradient(135deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0.02) 45%, rgba(255,255,255,0.08) 100%)',
    'rgba(255,255,255,0.34)',
  ].join(', '),
  backdropFilter: 'blur(3px) saturate(1.7) brightness(1.05)',
  WebkitBackdropFilter: 'blur(3px) saturate(1.7) brightness(1.05)',
}

/** 柔光与高光边：都画在同一条路径上（被 clip-path 裁掉外半边，线宽 2 得到 1px 内描边），尖角处连续 */
const outlineStyle: CSSProperties = {
  position: 'absolute', left: 0, top: 0, pointerEvents: 'none',
}

const introStyle: CSSProperties = {
  fontSize: 12, lineHeight: 1.5, color: INK_SECONDARY, marginTop: 8,
  display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical',
  overflow: 'hidden', wordBreak: 'break-word',
}

const chatBtnStyle: CSSProperties = {
  fontSize: 12, fontWeight: 600, padding: '5px 16px', borderRadius: 8,
  cursor: 'pointer', color: INK_PRIMARY,
  // 半透明品牌色 + 高光描边，和玻璃融在一起，不再是一块实心色
  background: 'color-mix(in srgb, var(--brand) 28%, rgba(255,255,255,0.25))',
  border: '1px solid rgba(255,255,255,0.6)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5)',
}
