// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { MnemonReviewMarkersView } from '../src/host/protocol.ts'
import { MNEMON_REVIEW_CHANNEL } from '../src/host/protocol.ts'
import { SessionRowReviewMarker, markerState } from '../src/client/session-row-review-marker.tsx'

afterEach(cleanup)

describe('markerState', () => {
  it('renders nothing without a marker', () => {
    expect(markerState(undefined, 1000)).toBe('none')
  })
  it('is reviewed while the session has no newer activity', () => {
    expect(markerState({ at: 1000, outcome: 'reviewed' }, 1000)).toBe('reviewed')
    expect(markerState({ at: 2000, outcome: 'skipped' }, 1000)).toBe('reviewed')
    expect(markerState({ at: 1000, outcome: 'reviewed' }, undefined)).toBe('reviewed')
  })
  it('cancels the marker once a newer conversation arrives', () => {
    expect(markerState({ at: 1000, outcome: 'reviewed' }, 1001)).toBe('none')
    expect(markerState({ at: 1000, outcome: 'skipped' }, 1001)).toBe('none')
  })
})

function mount(markers: MnemonReviewMarkersView, updatedAt: number | undefined): { refresh: () => void } {
  const refresh = vi.fn()
  const state = { byId: { 'session-1': updatedAt === undefined ? undefined : { updatedAt } } }
  const useSessions = (selector: (value: typeof state) => number | undefined): number | undefined => selector(state)
  render(<SessionRowReviewMarker sessionId="session-1" markers={{ getSnapshot: () => markers, subscribe: () => () => {}, refresh }} useSessions={useSessions as never} t={key => key} />)
  return { refresh }
}

describe('SessionRowReviewMarker', () => {
  it('shows nothing without a marker for the session', () => {
    mount({ markers: {} }, 1000)
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('shows the reviewed check with a title while no newer activity exists', () => {
    mount({ markers: { 'session-1': { at: 1000, outcome: 'reviewed' } } }, 1000)
    expect(screen.getByRole('img', { hidden: true })?.getAttribute('aria-label')).toBe('marker.reviewed')
  })
  it('shows nothing once the session has newer activity', () => {
    mount({ markers: { 'session-1': { at: 1000, outcome: 'skipped' } } }, 1001)
    expect(screen.queryByRole('img')).toBeNull()
  })
  it('stays absent for a session it never reviewed while others have markers', () => {
    mount({ markers: { 'session-2': { at: 1000, outcome: 'reviewed' } } }, 5000)
    expect(screen.queryByRole('img')).toBeNull()
    expect(MNEMON_REVIEW_CHANNEL).toBe('/dsh-mnemon-review')
  })
  it('asks the shared store for the record when a row mounts', () => {
    const { refresh } = mount({ markers: { 'session-1': { at: 1000, outcome: 'reviewed' } } }, 1000)
    expect(refresh).toHaveBeenCalledOnce()
  })
})
