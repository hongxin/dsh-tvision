/**
 * A real terminal emulator behind the `Terminal` seam.
 *
 * The renderer's whole job is to make a live terminal's *grid of cells* match an
 * internal buffer, so testing it against a string of escapes only proves that
 * the escapes are the ones we expected to write — not that a terminal would
 * interpret them that way. Running the bytes through xterm.js and reading the
 * resulting cells back proves the property that actually matters, and it is how
 * the wide-character, clipping, and overlap behaviour below is verified.
 * @module @dsh-tvision/dsh-tvision/tests/headless-terminal
 */

import XtermHeadless from '@xterm/headless'
import type { IBufferCell, IBufferLine, Terminal as XtermTerminalType } from '@xterm/headless'

/**
 * The emulator constructor.
 *
 * `@xterm/headless` is CommonJS with named-export typings, so the named binding a
 * bundler resolves is not the one raw Node resolves. Taking the default and
 * destructuring works under both, which is what lets the pty replay script reuse
 * this harness outside the test runner.
 */
const XtermTerminal = (XtermHeadless as unknown as { Terminal: typeof XtermTerminalType }).Terminal
type XtermTerminal = XtermTerminalType

/** The escape sequence that ends a synchronized-output frame. */
const FRAME_END = '\u001B[?2026l'

/** Colour names for the first sixteen palette indices. */
const ANSI_COLORS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'bright-black', 'bright-red', 'bright-green', 'bright-yellow',
  'bright-blue', 'bright-magenta', 'bright-cyan', 'bright-white',
] as const

/** One cell of the emulated screen, as a test may assert on it. */
export interface CellView {
  /** The character in this cell; `''` for the trailing half of a wide glyph. */
  char: string
  /** Foreground colour label, e.g. `#55ffff` or `cyan`. */
  fg: string
  /** Background colour label. */
  bg: string
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
}

/** A whole emulated frame. */
export interface FrameView {
  /** Rows of characters, trailing blanks trimmed. */
  readonly rows: string[]
  /** Rows of characters, blanks preserved. */
  readonly rawRows: string[]
  /** Per-row cell detail. */
  readonly cells: CellView[][]
  /** The cursor position after the frame. */
  readonly cursor: { x: number; y: number }
  /** How many complete frames the emulator has seen. */
  readonly frames: number
}

/** One style span within a row, as found by {@link FrameView} helpers. */
export interface StyleSpan {
  readonly start: number
  readonly end: number
  readonly fg: string
  readonly bg: string
  readonly attrs: string
}

function colorLabel(cell: IBufferCell, layer: 'fg' | 'bg'): string {
  const isDefault = layer === 'fg' ? cell.isFgDefault() : cell.isBgDefault()
  if (isDefault) return 'default'
  const isRgb = layer === 'fg' ? cell.isFgRGB() : cell.isBgRGB()
  const value = layer === 'fg' ? cell.getFgColor() : cell.getBgColor()
  if (isRgb) return `#${value.toString(16).padStart(6, '0')}`
  return ANSI_COLORS[value] ?? `ansi-${value}`
}

function toCellView(cell: IBufferCell): CellView {
  return {
    char: cell.getChars(),
    fg: colorLabel(cell, 'fg'),
    bg: colorLabel(cell, 'bg'),
    bold: cell.isBold() !== 0,
    dim: cell.isDim() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    inverse: cell.isInverse() !== 0,
  }
}

/**
 * The emulated terminal.
 *
 * `write` is synchronous with respect to the emulator's parser, so a test can
 * write a frame and immediately read the grid back without awaiting anything.
 */
export class HeadlessTerminal {
  readonly xterm: XtermTerminal
  private frameCount = 0
  private writeHandler: ((data: string) => void) | undefined

  /**
   * @param columns - Screen width.
   * @param rows - Screen height.
   */
  constructor(columns = 80, rows = 24) {
    this.xterm = new XtermTerminal({
      cols: columns,
      rows,
      scrollback: 200,
      allowProposedApi: true,
      logLevel: 'off',
      drawBoldTextInBrightColors: false,
    })
  }

  /** How many complete synchronized-output frames have been written. */
  get frames(): number {
    return this.frameCount
  }

  /**
   * Write bytes into the emulator, counting frame boundaries.
   *
   * The emulator parses asynchronously, so a caller that wants to read the grid
   * back must use {@link writeAndSettle} instead; this form exists for tests
   * that only assert on the frame count.
   * @param data - The escape sequence to interpret.
   */
  write(data: string): void {
    this.writeHandler?.(data)
    this.frameCount += countOccurrences(data, FRAME_END)
    this.xterm.write(data)
  }

  /**
   * Write bytes and wait until the emulator has parsed them, so the next
   * {@link snapshot} reflects them.
   * @param data - The escape sequence to interpret.
   */
  async writeAndSettle(data: string): Promise<void> {
    this.writeHandler?.(data)
    this.frameCount += countOccurrences(data, FRAME_END)
    await new Promise<void>((resolve) => {
      this.xterm.write(data, resolve)
    })
  }

  /**
   * Install a hook that observes every write, so the test harness can also act
   * as the `Terminal` the application talks to.
   * @param handler - Called with each chunk before it reaches the parser.
   */
  onWrite(handler: (data: string) => void): void {
    this.writeHandler = handler
  }

  /**
   * Resize the emulated screen.
   * @param columns - New width.
   * @param rows - New height.
   */
  resize(columns: number, rows: number): void {
    this.xterm.resize(columns, rows)
  }

  /**
   * Feed synthetic input to the application. The harness has no application
   * loop, so tests drive the input decoder directly instead.
   * @param _data - Ignored.
   */
  send(_data: string): void {
    throw new Error('HeadlessTerminal.send is not implemented; drive the input decoder directly')
  }

  /**
   * Read the current screen back.
   * @returns Characters, cell detail, and the cursor position.
   */
  snapshot(): FrameView {
    const buffer = this.xterm.buffer.active
    const rows: string[] = []
    const rawRows: string[] = []
    const cells: CellView[][] = []
    for (let y = 0; y < this.xterm.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y)
      const raw = line === undefined ? '' : lineText(line, this.xterm.cols)
      rawRows.push(raw)
      rows.push(raw.replace(/\s+$/u, ''))
      cells.push(line === undefined ? [] : lineCells(line, this.xterm.cols))
    }
    return {
      rows,
      rawRows,
      cells,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      frames: this.frameCount,
    }
  }

  /**
   * Assertion helper: the style spans on a row, coalescing equal neighbours.
   * @param row - Row index.
   * @returns The spans, left to right.
   */
  spans(row: number): StyleSpan[] {
    const cells = this.snapshot().cells[row] ?? []
    const spans: StyleSpan[] = []
    for (let x = 0; x < cells.length; x++) {
      const cell = cells[x]
      /* c8 ignore next -- the row is fully populated. */
      if (cell === undefined) continue
      const attrs = attributesOf(cell)
      const last = spans[spans.length - 1]
      if (last !== undefined && last.fg === cell.fg && last.bg === cell.bg && last.attrs === attrs) {
        spans[spans.length - 1] = { ...last, end: x + 1 }
        continue
      }
      spans.push({ start: x, end: x + 1, fg: cell.fg, bg: cell.bg, attrs })
    }
    return spans
  }

  /** Dispose the emulator. */
  dispose(): void {
    this.xterm.dispose()
  }
}

function attributesOf(cell: CellView): string {
  const parts: string[] = []
  if (cell.bold) parts.push('bold')
  if (cell.dim) parts.push('dim')
  if (cell.italic) parts.push('italic')
  if (cell.underline) parts.push('underline')
  if (cell.inverse) parts.push('inverse')
  return parts.join(' ')
}

function lineText(line: IBufferLine, columns: number): string {
  let text = ''
  let skipTrailer = false
  for (let x = 0; x < columns; x++) {
    const cell = line.getCell(x)
    /* c8 ignore next -- xterm always returns a cell inside the row. */
    if (cell === undefined) break
    // A wide glyph occupies two cells and xterm reports the second as empty.
    // Emitting a space for it would double-count the glyph's width.
    if (skipTrailer) {
      skipTrailer = false
      continue
    }
    const chars = cell.getChars()
    text += chars === '' ? ' ' : chars
    skipTrailer = cell.getWidth() === 2
  }
  return text
}

function lineCells(line: IBufferLine, columns: number): CellView[] {
  const out: CellView[] = []
  for (let x = 0; x < columns; x++) {
    const cell = line.getCell(x)
    /* c8 ignore next -- xterm always returns a cell inside the row. */
    if (cell === undefined) break
    out.push(toCellView(cell))
  }
  return out
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let offset = 0
  for (;;) {
    const found = haystack.indexOf(needle, offset)
    if (found < 0) return count
    count++
    offset = found + needle.length
  }
}

/**
 * Assertion helper: the column range a substring occupies on a row.
 * @param view - The frame.
 * @param row - Row index.
 * @param text - The substring to locate.
 * @returns The start column, or `-1` when absent.
 */
export function columnOf(view: FrameView, row: number, text: string): number {
  return (view.rawRows[row] ?? '').indexOf(text)
}
