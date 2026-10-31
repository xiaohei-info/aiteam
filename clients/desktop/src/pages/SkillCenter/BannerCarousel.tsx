import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface BannerSlide {
  id: string
  title: string
  subtitle: string
  accent: string
  gradient: string
  icon: string
}

const SLIDES: BannerSlide[] = [
  {
    id: '1',
    title: '本周热门：SQL 查询生成器',
    subtitle: '1,280+ 次调用 · 自然语言秒变高性能查询',
    accent: 'text-emerald-300',
    gradient: 'from-emerald-600/30 via-emerald-900/20 to-transparent',
    icon: '⌘',
  },
  {
    id: '2',
    title: '新技能上线：API 文档解析器',
    subtitle: '一键解析 Swagger 文档，自动生成类型定义',
    accent: 'text-sky-300',
    gradient: 'from-sky-600/30 via-sky-900/20 to-transparent',
    icon: '◈',
  },
  {
    id: '3',
    title: '技能创作挑战赛',
    subtitle: '发布原创技能，赢取团队积分奖励',
    accent: 'text-brand-300',
    gradient: 'from-brand-600/30 via-brand-900/20 to-transparent',
    icon: '✦',
  },
]

export default function BannerCarousel() {
  const [current, setCurrent] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const resetTimer = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setCurrent(c => (c + 1) % SLIDES.length)
    }, 5000)
  }, [])

  const next = useCallback(() => {
    setCurrent(c => (c + 1) % SLIDES.length)
    resetTimer()
  }, [resetTimer])

  const prev = useCallback(() => {
    setCurrent(c => (c - 1 + SLIDES.length) % SLIDES.length)
    resetTimer()
  }, [resetTimer])

  const goTo = useCallback((index: number) => {
    setCurrent(index)
    resetTimer()
  }, [resetTimer])

  useEffect(() => {
    resetTimer()
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [resetTimer])

  const slide = SLIDES[current]

  return (
    <div className="relative mx-7 mt-5 mb-2 h-[88px] rounded-[14px] overflow-hidden bg-surface-1 ring-1 ring-[var(--border)] group/banner">
      {/* Background gradient */}
      <div
        className={`absolute inset-0 bg-gradient-to-r ${slide.gradient} transition-all duration-700 ease-out`}
      />

      {/* Content */}
      <div className="relative z-10 flex items-center h-full px-6">
        <div
          className={`flex h-12 w-12 items-center justify-center rounded-[12px] bg-surface-2 text-2xl ${slide.accent} ring-1 ring-[var(--border-hover)] flex-shrink-0 transition-transform duration-500`}
          key={slide.id}
        >
          {slide.icon}
        </div>
        <div className="ml-4 min-w-0">
          <h3
            className="font-display text-[15px] font-semibold text-txt-primary truncate"
          >
            {slide.title}
          </h3>
          <p
            className="mt-0.5 text-[12px] text-txt-secondary truncate"
          >
            {slide.subtitle}
          </p>
        </div>
      </div>

      {/* Navigation arrows */}
      <button
        onClick={prev}
        className="absolute left-2 top-1/2 -translate-y-1/2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-surface-3/80 text-txt-muted opacity-0 group-hover/banner:opacity-100 hover:bg-surface-4 hover:text-txt-primary transition-all duration-200 cursor-pointer"
      >
        <ChevronLeft size={14} />
      </button>
      <button
        onClick={next}
        className="absolute right-2 top-1/2 -translate-y-1/2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-surface-3/80 text-txt-muted opacity-0 group-hover/banner:opacity-100 hover:bg-surface-4 hover:text-txt-primary transition-all duration-200 cursor-pointer"
      >
        <ChevronRight size={14} />
      </button>

      {/* Dots */}
      <div className="absolute bottom-2.5 left-1/2 -translate-x-1/2 z-20 flex gap-1.5">
        {SLIDES.map((s, i) => (
          <button
            key={s.id}
            onClick={() => goTo(i)}
            className={`h-[5px] rounded-full transition-all duration-300 cursor-pointer ${
              i === current ? 'w-4 bg-brand' : 'w-[5px] bg-[var(--glass-bg-strong)] hover:bg-[var(--border-active)]'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
