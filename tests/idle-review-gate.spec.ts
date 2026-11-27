import { describe, expect, it } from 'vitest'
import { strategyDrivesIdleReview } from '../src/host/idle-review-gate.ts'

const LAYERED = 'default-three-tier'

describe('strategyDrivesIdleReview', () => {
  it('declines a non-forced review of a tracked Memory turn this process never composed', () => {
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, forced: false })).toBe(false)
    expect(strategyDrivesIdleReview({ typeId: 'recall-only', memoryTurn: true, forced: false })).toBe(false)
  })

  it('lets the configured strategy decide for a resumed Session whose review a caller forces', () => {
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, forced: true })).toBe(true)
    expect(strategyDrivesIdleReview({ typeId: 'recall-only', memoryTurn: true, forced: true })).toBe(false)
  })

  it('follows the composed turn once this process composed one', () => {
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, composedTypeId: LAYERED, composedDrivesIdleReview: true, forced: false })).toBe(true)
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, composedTypeId: LAYERED, composedDrivesIdleReview: false, forced: false })).toBe(false)
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, composedTypeId: 'scoped', composedDrivesIdleReview: true, forced: false })).toBe(false)
  })

  it('falls back to the configured strategy when the caller forces the review', () => {
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, composedTypeId: 'scoped', composedDrivesIdleReview: false, forced: true })).toBe(true)
  })

  it('falls back to the configured strategy when no Memory turn is tracked', () => {
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: false, forced: false })).toBe(true)
  })

  it('treats a composed turn without a recorded verdict as not driving the review', () => {
    expect(strategyDrivesIdleReview({ typeId: LAYERED, memoryTurn: true, composedTypeId: LAYERED, forced: false })).toBe(false)
  })
})
