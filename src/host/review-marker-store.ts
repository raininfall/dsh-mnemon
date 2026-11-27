import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { writeAtomicJsonSync } from './fs-atomic.ts'

export type ReviewMarkerOutcome = 'reviewed' | 'skipped'

export interface ReviewMarker {
  readonly at: number
  readonly outcome: ReviewMarkerOutcome
}

export type ReviewMarkerRecord = Readonly<Record<string, ReviewMarker>>

const MAX_MARKER_BYTES = 512_000
const MAX_TIMESTAMP = 8_640_000_000_000_000

/**
 * Global record of the last idle-review coverage per session, written under
 * the global storage root so the sidebar can read every workspace's sessions
 * from one file. Missing, corrupt, or foreign state reads as empty so a
 * broken marker file never blocks review. Last-write-wins per session.
 */
export class ReviewMarkerStore {
  readonly path: string
  private readonly directory: string

  constructor(root: string) {
    this.directory = join(resolve(root), 'state')
    this.path = join(this.directory, 'review-markers.json')
  }

  load(): ReviewMarkerRecord {
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      const info = fs.fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_MARKER_BYTES) return {}
      const bytes = Buffer.alloc(MAX_MARKER_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length > MAX_MARKER_BYTES) return {}
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
      if (value === null || typeof value !== 'object') return {}
      const file = value as { version?: unknown; markers?: unknown }
      if (file.version !== 1 || file.markers === null || typeof file.markers !== 'object') return {}
      const record: Record<string, ReviewMarker> = {}
      for (const [sessionId, raw] of Object.entries(file.markers as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object') continue
        const marker = raw as { at?: unknown; outcome?: unknown }
        if (typeof marker.at !== 'number' || !Number.isSafeInteger(marker.at) || marker.at < 0 || marker.at > MAX_TIMESTAMP) continue
        if (marker.outcome !== 'reviewed' && marker.outcome !== 'skipped') continue
        record[sessionId] = { at: marker.at, outcome: marker.outcome }
      }
      return record
    } catch {
      return {}
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* descriptor already closed */ }
    }
  }

  record(sessionId: string, outcome: ReviewMarkerOutcome, at = Date.now()): void {
    if (!sessionId || Buffer.byteLength(sessionId) > 4096) throw new Error('review marker needs a session id')
    const markers = { ...this.load(), [sessionId]: { at, outcome } }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeAtomicJsonSync(this.path, { version: 1, markers }, { fs, indent: 0 })
  }

  /**
   * Drops one session's marker and keeps every other entry. A session without
   * a marker leaves the file untouched, so clearing never creates state.
   * @param sessionId - Session whose marker stops applying.
   */
  clear(sessionId: string): void {
    if (!sessionId || Buffer.byteLength(sessionId) > 4096) throw new Error('review marker needs a session id')
    const markers: Record<string, ReviewMarker> = { ...this.load() }
    if (!Object.hasOwn(markers, sessionId)) return
    delete markers[sessionId]
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeAtomicJsonSync(this.path, { version: 1, markers }, { fs, indent: 0 })
  }
}
