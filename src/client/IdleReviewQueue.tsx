import { useCallback, useEffect, useState, type JSX } from 'react'
import type { MnemonIdleReviewQueue, MnemonIdleReviewResult } from '../host/protocol.ts'
import type { MnemonClient } from './api.ts'
import type { MnemonKey, MnemonTranslate } from './locales.ts'
import css from './MnemonView.module.css'
import { message, useT } from './page-kit.tsx'

/** Local month and day, matching the sidebar's compact Session dates. */
function sessionDate(at: number): string {
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Locale key for what one review request did, so the row note stays localized. */
export function idleReviewNotice(t: MnemonTranslate, result: MnemonIdleReviewResult): string {
  if (result.outcome === 'reviewed') return t('status.idleReviewReviewed')
  if (result.outcome === 'failed') return t('status.idleReviewFailed')
  const key: MnemonKey = result.reason === 'busy' ? 'status.idleReviewBusy'
    : result.reason === 'disabled' ? 'status.idleReviewDisabled'
      : result.reason === 'handled' ? 'status.idleReviewHandled'
        : result.reason === 'cancelled' ? 'status.idleReviewCancelled'
          : result.reason === 'unavailable' ? 'status.idleReviewUnavailable'
            : 'status.idleReviewBlocked'
  return t(key)
}

type QueueEntry = MnemonIdleReviewQueue['sessions'][number]

function titled(session: QueueEntry): boolean {
  return session.title !== undefined && session.title !== ''
}

function sessionLabel(session: QueueEntry): string {
  if (titled(session)) return session.title ?? ''
  if (session.cwd !== undefined && session.cwd !== '') return session.cwd
  return session.id
}

/** Creation date, then the workspace only when the title already names the Session. */
function sessionMeta(session: QueueEntry): string {
  const created = session.createdAt > 0 ? sessionDate(session.createdAt) : ''
  const cwd = titled(session) ? (session.cwd ?? '') : ''
  return cwd === '' ? created : `${created} · ${cwd}`
}

/**
 * Sessions the daily idle review still owes, with a per-row manual review.
 * The list is a view over the same eligibility rules the daily sweep uses, so
 * a Session leaves it as soon as its review succeeds.
 */
export function IdleReviewQueue(props: {
  client: MnemonClient
  writeEnabled: boolean
  onReviewed: () => void
}): JSX.Element {
  const t = useT()
  const [queue, setQueue] = useState<MnemonIdleReviewQueue | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    let cancelled = false
    void props.client.idleReviewQueue().then(value => {
      if (cancelled) return
      setQueue(value)
      setFailure(null)
    }, (error: unknown) => { if (!cancelled) setFailure(message(error)) })
    return () => { cancelled = true }
  }, [props.client])
  useEffect(() => load(), [load])

  const review = async (sessionId: string): Promise<void> => {
    setRunning(sessionId)
    setFailure(null)
    setNotice(null)
    try {
      const result = await props.client.reviewIdleSession(sessionId)
      setNotice(idleReviewNotice(t, result))
      load()
      if (result.outcome === 'reviewed') props.onReviewed()
    } catch (error) {
      setFailure(message(error))
    } finally {
      setRunning(null)
    }
  }

  const sessions = queue?.sessions ?? []
  const blocked = !props.writeEnabled
  return <section className={css.idleReview} aria-label={t('status.idleReviewTitle')}>
    <div className={css.statusSectionHeader}>
      <div>
        <h3>{t('status.idleReviewTitle')}</h3>
        <p>{t('status.idleReviewDescription')}</p>
      </div>
      {queue !== null && queue.pending > 0 && <span className={css.phaseBadge}>{t('status.idleReviewPending', { count: queue.pending })}</span>}
    </div>
    {failure !== null && <div className={css.storageUnavailable} role="alert">{failure}</div>}
    {notice !== null && <div className={css.idleReviewNotice} role="status">{notice}</div>}
    {queue === null && failure === null
      ? <div className={css.storageUnavailable}>{t('status.idleReviewLoading')}</div>
      : sessions.length === 0
        ? <div className={css.storageUnavailable}>{t('status.idleReviewEmpty')}</div>
        : <div className={css.idleReviewList}>
          {sessions.map(session => <article key={session.id}>
            <div className={css.idleReviewCopy}>
              <strong title={sessionLabel(session)}>{sessionLabel(session)}</strong>
              <small>{sessionMeta(session)}</small>
            </div>
            <button
              type="button"
              className={css.secondaryButton}
              disabled={running !== null || blocked}
              title={blocked ? t('status.idleReviewReadOnly') : undefined}
              onClick={() => { void review(session.id) }}
            >{running === session.id ? t('status.idleReviewRunning') : t('status.idleReviewAction')}</button>
          </article>)}
        </div>}
  </section>
}
