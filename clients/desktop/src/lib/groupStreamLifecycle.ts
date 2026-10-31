export type ParticipantRunStatus = 'expected' | 'running' | 'settled'

export interface SettleTrackerSnapshot {
  mode: 'single' | 'group'
  expectedTargetsKnown: boolean
  participants: Readonly<Record<string, ParticipantRunStatus>>
  conversationEnded: boolean
  done: boolean
}

export interface SettleTrackerOptions {
  mode: 'single' | 'group'
  expectedEmployeeIds?: readonly string[]
  /**
   * 群聊恢复流时，客户端拿不到原 prompt 的 mentions，目标集合并不完整。
   * 这种情况下不能因首个已观察员工 settled 就推断整轮完成。
   */
  expectedTargetsKnown?: boolean
  onComplete: () => void
}

export interface SettleTracker {
  markRunning: (sourceEmployeeId: string | undefined, newExecution?: boolean) => void
  markSettled: (sourceEmployeeId: string | undefined) => void
  markConversationEnded: () => void
  getSnapshot: () => SettleTrackerSnapshot
  isDone: () => boolean
  release: () => void
}

function uniqueEmployeeIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter(Boolean))]
}

/**
 * 跟踪一轮 prompt 中每位员工的运行终态。
 *
 * 已知目标来自本轮 prompt 路由；运行期间观察到的新员工（例如 coordinator 通过
 * mention_employee 动态委派的 child）会加入同一轮，防止协调人先结束时遗漏子员工。
 * 恢复未知群聊流时，只有会话聚合运行态确认结束后才能调用 markConversationEnded。
 */
export function createSettleTracker(options: SettleTrackerOptions): SettleTracker {
  const participants = new Map<string, ParticipantRunStatus>()
  for (const employeeId of uniqueEmployeeIds(options.expectedEmployeeIds)) {
    participants.set(employeeId, 'expected')
  }

  const expectedTargetsKnown = options.mode === 'single'
    ? true
    : options.expectedTargetsKnown === true
  let anonymousSingleSettled = false
  let conversationEnded = false
  let released = false
  let fired = false

  const maybeComplete = () => {
    if (released || fired) return
    const allParticipantsSettled = participants.size > 0
      && [...participants.values()].every((status) => status === 'settled')
    const complete = conversationEnded
      || options.mode === 'single' && (anonymousSingleSettled || allParticipantsSettled)
      || options.mode === 'group' && expectedTargetsKnown && allParticipantsSettled
    if (!complete) return
    fired = true
    options.onComplete()
  }

  return {
    markRunning(sourceEmployeeId, newExecution = false) {
      if (released || fired || !sourceEmployeeId) return
      if (newExecution || participants.get(sourceEmployeeId) !== 'settled') {
        participants.set(sourceEmployeeId, 'running')
      }
    },
    markSettled(sourceEmployeeId) {
      if (released || fired) return
      if (sourceEmployeeId) {
        participants.set(sourceEmployeeId, 'settled')
      } else if (options.mode === 'single') {
        anonymousSingleSettled = true
      } else {
        // 群聊事件缺少 source_employee_id 时无法归属员工，不得据此结束整轮。
        return
      }
      maybeComplete()
    },
    markConversationEnded() {
      if (released || fired) return
      conversationEnded = true
      maybeComplete()
    },
    getSnapshot() {
      return {
        mode: options.mode,
        expectedTargetsKnown,
        participants: Object.fromEntries(participants),
        conversationEnded,
        done: fired,
      }
    },
    isDone() {
      return fired
    },
    release() {
      released = true
    },
  }
}
