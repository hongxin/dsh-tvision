/**
 * The renderer: turn a {@link CellBuffer} into the smallest ANSI write that
 * makes the real terminal match it.
 *
 * The strategy is a whole-frame diff against the previous frame, emitted
 * inside a synchronized-output bracket (`CSI ? 2026 h`/`l`) so a terminal that
 * supports it never shows a half-drawn window. For each row whose cells
 * changed we emit one cursor move to the first changed column and then write
 * the row from there to its last changed column. Because the write is
 * left-to-right and overwrites in place, insertions and deletions on a line
 * need no special case.
 *
 * There is one deliberate exception to cell-level diffing: a terminal cannot be
 * coloured per cell without a write per cell, so within a changed row we merge
 * adjacent cells that share a style into a single write and only emit an SGR
 * patch when the style actually changes.
 * @module @dsh-tvision/dsh-tvision/kit/screen
 */

import { CellBuffer, PALETTE_LIMIT, styleEquals, type Style } from './cell.ts'
import { isEmptyStyle, SGR_RESET, stylePatch } from './styles.ts'

/** Where the hardware cursor should sit after a frame, in screen coordinates. */
export interface CursorState {
  /** Column, 0-based. */
  readonly x: number
  /** Row, 0-based. */
  readonly y: number
  /** Whether the cursor should be visible at all (false for a pure viewer). */
  readonly visible: boolean
}

/** Hardware cursor instruction: hide it. */
export const HIDDEN_CURSOR: CursorState = Object.freeze({ x: 0, y: 0, visible: false })

/** What one {@link ScreenRenderer.render} call actually wrote. */
export interface RenderStats {
  /** Bytes handed to the terminal. */
  readonly bytes: number
  /** Rows touched. */
  readonly rows: number
  /** Style runs written (one write each). */
  readonly runs: number
}

const EMPTY_STATS: RenderStats = Object.freeze({ bytes: 0, rows: 0, runs: 0 })

/**
 * Convert a 0-based cell coordinate to a 1-based cursor position sequence.
 * @param x - Column.
 * @param y - Row.
 * @returns The `CUP` escape.
 */
export function cursorTo(x: number, y: number): string {
  return `\u001B[${y + 1};${x + 1}H`
}

/**
 * Truecolour detection.
 *
 * A skin may name 24-bit colours unconditionally, but a terminal that cannot
 * render them turns `38;2;r;g;b` into garbage. The renderer therefore
 * downgrades every truecolour to the nearest of the 256 palette indices when
 * the environment does not advertise support. The four skins that are *not*
 * `ansi` are entirely 24-bit, so this is the difference between the Borland
 * blue and whatever a terminal does with an escape it does not understand.
 * @param env - Environment to inspect (defaults to `process.env`).
 * @returns True when 24-bit colour should be emitted.
 */
export function detectTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
  const colorterm = env.COLORTERM?.toLowerCase()
  if (colorterm === 'truecolor' || colorterm === '24bit') return true
  const term = env.TERM?.toLowerCase() ?? ''
  if (term.includes('direct')) return true
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'vscode') return true
  if (env.WT_SESSION !== undefined) return true
  if (env.KITTY_WINDOW_ID !== undefined) return true
  return false
}

/** The xterm 256-colour cube levels; the cube is not linear. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255]

/**
 * Map a 24-bit colour onto the nearest xterm-256 index.
 *
 * Picks whichever of the colour cube and the 24-step greyscale ramp is closer,
 * which matters because the cube has no near-neutral entries and a skin's
 * shadow and chrome colours are always near-neutral.
 * @param rgb - `0xRRGGBB`.
 * @returns An index in `16`–`255`.
 */
export function rgbToAnsi256(rgb: number): number {
  const r = (rgb >> 16) & 0xFF
  const g = (rgb >> 8) & 0xFF
  const b = rgb & 0xFF
  // Greyscale candidate: the ramp runs 8, 18, … 238 as indices 232–255.
  const greyAverage = Math.round((r + g + b) / 3)
  const greyIndex = greyAverage <= 8 ? 0 : greyAverage >= 238 ? 23 : Math.round((greyAverage - 8) / 10)
  const greyValue = 8 + greyIndex * 10
  const greyDistance = (r - greyValue) ** 2 + (g - greyValue) ** 2 + (b - greyValue) ** 2
  // Cube candidate: snap each channel to its nearest cube level.
  const snap = (value: number): number => {
    let best = 0
    let bestDistance = Number.POSITIVE_INFINITY
    for (let index = 0; index < CUBE_LEVELS.length; index++) {
      const distance = Math.abs((CUBE_LEVELS[index] ?? 0) - value)
      if (distance < bestDistance) {
        bestDistance = distance
        best = index
      }
    }
    return best
  }
  const ri = snap(r)
  const gi = snap(g)
  const bi = snap(b)
  const cr = CUBE_LEVELS[ri] ?? 0
  const cg = CUBE_LEVELS[gi] ?? 0
  const cb = CUBE_LEVELS[bi] ?? 0
  const cubeDistance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
  if (greyDistance < cubeDistance) return 232 + greyIndex
  return 16 + 36 * ri + 6 * gi + bi
}

/**
 * A style as it will actually be emitted, with truecolour resolved.
 * @param style - The skin's style.
 * @param truecolor - Whether 24-bit colour is available.
 * @returns A style safe for this terminal; the input object when nothing changed.
 */
export function resolveStyle(style: Style, truecolor: boolean): Style {
  if (truecolor) return style
  // Only the 24-bit half of the colour space needs downgrading; a palette index
  // is already something a 256-colour terminal can render.
  const fg = style.fg !== undefined && style.fg >= PALETTE_LIMIT ? rgbToAnsi256(style.fg) : style.fg
  const bg = style.bg !== undefined && style.bg >= PALETTE_LIMIT ? rgbToAnsi256(style.bg) : style.bg
  if (fg === style.fg && bg === style.bg) return style
  return { ...style, fg, bg }
}

/**
 * The stateful frame emitter.
 *
 * One instance per screen. It remembers the previous frame and the style the
 * terminal is currently in, so successive identical frames cost nothing — a
 * blinking cursor and a ticking clock are the only things that normally change.
 */
export class ScreenRenderer {
  private previous: CellBuffer | undefined
  private activeStyle: Style | undefined
  private lastStats: RenderStats = EMPTY_STATS
  private forceFull = true
  /** Whether truecolour escapes may be emitted. */
  readonly truecolor: boolean

  /**
   * @param truecolor - Whether the terminal supports 24-bit colour.
   */
  constructor(truecolor: boolean) {
    this.truecolor = truecolor
  }

  /** Force the next frame to repaint everything (after a resize or `Ctrl+L`). */
  invalidate(): void {
    this.forceFull = true
    this.previous = undefined
  }

  /**
   * Whether the next frame will be a full repaint regardless of content.
   *
   * The frame loop needs this: after {@link invalidate} the content may be
   * identical to the last frame, so "the desktop changed" is not the right
   * question to ask before painting.
   * @returns True when a repaint is owed.
   */
  get pendingFullRepaint(): boolean {
    return this.forceFull
  }

  /** Statistics for the most recent frame, for the debug overlay and tests. */
  get stats(): RenderStats {
    return this.lastStats
  }

  /**
   * Produce the byte stream that makes `frame` the terminal's content.
   * @param frame - The frame to display. It is retained as the next diff basis,
   * so callers must render a fresh buffer per frame rather than mutating one.
   * @param cursor - Where to park the hardware cursor.
   * @returns The escape sequence to write; `''` when nothing changed.
   */
  render(frame: CellBuffer, cursor: CursorState): string {
    const previous = this.previous
    const sameSize = previous !== undefined
      && previous.width === frame.width
      && previous.height === frame.height
    const diff = sameSize && !this.forceFull ? this.diffAgainst(previous, frame) : undefined
    let out: string
    let rows: number
    let runs: number
    if (diff === undefined) {
      out = this.renderFull(frame)
      rows = frame.height
      runs = this.runCount
    } else {
      out = diff
      rows = this.runCount
      runs = this.runCount
    }
    this.forceFull = false
    const cursorOut = this.renderCursor(cursor)
    this.previous = frame
    this.lastStats = Object.freeze({ bytes: out.length + cursorOut.length, rows, runs })
    if (out === '' && cursorOut === '') return ''
    return `\u001B[?2026h${out}${cursorOut}\u001B[?2026l`
  }

  /** Runs written during the current frame, for stats. */
  private runCount = 0
  /** Last cursor instruction issued, to elide a redundant re-position. */
  private cursorAt: string | undefined
  private cursorVisible = false
  /** Whether any cursor instruction has been issued yet. */
  private cursorInitialized = false

  /**
   * Repaint every row in full. The fallback path, and the only correct thing to
   * do when the frame size changed under us.
   * @param frame - The frame to paint.
   * @returns The escape sequence.
   */
  private renderFull(frame: CellBuffer): string {
    let out = ''
    this.runCount = 0
    for (let y = 0; y < frame.height; y++) {
      out += cursorTo(0, y)
      out += this.renderRow(frame, y, 0, frame.width - 1)
    }
    this.cursorAt = undefined
    return out
  }

  /**
   * Emit only the rows and runs that differ from the previous frame.
   * @param previous - The frame currently on screen.
   * @param frame - The frame to paint.
   * @returns The escape sequence, or `''` when the frames are identical.
   */
  private diffAgainst(previous: CellBuffer, frame: CellBuffer): string {
    let out = ''
    this.runCount = 0
    for (let y = 0; y < frame.height; y++) {
      const base = y * frame.width
      let first = -1
      let last = -1
      for (let x = 0; x < frame.width; x++) {
        const before = previous.cells[base + x]
        const after = frame.cells[base + x]
        /* c8 ignore next -- both grids are fully populated. */
        if (before === undefined || after === undefined) continue
        if (before.char !== after.char || before.wide !== after.wide || !styleEquals(before.style, after.style)) {
          if (first < 0) first = x
          last = x
        }
      }
      if (first < 0) continue
      out += cursorTo(first, y)
      this.cursorAt = undefined
      out += this.renderRow(frame, y, first, last)
    }
    return out
  }

  /**
   * Write one row's span of cells, merging same-styled neighbours into single
   * writes and emitting one SGR patch per style change.
   * @param frame - The frame.
   * @param y - Row.
   * @param from - First column, inclusive.
   * @param to - Last column, inclusive.
   * @returns The escape sequence.
   */
  private renderRow(frame: CellBuffer, y: number, from: number, to: number): string {
    let out = ''
    const base = y * frame.width
    let x = from
    while (x <= to) {
      const cell = frame.cells[base + x]
      /* c8 ignore next -- both grids are fully populated. */
      if (cell === undefined) {
        x++
        continue
      }
      // A wide glyph's trailing column was already painted by its lead, so it
      // contributes nothing to the write. A space that happens to be the
      // trailer of a wide glyph must not be emitted, or the row shifts right.
      if (cell.char === '' && !cell.wide) {
        x++
        continue
      }
      const style = resolveStyle(cell.style, this.truecolor)
      let text = ''
      let cursor = x
      while (cursor <= to) {
        const next = frame.cells[base + cursor]
        /* c8 ignore next -- both grids are fully populated. */
        if (next === undefined) break
        if (next.char === '' && !next.wide) {
          cursor++
          continue
        }
        if (!styleEquals(resolveStyle(next.style, this.truecolor), style)) break
        text += next.char
        cursor++
      }
      out += this.styleEscape(style)
      out += text
      this.runCount++
      x = cursor
    }
    return out
  }

  /**
   * The escape that moves from the terminal's current style into `target`,
   * updating the tracked state.
   * @param target - The style of the run about to be written.
   * @returns The escape sequence, or `''` when the terminal is already there.
   */
  private styleEscape(target: Style): string {
    const current = this.activeStyle
    if (current !== undefined && styleEquals(current, target)) return ''
    const escape = current === undefined
      ? (isEmptyStyle(target) ? SGR_RESET : stylePatch(undefined, target))
      : stylePatch(current, target)
    this.activeStyle = target
    return escape
  }

  /**
   * Park or hide the hardware cursor.
   * @param cursor - The instruction.
   * @returns The escape sequence.
   */
  private renderCursor(cursor: CursorState): string {
    if (!cursor.visible) {
      // Hide on the first frame too: `enter()` hides the cursor before the
      // first paint, but a renderer used without `enter()` (the tests, and any
      // embedding) must still park it out of the way.
      if (!this.cursorVisible && this.cursorInitialized) return ''
      this.cursorVisible = false
      this.cursorInitialized = true
      this.cursorAt = undefined
      return '\u001B[?25l'
    }
    const at = `${cursor.x},${cursor.y}`
    if (this.cursorVisible && this.cursorAt === at) return ''
    this.cursorVisible = true
    this.cursorInitialized = true
    this.cursorAt = at
    return `${cursorTo(cursor.x, cursor.y)}\u001B[?25h`
  }

  /**
   * The escape sequences that enter the full-screen session: alternate screen,
   * hidden cursor, mouse reporting, bracketed paste.
   * @param options - `mouse` enables SGR mouse reporting (default true).
   * @returns The escape sequence.
   */
  static enter(options: { mouse?: boolean } = {}): string {
    const mouse = options.mouse ?? true
    let out = '\u001B[?1049h' // alternate screen, so the shell's scrollback survives
    out += '\u001B[?25l' // hide the cursor until the first frame positions it
    out += '\u001B[2J\u001B[H'
    if (mouse) {
      // 1000 = button events, 1002 = button-drag, 1006 = SGR encoding.
      out += '\u001B[?1000h\u001B[?1002h\u001B[?1006h'
    }
    out += '\u001B[?2004h' // bracketed paste
    return out
  }

  /**
   * The escape sequences that leave the session and restore the terminal.
   * @param options - Must match the {@link ScreenRenderer.enter} call.
   * @returns The escape sequence.
   */
  static leave(options: { mouse?: boolean } = {}): string {
    const mouse = options.mouse ?? true
    let out = '\u001B[?2004l'
    if (mouse) out += '\u001B[?1006l\u001B[?1002l\u001B[?1000l'
    out += `${SGR_RESET}\u001B[?25h\u001B[?1049l`
    return out
  }
}
