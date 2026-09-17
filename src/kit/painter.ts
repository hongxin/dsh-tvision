/**
 * A clipped view onto a {@link CellBuffer}.
 *
 * Every widget draws through a painter, never into a buffer directly. A painter
 * carries an origin (so a window's widget can draw in its own 0,0) and a clip
 * rectangle (so a widget that overflows its frame cannot corrupt a neighbour,
 * no matter what its caller did). That single invariant is what makes
 * overlapping windows safe: nothing has to be careful, because the painter
 * cannot write outside its own rectangle by construction.
 * @module @dsh-tvision/dsh-tvision/kit/painter
 */

import { CellBuffer, type Rect, type Style } from './cell.ts'
import { charWidth, clusterWidth, splitUnits, takeColumns, textWidth } from './text.ts'

/** How to place text that does not fill its cell in {@link Painter.text}. */
export type Align = 'left' | 'center' | 'right'

/** Options for {@link Painter.text}. */
export interface TextOptions {
  /** Horizontal placement when the string is narrower than the cell (default left). */
  align?: Align
  /** Truncate with an ellipsis instead of clipping at the edge (default true). */
  ellipsis?: boolean
  /** A style to apply to the padding cells, defaulting to the text's own style. */
  padStyle?: Style
}

/**
 * A write-only, clipped view of a rectangular region of a buffer.
 *
 * Painters are cheap and are created freely (one per widget per frame), so they
 * hold no cached state beyond the origin and clip.
 */
export class Painter {
  /** The buffer writes land in. */
  readonly target: CellBuffer
  /** Left column of the region, in target coordinates. */
  readonly x: number
  /** Top row of the region, in target coordinates. */
  readonly y: number
  /** Region width in columns. */
  readonly width: number
  /** Region height in rows. */
  readonly height: number

  /**
   * @param target - The buffer to write into.
   * @param region - The region, in the target's coordinates.
   */
  constructor(target: CellBuffer, region: Rect) {
    this.target = target
    this.x = region.x
    this.y = region.y
    this.width = Math.max(0, region.width)
    this.height = Math.max(0, region.height)
  }

  /** The region as a rectangle, for hit-testing and nested painters. */
  get region(): Rect {
    return { x: this.x, y: this.y, width: this.width, height: this.height }
  }

  /**
   * Whether a local coordinate is inside the region.
   * @param localX - Column relative to the region's left edge.
   * @param localY - Row relative to the region's top edge.
   * @returns True when addressable.
   */
  contains(localX: number, localY: number): boolean {
    return localX >= 0 && localY >= 0 && localX < this.width && localY < this.height
  }

  /**
   * A painter for a sub-rectangle, in local coordinates. The child inherits the
   * parent's clipping, so a grandchild can never escape the grandparent.
   * @param localX - Left column, relative to this region.
   * @param localY - Top row, relative to this region.
   * @param width - Width in columns.
   * @param height - Height in rows.
   * @returns The child painter.
   */
  sub(localX: number, localY: number, width: number, height: number): Painter {
    const left = Math.max(0, Math.min(this.width, localX))
    const top = Math.max(0, Math.min(this.height, localY))
    const right = Math.max(left, Math.min(this.width, localX + width))
    const bottom = Math.max(top, Math.min(this.height, localY + height))
    return new Painter(this.target, {
      x: this.x + left,
      y: this.y + top,
      width: right - left,
      height: bottom - top,
    })
  }

  /**
   * Fill the whole region with a character.
   * @param char - The fill character (default space).
   * @param style - The style to paint.
   */
  fill(char = ' ', style: Style = {}): void {
    const unit = charWidth(char) === 2 ? ' ' : char
    for (let row = 0; row < this.height; row++) {
      for (let column = 0; column < this.width; column++) {
        this.target.set(this.x + column, this.y + row, unit, style)
      }
    }
  }

  /**
   * Fill a horizontal band across the full region width.
   * @param localY - Row, relative to the region.
   * @param style - The style to paint.
   * @param height - Rows to fill (default 1).
   */
  fillRow(localY: number, style: Style, height = 1): void {
    if (localY < 0 || localY >= this.height) return
    const rows = Math.min(height, this.height - localY)
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < this.width; column++) {
        this.target.set(this.x + column, this.y + localY + row, ' ', style)
      }
    }
  }

  /**
   * Fill a vertical band across the full region height.
   * @param localX - Column, relative to the region.
   * @param style - The style to paint.
   * @param width - Columns to fill (default 1).
   */
  fillColumn(localX: number, style: Style, width = 1): void {
    if (localX < 0 || localX >= this.width) return
    const columns = Math.min(width, this.width - localX)
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row < this.height; row++) {
        this.target.set(this.x + localX + column, this.y + row, ' ', style)
      }
    }
  }

  /**
   * Paint a box-drawing rectangle's outline.
   * @param localX - Left column.
   * @param localY - Top row.
   * @param width - Width in columns, corners included.
   * @param height - Height in rows, corners included.
   * @param style - Line style.
   * @param chars - The six glyphs to use; defaults to the single-line set.
   */
  box(
    localX: number,
    localY: number,
    width: number,
    height: number,
    style: Style,
    chars: BoxChars = SINGLE_BOX,
  ): void {
    if (width <= 0 || height <= 0) return
    if (width === 1 || height === 1) {
      // Degenerate boxes are a solid rule; a one-cell "box" cannot show corners.
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          this.set(localX + column, localY + row, chars.horizontal, style)
        }
      }
      return
    }
    const right = localX + width - 1
    const bottom = localY + height - 1
    this.set(localX, localY, chars.topLeft, style)
    this.set(right, localY, chars.topRight, style)
    this.set(localX, bottom, chars.bottomLeft, style)
    this.set(right, bottom, chars.bottomRight, style)
    for (let column = localX + 1; column < right; column++) {
      this.set(column, localY, chars.horizontal, style)
      this.set(column, bottom, chars.horizontal, style)
    }
    for (let row = localY + 1; row < bottom; row++) {
      this.set(localX, row, chars.vertical, style)
      this.set(right, row, chars.vertical, style)
    }
  }

  /**
   * Write a string, painting its background across the whole cell.
   *
   * The text is measured in columns, not code points, so a CJK transcript line
   * inside a bordered window lands on the frame exactly as it should. A wide
   * glyph that would straddle the region's right edge is replaced by a space
   * rather than half-drawn, because a half-drawn glyph shifts the real
   * terminal's row.
   * @param localX - Left column of the cell.
   * @param localY - Row of the cell.
   * @param text - The string to write.
   * @param width - Width of the cell in columns.
   * @param style - The style for the text.
   * @param options - Alignment and truncation.
   */
  text(
    localX: number,
    localY: number,
    text: string,
    width: number,
    style: Style,
    options: TextOptions = {},
  ): void {
    if (width <= 0 || localY < 0 || localY >= this.height) return
    const align = options.align ?? 'left'
    const measured = textWidth(text)
    const fits = measured <= width
    const padStyle = options.padStyle ?? style
    // Paint the background first so a shorter string still shows its full cell.
    for (let column = 0; column < width; column++) {
      this.set(localX + column, localY, ' ', padStyle)
    }
    let cellText = text
    if (!fits) {
      const useEllipsis = options.ellipsis ?? true
      cellText = useEllipsis ? truncateCached(text, width) : clipToWidth(text, width)
    }
    const cellWidth = textWidth(cellText)
    let offset = 0
    if (align === 'center') offset = Math.max(0, Math.floor((width - cellWidth) / 2))
    else if (align === 'right') offset = Math.max(0, width - cellWidth)
    let column = localX + offset
    const limit = localX + width
    // Paint one *cluster* per advance, the same unit textWidth measured — a
    // loop over code points paints 👍🏽 as two glyphs in four columns while the
    // measurement budgeted two, and everything after it on the row shifts.
    for (const unit of splitUnits(cellText)) {
      if (unit.width === 0) {
        // A zero-width mark attaches to the previous cell — in *buffer*
        // coordinates, or it lands in another window's cell entirely. A mark
        // with nothing to attach to (the very first column) is dropped:
        // appending through the clip boundary would corrupt a neighbour, and a
        // baseless mark cannot render anyway.
        if (column <= localX) continue
        const previous = this.target.at(this.x + column - 1, this.y + localY)
        if (previous !== undefined) previous.char += unit.text
        continue
      }
      if (column + unit.width > limit) break
      this.set(column, localY, unit.text, style)
      column += unit.width
    }
  }

  /**
   * Write one character.
   *
   * A double-width glyph claims two columns: the lead stores the character and
   * is flagged, the trailer stores an empty string. Getting this wrong is
   * invisible on screen but corrupts every row's text, because joining a row
   * back would then emit a stray space after each wide glyph.
   * @param localX - Column.
   * @param localY - Row.
   * @param char - The character.
   * @param style - The style.
   */
  set(localX: number, localY: number, char: string, style: Style): void {
    if (!this.contains(localX, localY)) return
    // clusterWidth, not charWidth: a cluster like `1️⃣` has a narrow base code
    // point but occupies two columns, and measuring it by its base would store
    // an unflagged lead while the caller advanced two — one width authority,
    // not two that can disagree.
    const wide = clusterWidth(char) === 2
    this.target.set(this.x + localX, this.y + localY, char, style, wide)
    if (wide && this.contains(localX + 1, localY)) {
      this.target.set(this.x + localX + 1, this.y + localY, '', style)
    }
  }

  /**
   * Draw a drop shadow to the right and below a rectangle, the way a window
   * manager of the era did: one cell of solid black offset by (2, 1).
   * @param localX - Left column of the shadowed rectangle.
   * @param localY - Top row of the shadowed rectangle.
   * @param width - Width of the rectangle casting the shadow.
   * @param height - Height of the rectangle casting the shadow.
   * @param style - The shadow style.
   * @param offsetX - Horizontal offset (default 2).
   * @param offsetY - Vertical offset (default 1).
   */
  shadow(
    localX: number,
    localY: number,
    width: number,
    height: number,
    style: Style,
    offsetX = 2,
    offsetY = 1,
  ): void {
    const rightStart = localX + width
    const rightEnd = rightStart + offsetX
    for (let row = localY + offsetY; row < localY + height + offsetY; row++) {
      for (let column = rightStart; column < rightEnd; column++) {
        this.set(column, row, ' ', style)
      }
    }
    const bottomStart = localY + height
    const bottomEnd = bottomStart + offsetY
    for (let row = bottomStart; row < bottomEnd; row++) {
      for (let column = localX + offsetX; column < localX + width + offsetX; column++) {
        this.set(column, row, ' ', style)
      }
    }
  }

  /**
   * Draw a horizontal rule with an optional title embedded at an offset.
   * @param localX - Left column.
   * @param localY - Row.
   * @param width - Width in columns.
   * @param style - Line style.
   * @param title - Optional title text.
   * @param titleStyle - Style for the title; defaults to `style`.
   * @param titleAt - Column offset for the title's first cell (default 1).
   */
  hRule(
    localX: number,
    localY: number,
    width: number,
    style: Style,
    title?: string,
    titleStyle?: Style,
    titleAt = 1,
  ): void {
    for (let column = 0; column < width; column++) this.set(localX + column, localY, '─', style)
    if (title === undefined || title === '') return
    const room = Math.max(0, width - titleAt - 1)
    const shown = clipToWidth(title, room)
    this.text(localX + titleAt, localY, shown, textWidth(shown), titleStyle ?? style)
  }

}

/**
 * Clip a string to a column budget, cutting rather than eliding, and never
 * splitting a wide glyph.
 * @param text - The string.
 * @param width - Column budget.
 * @returns The prefix.
 */
export const clipToWidth = takeColumns

/**
 * Clip with a trailing ellipsis when anything was dropped.
 * @param text - The string.
 * @param width - Column budget.
 * @returns A string of at most `width` columns.
 */
export function truncateCached(text: string, width: number): string {
  if (width <= 0) return ''
  if (textWidth(text) <= width) return text
  if (width === 1) return '…'
  return `${takeColumns(text, width - 1)}…`
}

/** The six glyphs needed to draw a box. */
export interface BoxChars {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
}

/** Single-line box drawing, the Windows 3.1 / Turbo Vision default. */
export const SINGLE_BOX: BoxChars = Object.freeze({
  topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘', horizontal: '─', vertical: '│',
})

/** Double-line box drawing, used for the focused window and modal dialogs. */
export const DOUBLE_BOX: BoxChars = Object.freeze({
  topLeft: '╔', topRight: '╗', bottomLeft: '╚', bottomRight: '╝', horizontal: '═', vertical: '║',
})

/** ASCII fallback for terminals whose font has no box-drawing glyphs. */
export const ASCII_BOX: BoxChars = Object.freeze({
  topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|',
})
