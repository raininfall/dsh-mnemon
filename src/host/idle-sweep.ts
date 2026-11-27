import { nextOccurrence } from './review-clock.ts'

/**
 * A daily sweep that reviews stored Sessions the per-agent clock cannot reach.
 * The per-agent clock only exists while a Session is loaded, so Sessions that
 * finished before the wall-clock time are never reviewed. The sweep re-reads
 * its settings on every tick so configuration changes apply without a restart.
 */
export interface IdleSweepHost {
  /** Local `HH:MM` wall-clock time the sweep runs at. */
  at(): string
  /** Whether the sweep may run at all. */
  enabled(): boolean
  /** Maximum Sessions reviewed in one sweep; the rest wait for the next one. */
  maxPerRun(): number
  /** Session ids eligible for review, longest-waiting first. */
  candidates(signal: AbortSignal): Promise<readonly string[]>
  /** Review one Session; concurrent runs must not overlap. */
  review(sessionId: string, signal: AbortSignal): Promise<IdleSweepReviewOutcome>
  /** Report a sweep or per-Session failure without stopping later Sessions. */
  onError?(error: unknown): void
  /** Delay after start before the catch-up sweep runs. */
  catchUpMs?: number
  /** Injectable clock for tests. */
  now?(): number
}

/** Delay between process start and the catch-up sweep. */
export const DEFAULT_IDLE_SWEEP_CATCHUP_MS = 60_000

/**
 * Result of one attempted Session review. `skipped` means the Session needed no
 * review at that moment (already handled by its own clock or not admitted), so it
 * does not spend the sweep batch.
 */
export type IdleSweepReviewOutcome = 'reviewed' | 'skipped' | 'failed'

/**
 * How many candidates one sweep may inspect per batch slot. A candidate costs a
 * Session resume even when the review turns out to be skipped, so the scan stops
 * after this multiple of the batch size instead of walking the whole backlog.
 */
const IDLE_SWEEP_SCAN_FACTOR = 4

/**
 * Run one sweep immediately and then once per day at {@link IdleSweepHost.at}.
 * @param host - sweep settings, candidate source, and per-Session review.
 * @returns a disposer that cancels the pending timer and the running sweep.
 */
export function startIdleSweep(host: IdleSweepHost): () => void {
  const now = host.now ?? Date.now
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let running = false

  const arm = (): void => {
    if (stopped) return
    if (timer !== undefined) clearTimeout(timer)
    // Look one second ahead so a sweep that runs exactly on the wall-clock time
    // arms the next day instead of re-arming itself.
    const due = nextOccurrence(host.at(), new Date(now() + 1_000)).getTime()
    timer = setTimeout(() => { void run() }, Math.max(0, due - now()))
    timer.unref?.()
  }

  const run = async (): Promise<void> => {
    if (stopped || controller.signal.aborted) return
    // A catch-up sweep and the daily tick can land together; one sweep is enough.
    if (running) {
      arm()
      return
    }
    running = true
    try {
      if (host.enabled()) {
        const candidates = await host.candidates(controller.signal)
        const limit = Math.max(0, host.maxPerRun())
        const scanLimit = limit * IDLE_SWEEP_SCAN_FACTOR
        // A skipped Session must not spend the batch, otherwise the Sessions the
        // per-agent clock already handled every night fill the batch and a long
        // backlog never drains.
        let budget = limit
        let scanned = 0
        for (const sessionId of candidates) {
          if (budget <= 0 || scanned >= scanLimit) break
          if (stopped || controller.signal.aborted) return
          scanned += 1
          let outcome: IdleSweepReviewOutcome = 'failed'
          try {
            outcome = await host.review(sessionId, controller.signal)
          } catch (error) {
            host.onError?.(error)
          }
          if (outcome !== 'skipped') budget -= 1
        }
      }
    } catch (error) {
      host.onError?.(error)
    } finally {
      running = false
      arm()
    }
  }

  const catchUp = setTimeout(() => { void run() }, Math.max(0, host.catchUpMs ?? DEFAULT_IDLE_SWEEP_CATCHUP_MS))
  catchUp.unref?.()
  arm()

  return () => {
    stopped = true
    controller.abort(new Error('idle sweep stopped'))
    if (timer !== undefined) clearTimeout(timer)
    clearTimeout(catchUp)
  }
}
