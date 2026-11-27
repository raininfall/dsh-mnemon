import { useCallback, useEffect, useSyncExternalStore, type JSX } from 'react'
import { IconCheckCircleFillMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MnemonReviewMarker, MnemonReviewMarkersView } from '../host/protocol.ts'
import type { MnemonKey } from './locales.ts'

export type ReviewMarkerState = 'none' | 'reviewed'

/** A marker renders only while it covers the conversation; newer user input cancels it. */
export function markerState(marker: MnemonReviewMarker | undefined, updatedAt: number | undefined): ReviewMarkerState {
  if (marker === undefined) return 'none'
  return updatedAt !== undefined && updatedAt > marker.at ? 'none' : 'reviewed'
}

interface SessionRowReviewMarkerProps {
  readonly sessionId: string
  readonly markers: {
    getSnapshot: () => MnemonReviewMarkersView
    subscribe: (listener: () => void) => () => void
    refresh: () => void
  }
  readonly useSessions: (selector: (state: { byId: Record<string, { updatedAt?: number } | undefined> }) => number | undefined) => number | undefined
  readonly t: (key: MnemonKey) => string
}

export function SessionRowReviewMarker({ sessionId, markers, useSessions, t }: SessionRowReviewMarkerProps): JSX.Element | null {
  const subscribe = useCallback((listener: () => void) => markers.subscribe(listener), [markers])
  const getSnapshot = useCallback(() => markers.getSnapshot(), [markers])
  const view = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const updatedAt = useSessions(state => state.byId[sessionId]?.updatedAt)
  useEffect(() => { markers.refresh() }, [markers, updatedAt])
  if (markerState(view.markers[sessionId], updatedAt) === 'none') return null
  const label = t('marker.reviewed')
  return <span role="img" aria-label={label} title={label} style={{ display: 'inline-flex', alignItems: 'center' }}>
    <IconCheckCircleFillMedium size={14} />
  </span>
}
