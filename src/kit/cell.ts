/**
 * The character-cell substrate: a colour model, a style record, and the
 * {@link CellBuffer} grid that every window renders into.
 *
 * This module is deliberately free of terminal I/O, widget knowledge, and DSH
 * knowledge. It is the bottom of the stack: `screen.ts` turns a buffer into
 * bytes, `wm.ts` decides what lands in it.
 * @module @dsh-tvision/dsh-tvision/kit/cell
 */

/** An ANSI palette index, `0`–`15`: the colours a terminal theme remaps. */
export type AnsiColor = number

/** A 24-bit colour, `0xRRGGBB`. */
export type RgbColor = number

/**
 * The boundary between the two colour spaces.
 *
 * Below it a number is a palette index the terminal's own theme resolves; at or
 * above it, a 24-bit value. Sixteen rather than 256 because the skins name only
 * the sixteen remappable colours as indices and everything else as hex — and
 * because `0x00AAAA`, the Borland cyan, is 43690, which a 256 boundary would
 * silently read as palette entry 170. That exact confusion is why this constant
 * exists.
 */
export const PALETTE_LIMIT = 16

/**
 * One colour slot. `undefined` means "terminal default", which is not the same
 * as black: a skin that leaves the foreground default inherits the user's own
 * theme, which is what keeps the thing legible on light backgrounds.
 */
export type Color = AnsiColor | RgbColor | undefined

/** Text attributes, mirroring the SGR groups a terminal can toggle independently. */
export interface Attrs {
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  blink?: boolean
  inverse?: boolean
  strike?: boolean
}

/** Foreground, background, and text attributes for one cell. */
export interface Style extends Attrs {
  fg?: Color
  bg?: Color
}

/**
 * A style may be written as a partial record; every field is optional, and
 * `undefined` explicitly clears an inherited field. Widgets therefore merge
 * styles rather than compose them (there is no SGR colour stack to compose
 * with — see {@link mergeStyle}).
 */
export type StyleInput = Style

/** No colour, no attributes: whatever the terminal is already doing. */
export const DEFAULT_STYLE: Readonly<Style> = Object.freeze({})

/**
 * The blank cell. Spread over a buffer at clear time. Frozen so no caller can
 * mutate the shared instance.
 */
export const BLANK_CELL: Readonly<Cell> = Object.freeze({ char: ' ', style: DEFAULT_STYLE, wide: false })

/**
 * One cell of the grid.
 *
 * `wide` marks the *lead* half of a double-width (CJK, most emoji) glyph. The
 * trailing column that the glyph also paints is stored as `char: ''` with
 * `wide: false`: it occupies a column but contributes no character, so joining
 * a row's characters reproduces the original text exactly.
 */
export interface Cell {
  /** One character, or `''` for the trailing column of a wide glyph. */
  char: string
  style: Style
  /** True when this cell is the lead column of a double-width glyph. */
  wide: boolean
}

/** An immutable rectangle in cell coordinates. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A cell coordinate, 0-based from the top-left of the screen. */
export interface Point {
  readonly x: number
  readonly y: number
}

/**
 * Build a rectangle, normalising negative extents to zero so callers may pass
 * arithmetic results without guarding every subtraction.
 * @param x - Left column.
 * @param y - Top row.
 * @param width - Width in columns; clamped at 0.
 * @param height - Height in rows; clamped at 0.
 * @returns The rectangle.
 */
export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}

/**
 * Whether a point lies inside a rectangle.
 * @param r - The rectangle.
 * @param px - Point column.
 * @param py - Point row.
 * @returns True when the point is inside the half-open extent.
 */
export function containsPoint(r: Rect, px: number, py: number): boolean {
  return px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height
}

/**
 * Whether two rectangles share at least one cell.
 * @param a - First rectangle.
 * @param b - Second rectangle.
 * @returns True when they intersect.
 */
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * Merge an overlay style onto a base style field by field. An explicit
 * `undefined` in the overlay clears the base field, which is how a widget
 * punches back to the terminal default from inside a themed region.
 * @param base - The inherited style.
 * @param over - The overriding style; may be undefined.
 * @returns A new style; `base` is returned unchanged when `over` is undefined.
 */
export function mergeStyle(base: Style, over: StyleInput | undefined): Style {
  if (over === undefined) return base
  // Fast path: an empty overlay is the common case (most writes carry a style
  // that was already resolved by the caller).
  const keys = Object.keys(over)
  if (keys.length === 0) return base
  const out: Style = { ...base }
  for (const key of keys as (keyof Style)[]) {
    const value = over[key]
    if (value === undefined) delete out[key]
    else (out as Record<string, unknown>)[key] = value
  }
  return out
}

/**
 * Structural equality for styles, used by the renderer to decide whether a
 * cell changed. Deliberately allocation-free.
 * @param a - First style.
 * @param b - Second style.
 * @returns True when every field matches.
 */
export function styleEquals(a: Style, b: Style): boolean {
  return a.fg === b.fg
    && a.bg === b.bg
    && a.bold === b.bold
    && a.dim === b.dim
    && a.italic === b.italic
    && a.underline === b.underline
    && a.blink === b.blink
    && a.inverse === b.inverse
    && a.strike === b.strike
}

/**
 * A rectangle of cells.
 *
 * The buffer owns a flat array of {@link Cell} records. Cells are mutable in
 * place (widgets write millions of them per session); {@link CellBuffer.row}
 * and {@link CellBuffer.snapshot} hand out copies so no reader can alias the
 * live grid.
 */
export class CellBuffer {
  /** Width in columns. */
  readonly width: number
  /** Height in rows. */
  readonly height: number
  /** Row-major cell storage, `width * height` entries. */
  readonly cells: Cell[]

  /**
   * @param width - Width in columns; clamped at 0.
   * @param height - Height in rows; clamped at 0.
   */
  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width))
    this.height = Math.max(0, Math.floor(height))
    this.cells = new Array<Cell>(this.width * this.height)
    this.clear(DEFAULT_STYLE)
  }

  /**
   * Reset every cell to a blank carrying `style`.
   * @param style - Background style for the cleared area.
   */
  clear(style: Style = DEFAULT_STYLE): void {
    const cell: Cell = { char: ' ', style, wide: false }
    for (let index = 0; index < this.cells.length; index++) {
      const existing = this.cells[index]
      // Reuse the record so a full-screen clear per frame does not allocate.
      if (existing === undefined) this.cells[index] = { ...cell }
      else {
        existing.char = ' '
        existing.style = style
        existing.wide = false
      }
    }
  }

  /**
   * Whether a coordinate is addressable.
   * @param x - Column.
   * @param y - Row.
   * @returns True when inside the grid.
   */
  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  /**
   * Read one cell.
   * @param x - Column.
   * @param y - Row.
   * @returns The cell, or undefined outside the grid.
   */
  at(x: number, y: number): Cell | undefined {
    if (!this.inBounds(x, y)) return undefined
    return this.cells[y * this.width + x]
  }

  /**
   * Overwrite one cell. Out-of-bounds writes are dropped silently: every
   * widget draws into a clipped sub-buffer, so this is a backstop, not a
   * policy.
   * @param x - Column.
   * @param y - Row.
   * @param char - The character, or `''` for a wide glyph's trailing column.
   * @param style - Cell style.
   * @param wide - Whether this column leads a double-width glyph.
   */
  set(x: number, y: number, char: string, style: Style = DEFAULT_STYLE, wide = false): void {
    if (!this.inBounds(x, y)) return
    const base = y * this.width
    const cell = this.cells[base + x]
    /* c8 ignore next -- the array is fully populated by the constructor. */
    if (cell === undefined) return
    // Writing the trailing column of a wide glyph is a normal write, not a
    // corruption: the lead keeps its flag so the pair stays one glyph.
    if (!(char === '' && x > 0)) {
      const previous = this.cells[base + x - 1]
      if (previous !== undefined && previous.wide) previous.wide = false
    }
    // Overwriting the lead of a wide glyph orphans its trailer; blank it so the
    // row stays joinable.
    if (cell.wide && this.inBounds(x + 1, y)) {
      const trail = this.cells[base + x + 1]
      if (trail !== undefined && trail.char === '') {
        trail.char = ' '
        trail.style = style
      }
    }
    cell.char = char
    cell.style = style
    cell.wide = wide
  }

  /**
   * Copy a row's characters, without styles.
   * @param y - Row index.
   * @returns The row's text, trailing blanks included.
   */
  row(y: number): string {
    if (y < 0 || y >= this.height) return ''
    let out = ''
    const base = y * this.width
    for (let x = 0; x < this.width; x++) out += this.cells[base + x]?.char ?? ' '
    return out
  }

  /**
   * Copy a row's cells, so a caller may compare or archive a frame without
   * aliasing the live grid.
   * @param y - Row index.
   * @returns A fresh array of cloned cells; empty outside the grid.
   */
  rowCells(y: number): Cell[] {
    if (y < 0 || y >= this.height) return []
    const base = y * this.width
    const out: Cell[] = new Array<Cell>(this.width)
    for (let x = 0; x < this.width; x++) {
      const cell = this.cells[base + x]
      /* c8 ignore next -- the array is fully populated by the constructor. */
      out[x] = cell === undefined ? { char: ' ', style: DEFAULT_STYLE, wide: false } : { ...cell }
    }
    return out
  }

  /**
   * Copy the whole grid.
   * @returns A fresh buffer with cloned cells.
   */
  snapshot(): CellBuffer {
    const copy = new CellBuffer(this.width, this.height)
    for (let index = 0; index < this.cells.length; index++) {
      const cell = this.cells[index]
      /* c8 ignore next -- the array is fully populated by the constructor. */
      if (cell !== undefined) copy.cells[index] = { ...cell }
    }
    return copy
  }

  /**
   * The rows of this buffer, joined into strings. This is the primary
   * assertion surface for tests: no ANSI, just what a reader would see.
   * @param options - `trimEnd` drops trailing blanks per row (default true).
   * @returns One string per row.
   */
  lines(options: { trimEnd?: boolean } = {}): string[] {
    const trim = options.trimEnd ?? true
    const out: string[] = new Array<string>(this.height)
    for (let y = 0; y < this.height; y++) {
      const row = this.row(y)
      out[y] = trim ? row.replace(/\s+$/u, '') : row
    }
    return out
  }
}

/**
 * Render the buffer as a box-drawing string with no ANSI, for tests and docs.
 * A `+`/`-`/`|` grid outline is drawn around the content.
 * @param buffer - The buffer to describe.
 * @param options - `border` adds a frame (default true).
 * @returns The description as lines of text.
 */
export function bufferToAscii(buffer: CellBuffer, options: { border?: boolean } = {}): string[] {
  const border = options.border ?? true
  const body = buffer.lines({ trimEnd: false }).map(line => `|${line}|`)
  if (!border) return body
  const rule = `+${'-'.repeat(buffer.width)}+`
  return [rule, ...body, rule]
}
