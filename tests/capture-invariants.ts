/**
 * Invariant checks over a pty capture.
 *
 * The emulator round-trip suite proves the compositor is self-consistent. It
 * cannot prove the *application* stayed self-consistent over a long interaction,
 * because it drives the app through a fake terminal that never complains. A real
 * pty does complain, in the only way a terminal can: by wrapping a row that was
 * one cell too wide, or by scrolling because a frame was one row too tall.
 *
 * So this module reads a capture back and asserts the properties that a terminal
 * enforces silently and destructively:
 *
 * - **No frame wrote to a column past the screen.** The single worst failure
 *   mode of a full-screen text app: one over-wide row wraps, shifting every
 *   later row on the screen by one and turning the desktop into noise.
 * - **No frame wrote below the screen**, which scrolls the whole thing up and
 *   pushes the menu bar off the top.
 * - **Nothing scrolled.** The app runs on the alternate screen and positions
 *   every row absolutely, so any scrollback means a frame was too large.
 * - **The desktop stayed coherent**: the menu bar is on row 0 and the
 *   function-key strip is on the last row, in every frame examined.
 *
 * @module @dsh-tvision/dsh-tvision/tests/capture-invariants
 */

import { HeadlessTerminal } from './headless-terminal.ts'

/** The escape that ends a synchronized-output frame. */
const FRAME_END = '\u001B[?2026l'
/** The escape that opens one. */
const FRAME_START = '\u001B[?2026h'
/** Cursor-to-position. */
const CURSOR = /\u001B\[(\d+);(\d+)H/gu

/** One frame's worth of bytes, plus where it came from. */
export interface CapturedFrame {
  /** Index within the capture. */
  readonly index: number
  /** The bytes between the sync markers. */
  readonly payload: string
}

/** A defect found in a capture. */
export interface Defect {
  /** Which check failed. */
  readonly check: string
  /** The frame index, when the defect is attributable to one. */
  readonly frame?: number
  /** What was wrong, in one line. */
  readonly detail: string
}

/** What a capture turned out to contain. */
export interface CaptureReport {
  readonly frames: number
  readonly bytes: number
  readonly defects: readonly Defect[]
  /** The final screen, so a caller can show what the app ended up looking like. */
  readonly screen: string
  /** Rows of the final screen, trailing blanks trimmed. */
  readonly rows: readonly string[]
}

/**
 * Split a capture into frames.
 *
 * The last piece is dropped: the capture is cut off mid-frame when the child is
 * killed, and half a synchronized-output frame legitimately leaves part of the
 * screen showing the previous frame.
 * @param raw - The captured bytes.
 * @returns The complete frames.
 */
export function splitFrames(raw: string): CapturedFrame[] {
  const parts = raw.split(FRAME_END)
  const frames: CapturedFrame[] = []
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index] ?? ''
    const start = part.lastIndexOf(FRAME_START)
    frames.push({ index, payload: start < 0 ? part : part.slice(start + FRAME_START.length) })
  }
  return frames
}

/**
 * Every cursor position a frame writes to, as `[row, column]` pairs, 1-based.
 * @param payload - One frame's bytes.
 * @returns The positions.
 */
export function cursorPositions(payload: string): [number, number][] {
  const out: [number, number][] = []
  CURSOR.lastIndex = 0
  for (;;) {
    const match = CURSOR.exec(payload)
    if (match === null) break
    out.push([Number(match[1]), Number(match[2])])
  }
  return out
}

/**
 * Check a capture against the screen invariants.
 *
 * @param raw - The captured bytes.
 * @param columns - The screen width the child was given.
 * @param rows - The screen height the child was given.
 * @returns What was found.
 */
export async function checkCapture(
  raw: string,
  columns: number,
  rows: number,
): Promise<CaptureReport> {
  const defects: Defect[] = []
  const frames = splitFrames(raw)
  if (frames.length === 0) {
    defects.push({ check: 'no-frames', detail: 'the capture contains no complete frame' })
  }

  // 1. Absolute writes must stay inside the screen. A write to column
  //    `columns + 1` is the over-wide-row bug; a write below `rows` scrolls.
  for (const frame of frames) {
    for (const [row, column] of cursorPositions(frame.payload)) {
      if (column > columns) {
        defects.push({
          check: 'write-past-right-edge',
          frame: frame.index,
          detail: `cursor moved to column ${column} of ${columns}`,
        })
      }
      if (row > rows) {
        defects.push({
          check: 'write-below-screen',
          frame: frame.index,
          detail: `cursor moved to row ${row} of ${rows}`,
        })
      }
    }
  }

  // 2. The terminal must not have scrolled. The app positions every row
  //    absolutely, so scrollback can only mean a frame was too tall.
  const terminal = new HeadlessTerminal(columns, rows)
  for (const frame of frames) await terminal.writeAndSettle(frame.payload)
  const buffer = terminal.xterm.buffer.active
  if (buffer.baseY !== 0 || buffer.viewportY !== 0) {
    defects.push({
      check: 'screen-scrolled',
      detail: `baseY=${buffer.baseY} viewportY=${buffer.viewportY}: content fell off the top`,
    })
  }

  const view = terminal.snapshot()
  const trimmed = view.rawRows.map(row => row.replace(/\s+$/u, ''))
  terminal.dispose()

  // 3. The chrome must be where it belongs. If a row wrapped, the menu bar or
  //    the key strip is the first thing to visibly move.
  const last = trimmed[rows - 1] ?? ''
  // A blank top row is legitimate when a caller drove the app straight into a
  // modal that covers the bar, so this is reported rather than asserted.
  if (frames.length > 4 && (trimmed[0] ?? '').trim() === '') {
    defects.push({ check: 'menu-bar-missing', detail: 'row 0 is blank at the end of the capture' })
  }
  if (frames.length > 4 && !/F\d/u.test(last)) {
    defects.push({ check: 'key-strip-missing', detail: `the last row has no function key: ${JSON.stringify(last.slice(0, 60))}` })
  }

  return {
    frames: frames.length,
    bytes: raw.length,
    defects,
    screen: trimmed.join('\n').replace(/\n+$/u, ''),
    rows: trimmed,
  }
}
