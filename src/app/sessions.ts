/**
 * The session list: resumable sessions, newest first, with their titles.
 *
 * Kept as a pure fold over a small record shape rather than reading the query
 * service directly, for one reason worth stating: the interesting behaviour here
 * is the *fallback*. A session may have a title, or only its first prompt, or
 * neither — and a list where some rows are blank is worse than a list with a
 * less precise label, so the fallback chain is the thing to test.
 *
 * Titles also cost I/O: reading one means reading a session's log. So the
 * caller fetches them for the visible page only, and a row without one is
 * shown with its id until the title lands rather than blocking the window.
 * @module dsh-tvision/app/sessions
 */

import { truncate } from '../kit/text.ts'

/** One session as the list needs it. */
export interface SessionSummary {
  /** The session id, which is also what `--resume` takes. */
  readonly id: string
  /** Epoch milliseconds the session was created. */
  readonly createdAt: number
  /** The workspace the session ran in, if recorded. */
  readonly cwd?: string
  /** Whether the session is currently live in this process. */
  readonly live: boolean
  /** Whether a persistence backend still has it. */
  readonly persisted: boolean
  /** The last known title, if one has been read. */
  readonly title?: string
  /** The first human prompt, used when there is no title. */
  readonly firstPrompt?: string
}

/** One row of the Sessions window. */
export interface SessionRow {
  /** The row's label: the title, or the best available stand-in. */
  readonly label: string
  /** Right-aligned detail: the workspace and the age. */
  readonly detail: string
  /** The marker column: which session is current, which are live. */
  readonly marker: string
  /** The session this row resumes. */
  readonly id: string
  /** Whether `--resume` can do anything with it. */
  readonly resumable: boolean
}

/** How the list is presented. */
export interface SessionListOptions {
  /** The id of the session this process is running, marked with `▸`. */
  readonly currentId?: string
  /** Current time, for the age column. */
  readonly now?: number
  /** Maximum rows (default 100). */
  readonly limit?: number
  /** The home directory, so a workspace beneath it renders as `~/…`. */
  readonly home?: string
}

/**
 * Shorten an id for display.
 *
 * Session ids are UUIDs, and a column of them is unreadable. Eight characters is
 * enough to tell two apart in a list of a few dozen and short enough to read.
 * @param id - The full id.
 * @returns A stable short form.
 */
export function shortId(id: string): string {
  // `main-session-<uuid>` is the launcher's fresh-session shape; the uuid is the
  // informative part, so skip the prefix.
  const prefix = 'main-session-'
  const trimmed = id.startsWith(prefix) ? id.slice(prefix.length) : id
  return trimmed.slice(0, 8)
}

/**
 * Describe how long ago something happened.
 * @param then - Epoch milliseconds.
 * @param now - Current time.
 * @returns `just now`, `12m`, `3h`, `2d`, or a date.
 */
export function formatAge(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(then).toISOString().slice(0, 10)
}

/**
 * Shorten a workspace path for the detail column.
 * @param cwd - The absolute path, if any.
 * @param home - The home directory, collapsed to `~`.
 * @returns A short label, or an empty string.
 */
export function formatWorkspace(cwd: string | undefined, home: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  if (home !== undefined && home !== '' && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`
  const parts = cwd.split('/').filter(part => part !== '')
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`
}

/**
 * Choose the best label for a session.
 *
 * The chain is title, then first prompt, then the short id. A blank row is the
 * one outcome worth avoiding, because it makes the list look broken rather than
 * merely terse.
 * @param session - The session.
 * @returns The label.
 */
export function sessionLabel(session: SessionSummary): string {
  const title = session.title?.trim()
  if (title !== undefined && title !== '') return title
  const prompt = session.firstPrompt?.trim().replace(/\s+/gu, ' ')
  if (prompt !== undefined && prompt !== '') {
    // By columns, not code units: a UTF-16 cut can split a surrogate pair and
    // show U+FFFD in a column of otherwise-clean ids.
    return truncate(prompt, 60)
  }
  return shortId(session.id)
}

/**
 * Whether a session can actually be resumed.
 *
 * Report this honestly rather than offering every row: a "resume" that fails
 * after the process has torn down its terminal is much worse than a dimmed row.
 * @param session - The session.
 * @returns True when `--resume <id>` has something to load.
 */
export function isResumable(session: SessionSummary): boolean {
  return session.persisted
}

/**
 * Fold sessions into the rows the window shows.
 * @param sessions - The sessions, in any order.
 * @param options - Current id, clock, and row budget.
 * @returns Rows, newest first.
 */
export function buildSessionRows(
  sessions: readonly SessionSummary[],
  options: SessionListOptions = {},
): SessionRow[] {
  const now = options.now ?? Date.now()
  const limit = options.limit ?? 100
  return [...sessions]
    // Id as the tiebreaker: two sessions can share a creation millisecond, and an
    // unstable order would move the row under the cursor between frames.
    .sort((a, b) => (b.createdAt - a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(session => {
      const resumable = isResumable(session)
      const detailParts = [
        formatWorkspace(session.cwd, options.home),
        formatAge(session.createdAt, now),
      ].filter(part => part !== '')
      return {
        label: sessionLabel(session),
        detail: detailParts.join(' · '),
        // Three states worth distinguishing at a glance: the one you are in, one
        // you could switch to, and one that is gone.
        marker: session.id === options.currentId ? '▸' : session.live ? '●' : resumable ? '·' : '×',
        id: session.id,
        resumable,
      }
    })
}

/**
 * The one-line summary the status line shows for a selection.
 * @param row - The row, if any.
 * @returns A description.
 */
export function describeSessionRow(row: SessionRow | undefined): string {
  if (row === undefined) return 'No session selected.'
  if (!row.resumable) return `${row.id} — not persisted; there is nothing to resume.`
  return `${row.id} — Enter resumes it; this process is replaced.`
}
