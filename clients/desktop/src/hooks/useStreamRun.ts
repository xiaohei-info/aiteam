import { useChatStore, type AssistantStreamOptions } from '../stores/chat'

export interface StreamState { active: Set<string> }

export function useStreamRun() {
  const streamingMsgIds = useChatStore((s) => s.streamingMsgIds)
  const generatingConvIds = useChatStore((s) => s.generatingConvIds)
  const startAssistantStream = useChatStore((s) => s.startAssistantStream)
  return {
    streamState: { active: streamingMsgIds } as StreamState,
    generatingConvIds,
    beginAssistantStream: (convId: string, options?: AssistantStreamOptions) =>
      startAssistantStream(convId, options),
  }
}
