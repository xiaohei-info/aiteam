export interface ActivityLog {
  time: string
  agent: string
  text: string
  type?: 'thinking' | 'tool' | 'result'
  convId: string
  // 新栈已无 runId 概念,保留字段做旧代码兼容;缺省用 convId 兜底做事件去重 key。
  runId?: string
}

export type ActivityListener = (log: ActivityLog) => void

class GlobalActivityCollector {
  private listeners: Set<ActivityListener> = new Set()
  private seenEvents = new Map<string, Set<string>>()  // runId -> Set<eventKey>
  private activityLogs: ActivityLog[] = []  // 存储所有活动日志

  /** 添加监听器 */
  addListener(listener: ActivityListener) {
    this.listeners.add(listener)
    console.log('[GlobalActivityCollector] Listener added, total:', this.listeners.size)

    // 新监听器注册时，立即发送现有的所有日志
    this.activityLogs.forEach(log => {
      try {
        listener(log)
      } catch (err) {
        console.error('[GlobalActivityCollector] Listener error:', err)
      }
    })
  }

  /** 移除监听器 */
  removeListener(listener: ActivityListener) {
    this.listeners.delete(listener)
    console.log('[GlobalActivityCollector] Listener removed, remaining:', this.listeners.size)
  }

  /** 手动触发事件（从外部调用） */
  emit(log: ActivityLog) {
    // 新栈无 runId 概念,用 convId 兜底做事件分组 key。
    const groupKey = log.runId || log.convId
    // 去重检查
    const eventKey = `${log.type}-${log.text}-${log.time}`
    if (!this.seenEvents.has(groupKey)) {
      this.seenEvents.set(groupKey, new Set())
    }

    const seen = this.seenEvents.get(groupKey)!
    if (seen.has(eventKey)) {
      console.log('[GlobalActivityCollector] Duplicate event ignored:', eventKey)
      return
    }

    seen.add(eventKey)

    // 清理旧的 runId 缓存（保留最近 50 个）
    if (this.seenEvents.size > 50) {
      const oldestKey = Array.from(this.seenEvents.keys())[0]
      this.seenEvents.delete(oldestKey)
    }

    // 存储日志（保留最近 100 条）
    this.activityLogs.unshift(log)
    if (this.activityLogs.length > 100) {
      this.activityLogs.pop()
    }

    console.log('[GlobalActivityCollector] Emitting activity:', log)

    // 通知所有监听器
    this.listeners.forEach(listener => {
      try {
        listener(log)
      } catch (err) {
        console.error('[GlobalActivityCollector] Listener error:', err)
      }
    })
  }

  /** 清理指定 run 的事件缓存 */
  clearRunCache(runId: string) {
    this.seenEvents.delete(runId)
    console.log('[GlobalActivityCollector] Cleared cache for run:', runId)
  }

  /** 获取监听器数量（用于调试） */
  getListenerCount(): number {
    return this.listeners.size
  }

  /** 获取所有活动日志 */
  getAllLogs(): ActivityLog[] {
    return [...this.activityLogs]
  }

  /** 清空所有日志 */
  clearAllLogs() {
    this.activityLogs = []
    console.log('[GlobalActivityCollector] All logs cleared')
  }
}

export const globalActivityCollector = new GlobalActivityCollector()
