import type { Message, ThinkingStep } from '../stores/chat'

function stepsOf(message: Message): ThinkingStep[] {
  const steps = [...(message.thinkingSteps ?? (message.thinking ? [{ kind: 'reasoning' as const, text: message.thinking }] : []))]
  for (const tool of message.toolCalls ?? []) {
    if (!steps.some((step) => step.kind === 'tool' && step.tool.id === tool.id)) steps.push({ kind: 'tool', tool })
  }
  return steps
}

function compatibleStep(left: ThinkingStep, right: ThinkingStep): boolean {
  if (left.kind === 'tool' && right.kind === 'tool') return left.tool.id === right.tool.id
  return left.kind === 'reasoning' && right.kind === 'reasoning'
    && (left.text.startsWith(right.text) || right.text.startsWith(left.text))
}

/** Merge overlapping projections, not distinct persisted entries. The caller must establish execution identity first. */
export function mergeReplyProjection(base: Message, update: Message, scope: 'reply' | 'current-message' = 'reply'): Message {
  const steps = stepsOf(base)
  const incoming = stepsOf(update)
  // Snapshots may cover the whole reply, a prefix, or just the current model message.
  let offset = steps.length
  for (let start = 0; start < steps.length && incoming.length; start++) {
    // A current-round snapshot can overlap only the tail, not an earlier round
    // with identical reasoning followed by a completed tool call.
    if (scope === 'current-message' && start + incoming.length < steps.length) continue
    const shared = Math.min(steps.length - start, incoming.length)
    if (incoming.slice(0, shared).every((step, i) => compatibleStep(steps[start + i], step))) {
      offset = start
      break
    }
  }
  incoming.forEach((step, i) => {
    const existing = steps[offset + i]
    if (existing?.kind === 'tool' && step.kind === 'tool') {
      steps[offset + i] = { kind: 'tool', tool: {
        ...existing.tool,
        ...Object.fromEntries(Object.entries(step.tool).filter(([, value]) => value !== undefined)),
      } }
    } else if (existing?.kind === 'reasoning' && step.kind === 'reasoning') {
      steps[offset + i] = existing.text.length >= step.text.length ? existing : step
    } else steps[offset + i] = step
  })
  // Tools have authoritative call IDs even when an older projection lacks reasoning.
  const seen = new Map<string, number>()
  const ordered: ThinkingStep[] = []
  for (const step of steps) {
    const index = step.kind === 'tool' ? seen.get(step.tool.id) : undefined
    if (index !== undefined && step.kind === 'tool') {
      const previous = ordered[index] as Extract<ThinkingStep, { kind: 'tool' }>
      ordered[index] = { kind: 'tool', tool: { ...previous.tool, ...step.tool } }
    } else {
      if (step.kind === 'tool') seen.set(step.tool.id, ordered.length)
      ordered.push(step)
    }
  }
  return {
    ...base, ...update,
    workId: update.workId ?? base.workId,
    senderEmployeeId: update.senderEmployeeId ?? base.senderEmployeeId,
    senderName: update.senderName ?? base.senderName,
    senderRole: update.senderRole ?? base.senderRole,
    entryRefs: [...new Set([...(base.entryRefs ?? []), ...(update.entryRefs ?? [])])],
    content: mergeProjectionText(base.content, update.content),
    thinkingSteps: ordered.length ? ordered : undefined,
    thinking: ordered.filter((s): s is Extract<ThinkingStep, { kind: 'reasoning' }> => s.kind === 'reasoning').map(s => s.text).join(''),
    toolCalls: ordered.filter((s): s is Extract<ThinkingStep, { kind: 'tool' }> => s.kind === 'tool').map(s => s.tool),
  }
}

function mergeProjectionText(base: string, update: string): string {
  if (!base || update.startsWith(base)) return update
  if (!update || base.startsWith(update) || base.endsWith(update)) return base
  // Current-message snapshots can extend the final paragraph of the aggregate.
  const boundary = base.lastIndexOf('\n\n')
  if (boundary >= 0 && update.startsWith(base.slice(boundary + 2))) return base.slice(0, boundary + 2) + update
  return `${base}\n\n${update}`
}

/** Match only within the supplied conversation. Names, timestamps and body text are never identity keys. */
export function replyMatches(messages: Message[], pending: Message): Message[] {
  const candidates = messages.filter(message => {
    if (message.id === pending.id) return true
    if (message.role !== 'assistant' || pending.role !== 'assistant'
      || message.senderEmployeeId !== pending.senderEmployeeId) return false
    if (message.workId && pending.workId) return message.workId === pending.workId
    if (message.entryRefs?.some(ref => pending.entryRefs?.includes(ref))) return true
    // A live tool call can be tied to a persisted work, but never to an unowned legacy range.
    if (!message.workId && !pending.workId) return false
    const ids = new Set(stepsOf(pending).flatMap(step => step.kind === 'tool' ? [step.tool.id] : []))
    return stepsOf(message).some(step => step.kind === 'tool' && ids.has(step.tool.id))
  })
  // A reused tool ID in different works is ambiguous. Keep projections separate.
  const works = new Set(candidates.map(message => message.workId).filter(Boolean))
  return works.size > 1 ? candidates.filter(message => message.id === pending.id) : candidates
}

/** Keep the live row ID stable, replace all aliases at their first position, retain entry references. */
export function reconcileReplyProjection(messages: Message[], pending: Message): { messages: Message[]; message: Message } {
  const matches = replyMatches(messages, pending)
  const durable = matches.filter(message => message.id !== pending.id)
  let merged = durable.reduce((base, message) => mergeReplyProjection(base, message), { ...pending, content: '', thinking: undefined, thinkingSteps: [], toolCalls: [], entryRefs: [] })
  merged = mergeReplyProjection(merged, pending)
  const ids = new Set(matches.map(message => message.id))
  const first = messages.findIndex(message => ids.has(message.id))
  const remaining = messages.filter(message => !ids.has(message.id))
  remaining.splice(first < 0 ? remaining.length : first, 0, merged)
  return { messages: remaining, message: merged }
}
