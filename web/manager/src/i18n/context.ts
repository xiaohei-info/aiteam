/** i18n context：把 @aiteam/shared 的 I18n 实例注入 React 树。 */
import { createContext, useContext } from "react";
import { I18n } from "@aiteam/shared";

export const I18nContext = createContext<I18n | null>(null);

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error("useI18n 必须在 <I18nContext.Provider> 内使用");
  }
  return ctx;
}
