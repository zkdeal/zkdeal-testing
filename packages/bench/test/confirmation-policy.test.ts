import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PRODUCTION_CONFIRMATIONS,
  productionConfirmationDepth,
  PRODUCTION_CONFIRMATION_FLOOR,
} from '../src/confirmation-policy.ts'

test('production-shaped rooms default to 64 confirmations with a floor of 12', () => {
  assert.equal(DEFAULT_PRODUCTION_CONFIRMATIONS, 64n)
  assert.equal(PRODUCTION_CONFIRMATION_FLOOR, 12n)
  assert.equal(productionConfirmationDepth(12n), 12n)
  assert.throws(() => productionConfirmationDepth(11n), /at least 12/)
})
