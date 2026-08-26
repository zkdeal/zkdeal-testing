export const PRODUCTION_CONFIRMATION_FLOOR = 12n
export const DEFAULT_PRODUCTION_CONFIRMATIONS = 64n

export function productionConfirmationDepth(value: bigint): bigint {
  if (value < PRODUCTION_CONFIRMATION_FLOOR) {
    throw new Error(
      `production-shaped room confirmations must be at least ${PRODUCTION_CONFIRMATION_FLOOR}`,
    )
  }
  return value
}
