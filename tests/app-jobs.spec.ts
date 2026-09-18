/**
 * Jobs window tests.
 *
 * The registry itself is a service the harness owns; these tests pin the fold
 * (snapshots → rows), the window plumbing (setJobs → rows/title), and the
 * `k`-to-kill seam against a fake host. The live subscription is exercised at
 * L2/L3 — a composition without the service must leave the window empty.
 */
import { describe, expect, it } from 'vitest'
import { buildJobRows, describeJobRow, type JobSummary } from '../src/app/jobs.ts'
import { TvisionApp, WINDOW_IDS } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { findSkin } from '../src/kit/skin.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const NOW = 1_789_670_000_000

/** A job with defaults filled for brevity. */
const job = (overrides: Partial<JobSummary> & { id: string; label: string }): JobSummary => ({
  kind: 'bash',
  status: 'running',
  startedAt: NOW - 60_000,
  ...overrides,
})

describe('buildJobRows', () => {
  it('marks each status and ages from the finish when there is one', () => {
    const rows = buildJobRows([
      job({ id: 'bash-1', label: 'npm watch', status: 'running' }),
      job({ id: 'bash-2', label: 'npm test', status: 'completed', finishedAt: NOW - 5_000 }),
      job({ id: 'bash-3', label: 'bad build', status: 'failed', finishedAt: NOW - 10_000 }),
      job({ id: 'bash-4', label: 'stopped', status: 'killed', finishedAt: NOW - 20_000 }),
      job({ id: 'bash-5', label: 'winding down', status: 'stopping' }),
    ], NOW)
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    expect(byId['bash-1']?.marker).toBe('▸')
    expect(byId['bash-1']?.killable).toBe(true)
    expect(byId['bash-1']?.detail).toContain('running · 1m')
    expect(byId['bash-2']?.marker).toBe('✓')
    expect(byId['bash-2']?.killable).toBe(false)
    expect(byId['bash-2']?.detail).toContain('done · ')
    expect(byId['bash-3']?.marker).toBe('!')
    expect(byId['bash-4']?.marker).toBe('×')
    expect(byId['bash-5']?.marker).toBe('·')
    // Newest first.
    expect(rows[0]?.id).toBe('bash-1')
  })

  it('describes a selection for the status line', () => {
    const row = buildJobRows([job({ id: 'bash-1', label: 'x' })], NOW)[0]
    expect(describeJobRow(row)).toContain('k kills it')
    expect(describeJobRow(undefined)).toBe('No job selected.')
  })
})

describe('the jobs window', () => {
  /** An app with the kill seam recorded. */
  function build(): { app: TvisionApp; killed: string[] } {
    const terminal = new HeadlessTerminal(100, 30)
    const killed: string[] = []
    const host: AppHost = {
      send: () => {},
      quit: () => {},
      killJob: (id) => { killed.push(id) },
    }
    const app = new TvisionApp({
      terminal: {
        get columns(): number { return 100 },
        get rows(): number { return 30 },
        write: (data) => terminal.write(data),
      },
      host,
      info: { name: 'tvision', version: '0', sessionId: 's', cwd: '/tmp' },
      skin: findSkin('tvision')!,
    })
    app.start()
    return { app, killed }
  }

  it('setJobs fills the window and its title', () => {
    const { app } = build()
    app.setJobs([job({ id: 'bash-1', label: 'sleep 30' })])
    app.frame()
    expect(app.listRowsFor(WINDOW_IDS.jobs)).toContain('sleep 30')
    expect(app.windows.get(WINDOW_IDS.jobs)?.title).toBe('Jobs — 1')
  })

  it('k on a running job asks, and confirm kills through the host', async () => {
    const { app, killed } = build()
    app.setJobs([job({ id: 'bash-7', label: 'sleep 60' })])
    app.openWindow(WINDOW_IDS.jobs)
    app.frame()
    app.feed('k')
    await Promise.resolve()
    app.frame()
    const dialog = app.windows.all().find(window => window.title === 'Kill job')
    expect(dialog).toBeDefined()
    // Cancel is the safe default; Tab cycles onto Kill before Enter.
    app.feed('\t')
    app.feed('\r')
    // The kill resumes through two promise continuations (settle → ask).
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(killed).toEqual(['bash-7'])
  })

  it('k on a finished job does nothing', async () => {
    const { app, killed } = build()
    app.setJobs([job({ id: 'bash-9', label: 'old thing', status: 'completed', finishedAt: NOW })])
    app.openWindow(WINDOW_IDS.jobs)
    app.frame()
    app.feed('k')
    await Promise.resolve()
    app.frame()
    expect(killed).toEqual([])
    expect(app.windows.all().some(window => !window.closed && window.title === 'Kill job')).toBe(false)
  })
})
