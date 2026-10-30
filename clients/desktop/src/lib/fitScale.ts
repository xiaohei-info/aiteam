interface FitScaleInput {
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  minScale?: number
  maxScale?: number
}

export function calculateFitScale({
  contentWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
  minScale = 0.5,
  maxScale = 2,
}: FitScaleInput): number {
  const dimensions = [contentWidth, contentHeight, viewportWidth, viewportHeight]
  if (dimensions.some((value) => !Number.isFinite(value) || value <= 0)) return 1

  const lower = Math.min(minScale, maxScale)
  const upper = Math.max(minScale, maxScale)
  const fit = Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight)
  return Math.min(upper, Math.max(lower, fit))
}
