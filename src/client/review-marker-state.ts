import { ExternalStore } from './shared/store.ts'
import type { MnemonReviewMarkersView } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'

const EMPTY: MnemonReviewMarkersView = { markers: {} }

/**
 * The Host's review marker record, held once for every Session row.
 *
 * Rows read the snapshot without addressing the Host themselves; a mounted row
 * asks for a refresh, which is shared while in flight and throttled after a
 * fresh fetch, so sidebar scrolling never fans out into per-row requests.
 */
export class MnemonReviewMarkerStore extends ExternalStore<MnemonReviewMarkersView> {
  private inFlight: Promise<void> | undefined
  private fetchedAt = 0

  constructor(private readonly client: Pick<MnemonClient, 'reviewMarkers'>) {
    super(EMPTY)
  }

  /**
   * Fetch the record unless a request is in flight or the last fetch is younger
   * than `throttleMs`. Concurrent calls share the in-flight request.
   */
  refresh(throttleMs = 15_000): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight
    if (Date.now() - this.fetchedAt < throttleMs) return Promise.resolve()
    this.inFlight = this.client.reviewMarkers()
      .then((value): void => { this.setSnapshot(isMarkers(value) ? value : EMPTY) })
      .catch((): void => undefined)
      .finally((): void => { this.inFlight = undefined; this.fetchedAt = Date.now() })
    return this.inFlight
  }
}

function isMarkers(value: unknown): value is MnemonReviewMarkersView {
  return typeof value === 'object' && value !== null && typeof (value as { markers?: unknown }).markers === 'object' && (value as { markers?: unknown }).markers !== null
}
