/** WebKit 可能先发 compositionend，再发 keyCode=229 的确认键。 */
export function isImeKeyboardEvent(
  event: { isComposing?: boolean; keyCode?: number },
  composing: boolean,
): boolean {
  return composing || event.isComposing === true || event.keyCode === 229
}
