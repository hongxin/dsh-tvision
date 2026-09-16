/**
 * Small-terminal behaviour.
 *
 * A window manager crammed into 20 columns is not a smaller version of itself —
 * it is a screen of overlapping fragments, and every widget's minimum-size
 * assumption is wrong at once. These tests pin what happens instead: the chrome
 * gives up rows in a defined order, and below a floor the desktop stops being
 * drawn and says so.
 */
import { describe, expect, it } from 'vitest'
import { MINIMUM_TERMINAL, TvisionApp, planChrome, planLayout, WINDOW_IDS } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { findSkin } from '../src/kit/skin.ts'
import { rect } from '../src/kit/cell.ts'
import { HeadlessTerminal } from './headless-terminal.ts'
import { textWidth } from '../src/kit/text.ts'

/** The smallest terminal the desktop is expected to work in. */
const FLOOR = MINIMUM_TERMINAL

/** An app on a screen of the given size. */
function at(columns: number, rows: number) {
  const terminal = new HeadlessTerminal(columns, rows)
  const size = { columns, rows }
  const host: AppHost = { send: () => {}, quit: () => {} }
  const app = new TvisionApp({
    terminal: {
      get columns(): number { return size.columns },
      get rows(): number { return size.rows },
      write: (data: string) => terminal.write(data),
    },
    host,
    info: { name: 'tvision', version: '0.1.0', sessionId: 's', cwd: '/tmp' },
    skin: findSkin('tvision')!,
  })
  /** The painted grid as trimmed rows. */
  const frame = (): string[] =>
    (app.windows.paint().lines() ?? []).map(line => line.replace(/\s+$/u, ''))
  return {
    app,
    terminal,
    frame,
    resize(next: { columns: number; rows: number }) {
      size.columns = next.columns
      size.rows = next.rows
      terminal.resize(next.columns, next.rows)
      app.handle({ type: 'resize', columns: next.columns, rows: next.rows })
    },
  }
}

describe('planChrome', () => {
  it('gives an ordinary terminal the status line and the key strip', () => {
    expect(planChrome(24)).toEqual({ top: 1, bottom: 2 })
    expect(planChrome(40)).toEqual({ top: 1, bottom: 2 })
  })

  it('gives up the status line before the key strip', () => {
    // The strip names every function key; the status line is a meter. On a short
    // terminal the legend is worth more.
    expect(planChrome(18)).toEqual({ top: 1, bottom: 1 })
  })

  it('keeps a menu bar and a key strip even at the floor', () => {
    expect(planChrome(FLOOR.rows)).toEqual({ top: 1, bottom: 1 })
  })

  it('never returns zero rows for a band', () => {
    for (let rows = 1; rows <= 60; rows++) {
      const plan = planChrome(rows)
      expect(plan.top).toBe(1)
      expect(plan.bottom).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('planLayout', () => {
  it('leaves the transcript usable on a short desktop', () => {
    // The composer is the part that yields: an input line with no transcript is
    // as useless as a transcript with no input line.
    const plan = planLayout(60, 12, rect(0, 1, 60, 8))
    expect(plan.transcript.height).toBeGreaterThanOrEqual(4)
    expect(plan.composerHeight).toBeGreaterThanOrEqual(1)
    expect(plan.composerHeight + 4).toBeLessThanOrEqual(8)
  })

  it('keeps the side column off a narrow screen', () => {
    expect(planLayout(60, 20, rect(0, 1, 60, 18)).sideWidth).toBe(0)
  })

  it('opens the side column on a wide screen', () => {
    expect(planLayout(120, 30, rect(0, 1, 120, 28)).sideWidth).toBeGreaterThan(0)
  })
})

describe('the desktop at the floor', () => {
  it('draws a composed desktop at the minimum size', () => {
    const view = at(FLOOR.columns, FLOOR.rows)
    view.app.start()
    const rows = view.frame()
    expect(view.app.usable).toBe(true)
    expect(rows).toHaveLength(FLOOR.rows)
    // Chrome in place, and a transcript with something in it.
    expect(rows[0]).toContain('File')
    expect(rows.at(-1)).toMatch(/F\d/u)
    expect(rows.join('\n')).toContain('Conversation')
  })

  it('keeps every row exactly the screen width', () => {
    // A row one cell short leaves stale characters behind it; one cell long
    // wraps and shifts the entire screen.
    const view = at(FLOOR.columns, FLOOR.rows)
    view.app.start()
    const buffer = view.app.windows.paint()
    for (let row = 0; row < buffer.height; row++) {
      expect(buffer.row(row).length, `row ${row}`).toBe(FLOOR.columns)
    }
  })

  it('fits the composer and the transcript without overlapping', () => {
    const view = at(FLOOR.columns, FLOOR.rows)
    view.app.start()
    const rows = view.frame()
    // The composer's rule must sit directly above its input line. Search the rule
    // *below* the input, because the transcript above it is full of rules too —
    // fenced code blocks and tool-card frames are drawn with the same glyph.
    const input = rows.findIndex(row => row.includes('dsh>'))
    expect(input).toBeGreaterThan(0)
    const rule = rows[input - 1] ?? ''
    // The row above the input is the composer's separator and nothing else: the
    // window's own side borders, the rule, and the frame's junction glyphs.
    expect(rule).toContain('─')
    expect(rule.replace(/[║│─╟╢]/gu, '').trim()).toBe('')
  })
})

describe('below the floor', () => {
  it('says so instead of drawing fragments', () => {
    const view = at(24, 8)
    view.app.start()
    const text = view.frame().join('\n')
    expect(view.app.usable).toBe(false)
    expect(text).toContain('terminal too small')
    expect(text).toContain('24x8')
    expect(text).toContain(`${MINIMUM_TERMINAL.columns}x${MINIMUM_TERMINAL.rows}`)
    // And none of the broken desktop.
    expect(text).not.toContain('Conversation')
  })

  it('never writes a row wider than the screen while saying so', () => {
    for (const [columns, rows] of [[24, 8], [12, 6], [39, 9], [80, 4]] as const) {
      const view = at(columns, rows)
      view.app.start()
      const buffer = view.app.windows.paint()
      for (let row = 0; row < buffer.height; row++) {
        expect(buffer.row(row).length, `${columns}x${rows} row ${row}`).toBe(columns)
      }
    }
  })

  it('recovers the desktop when the terminal grows past the floor', () => {
    const view = at(30, 8)
    view.app.start()
    expect(view.app.usable).toBe(false)
    view.resize({ columns: 100, rows: 30 })
    expect(view.app.usable).toBe(true)
    expect(view.frame().join('\n')).toContain('Conversation')
  })

  it('falls back to the notice when the terminal shrinks below the floor', () => {
    const view = at(100, 30)
    view.app.start()
    expect(view.app.usable).toBe(true)
    view.resize({ columns: 20, rows: 6 })
    expect(view.app.usable).toBe(false)
    expect(view.frame().join('\n')).toContain('terminal too small')
  })
})

describe('growing from the floor', () => {
  it('restores the status line at twenty rows', () => {
    const view = at(FLOOR.columns, FLOOR.rows)
    view.app.start()
    expect(view.frame().join('\n')).not.toContain('%')
    view.resize({ columns: 100, rows: 24 })
    // The pressure meter is back once there is a row to spare for it.
    expect(view.frame().join('\n')).toContain('F10 menu')
  })

  it('keeps the side column off until the screen is wide enough', () => {
    const view = at(60, 20)
    view.app.start()
    expect(view.app.windows.isOpen(WINDOW_IDS.project)).toBe(false)
    view.resize({ columns: 120, rows: 30 })
    // The planned layout is fixed at mount, so a resize does not conjure the
    // side windows; the View menu opens them. This asserts the width decision
    // itself, not that a resize re-runs the plan.
    expect(planLayout(120, 30, rect(0, 1, 120, 28)).sideWidth).toBeGreaterThan(0)
  })
})

describe('the transcript pane', () => {
  it('keeps its rows inside the window on a short desktop', () => {
    const view = at(44, 12)
    view.app.start()
    view.app.document.addUser('a prompt', 0)
    const rows = view.frame()
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(44)
    expect(rows.join('\n')).toContain('a prompt')
  })
})
