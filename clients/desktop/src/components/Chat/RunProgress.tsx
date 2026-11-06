import { useEffect, useState } from 'react'
import { runProgress } from '../../lib/runProgress'
import type { ThinkingStep } from '../../stores/chat'

/** 运行中替代「思考中」的一行进度；用时按分钟显示，15 秒刷新一次足够。 */
export default function RunProgress({ steps, startedAt }: { steps: readonly ThinkingStep[]; startedAt?: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [])
  return <>{runProgress(steps, startedAt, now)}</>
}
