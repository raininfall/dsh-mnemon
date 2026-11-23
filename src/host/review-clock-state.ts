import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { writeAtomicJsonSync } from './fs-atomic.ts'

export interface ReviewClockState {
  readonly version: 1
  readonly sessionId: string
  readonly lastHandledDueAt: number | null
}

const MAX_STATE_BYTES = 16_384
const MAX_TIMESTAMP = 8_640_000_000_000_000

/**
 * Per-session record of the most recent daily review occurrence already
 * handled. Missing, corrupt, or foreign state reads as a first run so a broken
 * clock record never blocks the nightly review.
 */
export class ReviewClockStore {
  readonly path: string
  private readonly directory: string
  private readonly sessionId: string

  constructor(directory: string, sessionId: string) {
    if (!sessionId || Buffer.byteLength(sessionId) > 4096) throw new Error('review clock state needs a session id')
    this.directory = join(resolve(directory), 'state', 'idle-review')
    this.sessionId = sessionId
    this.path = join(this.directory, createHash('sha256').update(sessionId).digest('hex') + '.clock.json')
  }

  load(): ReviewClockState {
    const empty: ReviewClockState = { version: 1, sessionId: this.sessionId, lastHandledDueAt: null }
    let descriptor: number | undefined
    try {
      descriptor = fs.openSync(this.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0))
      const info = fs.fstatSync(descriptor)
      if (!info.isFile() || info.size > MAX_STATE_BYTES) return empty
      const bytes = Buffer.alloc(MAX_STATE_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null)
        if (count === 0) break
        length += count
      }
      if (length > MAX_STATE_BYTES) return empty
      const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
      if (value === null || typeof value !== 'object') return empty
      const state = value as Partial<ReviewClockState>
      const valid = state.lastHandledDueAt === null
        || typeof state.lastHandledDueAt === 'number' && Number.isSafeInteger(state.lastHandledDueAt)
          && state.lastHandledDueAt >= 0 && state.lastHandledDueAt <= MAX_TIMESTAMP
      if (state.version !== 1 || state.sessionId !== this.sessionId || !valid) return empty
      return { version: 1, sessionId: this.sessionId, lastHandledDueAt: state.lastHandledDueAt ?? null }
    } catch {
      return empty
    } finally {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch { /* descriptor already closed */ }
    }
  }

  save(state: Pick<ReviewClockState, 'lastHandledDueAt'>): void {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    writeAtomicJsonSync(this.path, { version: 1, sessionId: this.sessionId, lastHandledDueAt: state.lastHandledDueAt },
      { fs, indent: 0, flag: 'wx' })
  }
}
