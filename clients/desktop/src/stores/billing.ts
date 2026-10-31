import { create } from 'zustand'

interface BillingState {
  isRechargePromptOpen: boolean
  rechargeMessage: string
  openRechargePrompt: (message?: string) => void
  closeRechargePrompt: () => void
}

const DEFAULT_MESSAGE = '账户余额不足，无法继续与 AI 员工对话。请充值后再试。'

export const useBillingStore = create<BillingState>((set) => ({
  isRechargePromptOpen: false,
  rechargeMessage: DEFAULT_MESSAGE,
  openRechargePrompt: (message?: string) =>
    set({
      isRechargePromptOpen: true,
      rechargeMessage: message && message.trim() ? message : DEFAULT_MESSAGE,
    }),
  closeRechargePrompt: () =>
    set({ isRechargePromptOpen: false, rechargeMessage: DEFAULT_MESSAGE }),
}))
