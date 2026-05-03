/**
 * LMSR (Logarithmic Market Scoring Rule) utilities.
 * Client-side mirror for display only — never trust for real trades.
 */

const B_MIN = 60
const VOLUME_THRESHOLD = 200

/**
 * Adaptive liquidity parameter.
 * Starts small so early trades move the price cheaply,
 * grows toward bMax as cumulative volume increases.
 */
export function calcEffectiveB(totalVolume: number, bMax: number): number {
  return B_MIN + (bMax - B_MIN) * Math.min(1, totalVolume / VOLUME_THRESHOLD)
}

/**
 * Calculate the price (implied probability) of each outcome.
 * price_i = e^(q_i / b) / Σ_j e^(q_j / b)
 */
export function calcPrices(sharesSold: number[], b: number): number[] {
  // Subtract max for numerical stability (softmax trick)
  const max = Math.max(...sharesSold)
  const exps = sharesSold.map((q) => Math.exp((q - max) / b))
  const sum = exps.reduce((a, v) => a + v, 0)
  return exps.map((e) => e / sum)
}

/**
 * Calculate the cost function C(q) = b * ln(Σ_j e^(q_j / b))
 */
export function costFunction(sharesSold: number[], b: number): number {
  const max = Math.max(...sharesSold)
  const sumExp = sharesSold.map((q) => Math.exp((q - max) / b)).reduce((a, v) => a + v, 0)
  return b * (max / b + Math.log(sumExp))
}

/**
 * Calculate the cost to buy `numShares` of outcome `outcomeIndex`.
 * Positive numShares = buy, negative = sell.
 * Returns the play money cost (positive = user pays, negative = user receives).
 */
export function calcCost(
  sharesSold: number[],
  outcomeIndex: number,
  numShares: number,
  b: number,
): number {
  const newSharesSold = [...sharesSold]
  newSharesSold[outcomeIndex] = (newSharesSold[outcomeIndex] ?? 0) + numShares
  return costFunction(newSharesSold, b) - costFunction(sharesSold, b)
}

/**
 * Rescale sharesSold so that prices are preserved when b changes.
 * q_new[i] = q_old[i] * (bNew / bOld)
 * This ensures calcPrices(q_new, bNew) === calcPrices(q_old, bOld).
 */
export function rescaleShares(sharesSold: number[], bOld: number, bNew: number): number[] {
  if (bOld === bNew) return [...sharesSold]
  const scale = bNew / bOld
  return sharesSold.map((q) => q * scale)
}

/**
 * Split score: normalized entropy of the final price distribution.
 * Returns 1.0 when outcomes are perfectly split (max disagreement),
 * approaches 0 when one outcome dominates (consensus).
 */
export function calcSplitScore(prices: number[]): number {
  if (prices.length <= 1) return 0
  const maxEntropy = Math.log(prices.length)
  let entropy = 0
  for (const p of prices) {
    if (p > 0) entropy -= p * Math.log(p)
  }
  const raw = entropy / maxEntropy
  // Cube to make the curve drop off faster for lopsided bets
  return raw * raw * raw
}
