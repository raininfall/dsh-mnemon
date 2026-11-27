// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MnemonClient } from '../src/client/api.ts'
import { IdleReviewQueue, idleReviewNotice } from '../src/client/IdleReviewQueue.tsx'
import { translateEn, translateZh } from '../src/client/locales.ts'
import { I18nContext } from '../src/client/page-kit.tsx'

afterEach(cleanup)

const queue = {
  pending: 2,
  sessions: [
    { id: 'session-old', createdAt: new Date('2026-11-19T10:00:00+08:00').getTime(), cwd: '/work/old', title: 'Oldest notes' },
    { id: 'session-new', createdAt: new Date('2026-11-26T10:00:00+08:00').getTime(), cwd: '/work/new' },
  ],
}

function fixture(options: { writeEnabled?: boolean; english?: boolean; empty?: boolean } = {}) {
  const idleReviewQueue = vi.fn(async () => options.empty === true ? { pending: 0, sessions: [] } : queue)
  const reviewIdleSession = vi.fn(async () => ({ outcome: 'reviewed' as const }))
  const onReviewed = vi.fn()
  render(<I18nContext.Provider value={options.english === true ? translateEn : translateZh}>
    <IdleReviewQueue
      client={{ idleReviewQueue, reviewIdleSession } as unknown as MnemonClient}
      writeEnabled={options.writeEnabled ?? true}
      onReviewed={onReviewed}
    />
  </I18nContext.Provider>)
  return { idleReviewQueue, reviewIdleSession, onReviewed }
}

describe('IdleReviewQueue', () => {
  it('lists the pending Sessions with their titles, dates and a count', async () => {
    fixture()
    expect(await screen.findByText('Oldest notes')).toBeTruthy()
    expect(screen.getByText('/work/new')).toBeTruthy()
    expect(screen.getByText('2 个待审查')).toBeTruthy()
    expect(screen.getByText(/11-19/)).toBeTruthy()
  })

  it('reviews one row and reports what the request did', async () => {
    const f = fixture()
    await screen.findByText('Oldest notes')
    fireEvent.click(screen.getAllByRole('button', { name: '审查' })[0]!)
    await waitFor(() => expect(f.reviewIdleSession).toHaveBeenCalledWith('session-old'))
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '已审查')
    expect(f.onReviewed).toHaveBeenCalledOnce()
    expect(f.idleReviewQueue).toHaveBeenCalledTimes(2)
  })

  it('renders an English empty state without review actions', async () => {
    fixture({ english: true, empty: true })
    expect(await screen.findByText('No Session is waiting for review')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps the rows but disables review on a read-only Host', async () => {
    fixture({ writeEnabled: false })
    await screen.findByText('Oldest notes')
    expect(screen.getAllByRole('button', { name: '审查' }).every(button => (button as HTMLButtonElement).disabled)).toBe(true)
  })

  it('keeps a failed request visible beside the rows', async () => {
    const f = fixture()
    f.reviewIdleSession.mockRejectedValueOnce(new Error('Host rejected the review'))
    await screen.findByText('Oldest notes')
    fireEvent.click(screen.getAllByRole('button', { name: '审查' })[0]!)
    expect((await screen.findByRole('alert')).textContent).toContain('Host rejected the review')
    expect(screen.getByText('Oldest notes')).toBeTruthy()
  })
})

describe('idleReviewNotice', () => {
  it('names the rule that declined a review', () => {
    expect(idleReviewNotice(translateEn, { outcome: 'reviewed' })).toBe('Reviewed')
    expect(idleReviewNotice(translateEn, { outcome: 'failed', reason: 'failed' })).toBe('Review failed; try again later')
    expect(idleReviewNotice(translateEn, { outcome: 'skipped', reason: 'handled' })).toBe('Already reviewed today')
    expect(idleReviewNotice(translateEn, { outcome: 'skipped', reason: 'busy' })).toBe('The Session is running; try again later')
    expect(idleReviewNotice(translateEn, { outcome: 'skipped', reason: 'unavailable' })).toBe('This Session cannot be reviewed right now')
  })
})
