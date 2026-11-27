import { strategyDrives } from './strategy-workflows.ts'

/** What this process knows about the Memory turn that last composed a View. */
export interface IdleReviewStrategyGate {
  /** Configured main Memory strategy id. */
  typeId: string
  /** Whether a Memory turn is tracked for this Session. */
  memoryTurn: boolean
  /** Strategy type id the Session last composed a turn with, when it did so here. */
  composedTypeId?: string | undefined
  /** Whether that composed strategy drives the idle review. */
  composedDrivesIdleReview?: boolean | undefined
  /** Whether the caller forces the review past a composed verdict. */
  forced: boolean
}

/**
 * Decide whether the Session's Memory strategy lets the daily review run.
 * @param gate - the configured strategy and the composed turn, when this process has one.
 * @returns whether the strategy drives `idle-review` for this Session.
 */
export function strategyDrivesIdleReview(gate: IdleReviewStrategyGate): boolean {
  if (!gate.memoryTurn || gate.forced) return strategyDrives({ typeId: gate.typeId }, 'idle-review')
  // A tracked Memory turn with no composed verdict here means this process
  // never saw the composition serve this Session; only a forced review may pass.
  if (gate.composedTypeId === undefined) return false
  return gate.composedTypeId === gate.typeId && gate.composedDrivesIdleReview === true
}
