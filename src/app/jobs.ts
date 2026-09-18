/**
 * The job list: background work the agent started, folded into rows.
 *
 * A structural subset of the harness's `JobSnapshot` — every field here
 * exists on the real record with the same name, so live snapshots pass
 * through with no mapping and this module stays free of harness imports
 * (the same discipline `sessions.ts` follows). A job is born when a tool
 * such as bash runs with `run_in_background`; it outlives the turn that
 * started it, which is exactly why it deserves a window of its own.
 * @module @dsh-tvision/dsh-tvision/app/jobs
 */

import { formatAge } from './sessions.ts'

/** One background job, as the registry reports it. */
export interface JobSummary {
  /** The registry's id, `<kind>-N`. */
  readonly id: string
  /** What kind of job it is, e.g. `bash` or `subagent`. */
  readonly kind: string
  /** The human label — for bash, the command line. */
  readonly label: string
  /** Where the job is in its lifecycle. */
  readonly status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  /** Extra status detail, when the registry has any. */
  readonly detail?: string
  /** Epoch milliseconds the job started. */
  readonly startedAt: number
  /** Epoch milliseconds the job finished, once it has. */
  readonly finishedAt?: number
}

/** One row of the Jobs window. */
export interface JobRow {
  /** The command or label, as the list shows it. */
  readonly label: string
  /** Right-aligned detail: the status word and the age. */
  readonly detail: string
  /** The marker column, by status. */
  readonly marker: string
  /** The job this row describes. */
  readonly id: string
  /** Whether the row's job can still be killed. */
  readonly killable: boolean
}

/**
 * Fold jobs into the rows the window shows.
 * @param jobs - The jobs, in any order.
 * @param now - Current time, for the age column (default the wall clock).
 * @returns Rows, newest first.
 */
export function buildJobRows(jobs: readonly JobSummary[], now = Date.now()): JobRow[] {
  return [...jobs]
    // Newest first, id as the tiebreaker: a stable order matters to a list you
    // are about to press `k` on.
    .sort((a, b) => (b.startedAt - a.startedAt) || a.id.localeCompare(b.id))
    .map(job => ({
      label: job.label,
      detail: `${statusWord(job.status)} · ${formatAge(job.finishedAt ?? job.startedAt, now)}`,
      marker: statusMarker(job.status),
      id: job.id,
      killable: job.status === 'running' || job.status === 'stopping',
    }))
}

/**
 * The one-line summary the status line shows for a selection.
 * @param row - The row, if any.
 * @returns A description.
 */
export function describeJobRow(row: JobRow | undefined): string {
  if (row === undefined) return 'No job selected.'
  const verb = row.killable ? 'k kills it' : 'it has finished'
  return `${row.id} — ${verb}.`
}

/** The status word, spelled for the detail column. */
function statusWord(status: JobSummary['status']): string {
  switch (status) {
    case 'running':
      return 'running'
    case 'stopping':
      return 'stopping'
    case 'completed':
      return 'done'
    case 'killed':
      return 'killed'
    case 'failed':
      return 'failed'
    /* c8 ignore next 2 -- the union is exhaustive. */
    default:
      return status
  }
}

/** The marker glyph, by status. */
function statusMarker(status: JobSummary['status']): string {
  switch (status) {
    case 'running':
      return '▸'
    case 'stopping':
      return '·'
    case 'completed':
      return '✓'
    case 'killed':
      return '×'
    case 'failed':
      return '!'
    /* c8 ignore next 2 -- the union is exhaustive. */
    default:
      return '·'
  }
}
