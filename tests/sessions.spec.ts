/**
 * Session list tests.
 *
 * The fold is pure, so these are about the *decisions*: which label a session
 * gets when it has no title, which rows claim to be resumable, and whether the
 * list is stable enough to drive with a keyboard.
 */
import { describe, expect, it } from 'vitest'
import {
  buildSessionRows,
  describeSessionRow,
  formatAge,
  formatWorkspace,
  isResumable,
  sessionLabel,
  shortId,
  type SessionSummary,
} from '../src/app/sessions.ts'

/** A session with sensible defaults, so a test states only what it is about. */
function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'main-session-aaaaaaaa-1111-2222-3333-444444444444',
    createdAt: 1_000_000,
    live: false,
    persisted: true,
    ...overrides,
  }
}

const NOW = Date.parse('2026-06-15T12:00:00Z')

describe('shortId', () => {
  it('drops the launcher prefix', () => {
    expect(shortId('main-session-abcdef12-3456')).toBe('abcdef12')
  })

  it('keeps the first eight characters of a bare id', () => {
    expect(shortId('0123456789abcdef')).toBe('01234567')
  })

  it('handles an id shorter than the cut', () => {
    expect(shortId('abc')).toBe('abc')
  })
})

describe('formatAge', () => {
  it('describes recent times', () => {
    expect(formatAge(NOW, NOW)).toBe('just now')
    expect(formatAge(NOW - 30_000, NOW)).toBe('just now')
  })

  it('counts minutes, hours, and days', () => {
    expect(formatAge(NOW - 12 * 60_000, NOW)).toBe('12m')
    expect(formatAge(NOW - 3 * 3_600_000, NOW)).toBe('3h')
    expect(formatAge(NOW - 2 * 86_400_000, NOW)).toBe('2d')
  })

  it('falls back to a date for something old', () => {
    const old = Date.parse('2020-03-04T05:06:07Z')
    expect(formatAge(old, NOW)).toBe('2020-03-04')
  })

  it('never reports a negative age', () => {
    expect(formatAge(NOW + 10_000, NOW)).toBe('just now')
  })
})

describe('formatWorkspace', () => {
  it('collapses the home directory', () => {
    expect(formatWorkspace('/home/dev/project', '/home/dev')).toBe('~/project')
  })

  it('shortens a deep path to its last two segments', () => {
    expect(formatWorkspace('/a/b/c/d/e', undefined)).toBe('…/d/e')
  })

  it('leaves a shallow path alone', () => {
    expect(formatWorkspace('/a/b', undefined)).toBe('/a/b')
  })

  it('is empty for a missing path', () => {
    expect(formatWorkspace(undefined, '/home/dev')).toBe('')
    expect(formatWorkspace('', '/home/dev')).toBe('')
  })
})

describe('sessionLabel', () => {
  it('prefers the title', () => {
    expect(sessionLabel(session({ title: 'Refactor the parser', firstPrompt: 'ignored' })))
      .toBe('Refactor the parser')
  })

  it('falls back to the first prompt, collapsed to one line', () => {
    expect(sessionLabel(session({ firstPrompt: 'why is\n  the  parser slow' })))
      .toBe('why is the parser slow')
  })

  it('truncates a long prompt', () => {
    const label = sessionLabel(session({ firstPrompt: 'x'.repeat(200) }))
    expect(label).toHaveLength(60)
    expect(label.endsWith('…')).toBe(true)
  })

  it('falls back to the short id when there is nothing else', () => {
    expect(sessionLabel(session())).toBe('aaaaaaaa')
  })

  it('ignores a blank title rather than showing an empty row', () => {
    expect(sessionLabel(session({ title: '   ' }))).toBe('aaaaaaaa')
  })

  it('ignores a blank prompt', () => {
    expect(sessionLabel(session({ firstPrompt: '  ' }))).toBe('aaaaaaaa')
  })
})

describe('isResumable', () => {
  it('requires the session to be persisted', () => {
    expect(isResumable(session({ persisted: true }))).toBe(true)
    expect(isResumable(session({ persisted: false }))).toBe(false)
  })

  it('treats a live session as resumable', () => {
    // Live implies persisted in practice; the flag is the honest answer either
    // way, because `--resume` re-reads from storage.
    expect(isResumable(session({ live: true, persisted: true }))).toBe(true)
  })
})

describe('buildSessionRows', () => {
  it('orders newest first', () => {
    const rows = buildSessionRows([
      session({ id: 'old', createdAt: 100 }),
      session({ id: 'new', createdAt: 300 }),
      session({ id: 'mid', createdAt: 200 }),
    ], { now: NOW })
    expect(rows.map(row => row.id)).toEqual(['new', 'mid', 'old'])
  })

  it('marks the current, live, and gone sessions differently', () => {
    const rows = buildSessionRows([
      session({ id: 'current', createdAt: 4 }),
      session({ id: 'live', createdAt: 3, live: true }),
      session({ id: 'stored', createdAt: 2 }),
      session({ id: 'gone', createdAt: 1, persisted: false }),
    ], { currentId: 'current', now: NOW })
    expect(rows.map(row => row.marker)).toEqual(['▸', '●', '·', '×'])
  })

  it('reports which rows can be resumed', () => {
    const rows = buildSessionRows([
      session({ id: 'a', createdAt: 2, persisted: true }),
      session({ id: 'b', createdAt: 1, persisted: false }),
    ], { now: NOW })
    expect(rows.map(row => row.resumable)).toEqual([true, false])
  })

  it('puts the workspace and the age in the detail column', () => {
    const rows = buildSessionRows([
      session({ cwd: '/home/dev/project', createdAt: NOW - 3 * 3_600_000 }),
    ], { now: NOW, home: '/home/dev' })
    expect(rows[0]?.detail).toBe('~/project · 3h')
  })

  it('keeps a workspace outside the home directory intact', () => {
    const rows = buildSessionRows([
      session({ cwd: '/srv/work', createdAt: NOW }),
    ], { now: NOW, home: '/home/dev' })
    expect(rows[0]?.detail).toBe('/srv/work · just now')
  })

  it('omits a missing workspace from the detail column', () => {
    const rows = buildSessionRows([session({ createdAt: NOW })], { now: NOW })
    expect(rows[0]?.detail).toBe('just now')
  })

  it('honours the row limit', () => {
    const many = Array.from({ length: 20 }, (_, index) => session({ id: `s${index}`, createdAt: index }))
    expect(buildSessionRows(many, { now: NOW, limit: 5 })).toHaveLength(5)
  })

  it('breaks a created-at tie by id, so the order cannot change between frames', () => {
    const at = 500
    const rows = buildSessionRows([
      session({ id: 'b', createdAt: at }),
      session({ id: 'a', createdAt: at }),
    ], { now: NOW })
    // Sort must be deterministic, or a keyboard-driven list reorders under the
    // cursor between frames.
    expect(rows.map(row => row.id)).toEqual(['a', 'b'])
    expect(buildSessionRows([
      session({ id: 'a', createdAt: at }),
      session({ id: 'b', createdAt: at }),
    ], { now: NOW }).map(row => row.id)).toEqual(['a', 'b'])
  })

  it('handles an empty corpus', () => {
    expect(buildSessionRows([], { now: NOW })).toEqual([])
  })
})

describe('describeSessionRow', () => {
  it('explains a resumable session', () => {
    const rows = buildSessionRows([session({ id: 'abc12345' })], { now: NOW })
    expect(describeSessionRow(rows[0])).toContain('abc12345')
    expect(describeSessionRow(rows[0])).toContain('Enter resumes')
  })

  it('explains why a row cannot be resumed', () => {
    const rows = buildSessionRows([session({ id: 'abc', persisted: false })], { now: NOW })
    expect(describeSessionRow(rows[0])).toContain('nothing to resume')
  })

  it('handles no selection', () => {
    expect(describeSessionRow(undefined)).toBe('No session selected.')
  })
})
