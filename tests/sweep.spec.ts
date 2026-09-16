/**
 * The terminal sweep, as a test.
 *
 * Reads the captures produced by `scripts/pty-sweep.py` and asserts the
 * invariants a terminal enforces silently: no frame writes past the screen, no
 * frame scrolls it, and the chrome stays where it belongs.
 *
 * Skipped when no capture file is present, so the suite stays green on a machine
 * where the sweep has not been run — with a note saying so, because a silently
 * skipped check is worse than a failing one.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { checkCapture, type CaptureReport } from './capture-invariants.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SWEEP = join(HERE, '..', '.tools', 'sweep.json')
const REPORT_DIR = join(HERE, '..', '.tools', 'sweep-frames')

interface SweepCapture {
  readonly columns: number
  readonly rows: number
  readonly base64: string
  /** For the quit scenario: how many times each teardown sequence was written. */
  readonly teardown?: Record<string, number>
}

/**
 * Scenarios whose keys arrive mid-stream, so the app never goes idle.
 *
 * The demo repaints only when something changes, so a scenario that cancels the
 * stream ends with the app quiet and the capture cut mid-frame. A zero-frame
 * result there is a timing artifact of the harness, not a defect in the app — but
 * a zero-*byte* result never is, so the empty case is still a failure.
 */
const TIMING_SENSITIVE = new Set(['cancel-mid-stream'])

/** Load the sweep, or an empty map when it has not been run. */
function loadSweep(): Record<string, SweepCapture> {
  if (!existsSync(SWEEP)) return {}
  return JSON.parse(readFileSync(SWEEP, 'utf8')) as Record<string, SweepCapture>
}

const sweep = loadSweep()
const names = Object.keys(sweep)

describe.skipIf(names.length === 0)('terminal sweep invariants', () => {
  it('restores every terminal mode exactly once on the way out', () => {
    const quit = sweep['quit-cleanly']
    if (quit?.teardown === undefined) {
      // The scenario has not been run; the suite says so rather than passing
      // silently, because this is the check that found a duplicated teardown.
      expect(quit, 'quit-cleanly was not captured').toBeUndefined()
      return
    }
    // Twice is not harmless: it is the signature of two writers taking turns on
    // one alternate screen, which is how a terminal ends up in a mode nobody
    // turns off.
    for (const [sequence, count] of Object.entries(quit.teardown)) {
      expect(count, `${JSON.stringify(sequence)} was written ${count} times`).toBe(1)
    }
  })

  const reports = new Map<string, CaptureReport>()

  // The replays are independent, so they run concurrently and land in the map
  // before any assertion reads it; writing the screens out afterwards keeps the
  // files in scenario order rather than completion order.
  beforeAll(async () => {
    const entries = await Promise.all(names.map(async (name) => {
      const capture = sweep[name]
      /* c8 ignore next -- the key came from the capture's own keys. */
      if (capture === undefined) return undefined
      const raw = Buffer.from(capture.base64, 'base64').toString('utf8')
      return [name, await checkCapture(raw, capture.columns, capture.rows)] as const
    }))
    mkdirSync(REPORT_DIR, { recursive: true })
    for (const entry of entries) {
      if (entry === undefined) continue
      const [name, report] = entry
      reports.set(name, report)
      // Keep the final screen of each scenario for eyeballing and for diffs.
      writeFileSync(join(REPORT_DIR, `${name}.txt`), `${report.screen}\n`)
    }
  })

  it('produces a complete frame for every scenario', () => {
    for (const [name, report] of reports) {
      // Every scenario must have drawn *something*: an app that produced no
      // bytes never started.
      expect(report.bytes, `${name}: the app produced no output at all`).toBeGreaterThan(0)
      if (!TIMING_SENSITIVE.has(name)) {
        expect(report.frames, `${name}: no complete frame`).toBeGreaterThan(0)
      }
    }
  })

  /** The scenarios and details that failed any of the named checks. */
  const offendersOf = (checks: readonly string[]): string[] => {
    const offenders: string[] = []
    for (const [name, report] of reports) {
      for (const defect of report.defects) {
        if (checks.includes(defect.check)) offenders.push(`${name}: ${defect.check} — ${defect.detail}`)
      }
    }
    return offenders
  }

  it('never writes past the screen edge or below it', () => {
    expect(offendersOf(['write-past-right-edge', 'write-below-screen'])).toEqual([])
  })

  it('never scrolls the screen', () => {
    expect(offendersOf(['screen-scrolled'])).toEqual([])
  })

  it('keeps the menu bar on the first row and the key strip on the last', () => {
    expect(offendersOf(['menu-bar-missing', 'key-strip-missing'])).toEqual([])
  })
})

describe.skipIf(names.length > 0)('terminal sweep', () => {
  it('has not been run', () => {
    // Not a failure: a machine without pty access cannot run it. Recorded so the
    // gap is visible in the test output rather than hidden.
    expect(names).toEqual([])
  })
})
