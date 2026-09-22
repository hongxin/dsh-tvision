/**
 * Window chrome: the frame, the title bar, the system and zoom boxes, the
 * scrollbars, and the resize grip.
 *
 * All of it is drawn the way Borland drew it, because the details are what make
 * the thing feel like a text-mode IDE rather than a chat log with a border:
 *
 * - an inactive frame is single-line and dim, an active frame is double-line
 *   and bright — the border itself tells you where the keyboard is going;
 * - the title sits centred *on* the top frame line with one space of line on
 *   each side, the way `TFrame::draw` placed it — no flanking glyphs, the
 *   line simply continues to the corners;
 * - the system and zoom boxes are bracketed glyphs on the line: `[■]` clear at
 *   the left (column 2), `[↑]`/`[↓]` zoom at the right (width-5), and neither
 *   ever touches a corner;
 * - the resize grip is the bottom-right corner itself, `═╝`/`─┘` brightened —
 *   the line never breaks for it;
 * - the frame casts a two-column, one-row drop shadow onto whatever is behind
 *   it, which is what makes stacked windows read as *stacked*.
 * @module @dsh-tvision/dsh-tvision/kit/frame
 */

import type { Rect, Style } from '../kit/cell.ts'
import { containsPoint } from '../kit/cell.ts'
import type { Palette } from '../kit/skin.ts'
import { Painter, SINGLE_BOX, DOUBLE_BOX } from '../kit/painter.ts'
import { takeColumns, textWidth } from '../kit/text.ts'

/** Which part of a frame the pointer is over, for hit-testing. */
export type FramePart =
  | 'title'
  | 'system'
  | 'zoom'
  | 'grip'
  | 'border'
  | 'scrollUp'
  | 'scrollDown'
  | 'thumb'
  | 'trough'
  | 'inside'
  | 'outside'

/** Width of the scrollbar column, when a window shows one. */
export const SCROLLBAR_WIDTH = 1

/** The glyph on the close/system box, `■` inside brackets. */
export const SYSTEM_GLYPH = '■'
/** The glyph on the zoom (maximise) box. */
export const ZOOM_GLYPH = '↑'
/** The glyph on the restore box of a zoomed window. */
export const RESTORE_GLYPH = '↓'

/** How a window's chrome should be drawn this frame. */
export interface FrameOptions {
  /** Window rectangle in screen coordinates, shadow excluded. */
  readonly rect: Rect
  /** Title shown centred in the top border. */
  readonly title: string
  /** Whether this window owns the keyboard. */
  readonly active: boolean
  /** Whether the window is zoomed (drawn with the restore glyph). */
  readonly zoomed: boolean
  /** Whether to draw the title bar's system and zoom boxes. */
  readonly closable: boolean
  /** Whether the window may be resized by its grip. */
  readonly resizable: boolean
  /** Whether to draw a vertical scrollbar in the rightmost interior column. */
  readonly scrollbar?: {
    /** Scroll offset from the top, in rows. */
    readonly offset: number
    /** Total scrollable content height, in rows. */
    readonly total: number
    /** Visible height, in rows. */
    readonly visible: number
  }
  /** The scrollbar's active-region style, for a window that is not focused. */
  readonly palette: Palette
  /**
   * Index of the interior row that should show a horizontal rule, used by
   * windows that split their content (transcript over composer). `-1` for none.
   */
  readonly separatorRow?: number
  /**
   * Paints the window's content.
   *
   * This is a callback rather than something the caller does beforehand because
   * the order is load-bearing: the interior must be cleared before the content
   * is drawn, and the border must be drawn after, so a widget that overflows
   * its bounds is framed rather than smeared over the chrome. Getting that order
   * wrong is invisible in a unit test on the painter and glaring on screen.
   * @param painter - A painter clipped to the interior.
   */
  readonly paintContent?: (painter: Painter) => void
}

/**
 * The drop shadow's geometry: two columns right, one row down. Chosen because
 * it reads as depth without eating a whole cell of the neighbouring window.
 */
export const SHADOW_OFFSET_X = 2
/** The drop shadow's vertical offset in rows. */
export const SHADOW_OFFSET_Y = 1

/**
 * Where a point falls within a window's chrome.
 *
 * This is the single hit-test that drives every mouse interaction: the window
 * manager asks it to decide between raise, drag, resize, and forwarding the
 * click to the content widget.
 * @param options - The frame's geometry and capabilities.
 * @param x - Screen column.
 * @param y - Screen row.
 * @returns The part of the frame under the point.
 */
export function frameHitTest(
  options: Pick<FrameOptions, 'rect' | 'closable' | 'resizable' | 'scrollbar'>,
  x: number,
  y: number,
): FramePart {
  const { rect } = options
  if (!containsPoint(rect, x, y)) return 'outside'
  const localX = x - rect.x
  const localY = y - rect.y
  const right = rect.width - 1
  const bottom = rect.height - 1
  if (localY === 0) {
    // The boxes are painted as bracketed three-cell groups — `[■]` on columns
    // 2-4 and `[↑]`/`[↓]` on width-5..width-3 — and a hit test that disagrees
    // with the painter is worse than no hit test: clicking the drawn glyph
    // must be the action the glyph announces, not the one two cells over.
    // Below ten columns the painter drops the boxes, so the hit test must too.
    if (options.closable && rect.width >= 10) {
      if (localX >= rect.width - 5 && localX <= rect.width - 3) return 'zoom'
      if (localX >= 2 && localX <= 4) return 'system'
    }
    return 'title'
  }
  if (localY === bottom) {
    // The grip is the brightened corner pair — the last two cells of the
    // bottom line — so both cells hit; a frame two cells wide draws no grip
    // (there is no line left), and the test must not claim one either.
    if (options.resizable && rect.width >= 3 && localX >= right - 1) return 'grip'
    return 'border'
  }
  if (localX === 0 || localX === right) {
    if (options.scrollbar !== undefined && localX === right) {
      // The track occupies the interior rows: an arrow on the first and last,
      // the thumb computed across everything between them. This mirrors
      // `drawScrollbar` exactly, because a hit test that disagrees with the
      // painter is worse than no hit test.
      const trackTop = 1
      const trackBottom = bottom - 1
      if (trackBottom > trackTop) {
        const innerTop = trackTop + 1
        const innerHeight = trackBottom - innerTop
        const { offset, total, visible } = options.scrollbar
        if (localY === trackTop) return 'scrollUp'
        if (localY === trackBottom) return 'scrollDown'
        if (innerHeight > 0 && localY >= innerTop && localY < innerTop + innerHeight) {
          const thumbSize = Math.max(1, Math.min(innerHeight, Math.round((visible / Math.max(1, total)) * innerHeight)))
          const maxOffset = Math.max(1, total - visible)
          const thumbTop = innerTop
            + Math.min(innerHeight - thumbSize, Math.round((offset / maxOffset) * (innerHeight - thumbSize)))
          if (localY >= thumbTop && localY < thumbTop + thumbSize) return 'thumb'
          return 'trough'
        }
      }
    }
    return 'border'
  }
  return 'inside'
}

/**
 * Draw a window's frame and shadow.
 *
 * The shadow is painted first, so the window covers whatever part of its own
 * shadow it overlaps — which is exactly how a real shadow behaves and why the
 * two-column offset does not leave a notch.
 * @param painter - The surface to draw on, clipped to the desktop.
 * @param options - Geometry, title, focus, and capabilities.
 */
export function drawFrame(painter: Painter, options: FrameOptions): void {
  const { rect, active, palette } = options
  if (rect.width <= 0 || rect.height <= 0) return
  const localX = rect.x - painter.x
  const localY = rect.y - painter.y
  const frameStyle: Style = active ? palette.windowFrameActive : palette.windowFrame
  const bodyStyle: Style = palette.windowBody

  // 1. Interior: clear, then hand it to the content painter.
  const interior: Rect = {
    x: localX + 1,
    y: localY + 1,
    width: Math.max(0, rect.width - 2),
    height: Math.max(0, rect.height - 2),
  }
  if (interior.width > 0 && interior.height > 0) {
    const content = painter.sub(interior.x, interior.y, interior.width, interior.height)
    content.fill(' ', bodyStyle)
    options.paintContent?.(content)
  }

  // 3. Border. A window one cell wide or tall still has to look deliberate, so
  //    the painter's degenerate-box path draws a solid rule.
  painter.box(
    localX, localY, rect.width, rect.height, frameStyle,
    active ? DOUBLE_BOX : SINGLE_BOX,
  )

  // 4. Title bar: the title sits centred on the frame line itself, one cell of
  //    line on each side — `TFrame::draw`'s placement. The line runs unbroken
  //    to the corners; the boxes are bracketed glyphs on the line, never
  //    overwrites of a corner.
  if (rect.width >= 4) {
    const titleStyle: Style = active ? palette.windowTitleActive : palette.windowTitle
    const iconStyle: Style = active ? palette.windowIcon : palette.windowTitle
    const boxes = options.closable && rect.width >= 10
    // TV truncates the title to width-10, then gives the boxes six more cells.
    const maxTitle = Math.max(0, rect.width - 10 - (boxes ? 6 : 0))
    const shown = takeColumns(options.title, maxTitle)
    const titleWidth = textWidth(shown)
    if (titleWidth > 0) {
      const centre = (rect.width - titleWidth) >> 1
      // A space in the frame's style breaks the line on both sides of the
      // title; the floor division leaves the odd cell on the right.
      painter.set(localX + centre - 1, localY, ' ', frameStyle)
      painter.text(localX + centre, localY, shown, titleWidth, titleStyle)
      painter.set(localX + centre + titleWidth, localY, ' ', frameStyle)
    }
    if (boxes) {
      // `[■]` clear at column 2, `[↑]`/`[↓]` zoom ending three cells short of
      // the corner. Brackets take the line's style; the glyph is the box.
      painter.set(localX + 2, localY, '[', frameStyle)
      painter.set(localX + 3, localY, SYSTEM_GLYPH, iconStyle)
      painter.set(localX + 4, localY, ']', frameStyle)
      const zoomGlyphX = localX + rect.width - 4
      painter.set(zoomGlyphX - 1, localY, '[', frameStyle)
      painter.set(zoomGlyphX, localY, options.zoomed ? RESTORE_GLYPH : ZOOM_GLYPH, iconStyle)
      painter.set(zoomGlyphX + 1, localY, ']', frameStyle)
    }
  }

  // 5. Resize grip: the corner pair itself, brightened. The bottom line keeps
  //    its glyphs — TV's drag icon was the last `─┘` re-coloured, not replaced.
  if (options.resizable && rect.width >= 3 && rect.height >= 3) {
    const gripStyle: Style = active ? palette.windowGrip : frameStyle
    painter.set(localX + rect.width - 2, localY + rect.height - 1, active ? '═' : '─', gripStyle)
    painter.set(localX + rect.width - 1, localY + rect.height - 1, active ? '╝' : '┘', gripStyle)
  }

  // 6. Separator rule between stacked content regions.
  if (options.separatorRow !== undefined && options.separatorRow >= 0) {
    const row = localY + 1 + options.separatorRow
    if (row > localY && row < localY + rect.height - 1) {
      for (let column = localX + 1; column < localX + rect.width - 1; column++) {
        painter.set(column, row, '─', frameStyle)
      }
      painter.set(localX, row, active ? '╟' : '├', frameStyle)
      painter.set(localX + rect.width - 1, row, active ? '╢' : '┤', frameStyle)
    }
  }

  // 7. Scrollbar.
  if (options.scrollbar !== undefined && rect.height >= 5 && rect.width >= 4) {
    drawScrollbar(painter, options)
  }

  // 8. Shadow last, so the frame's own bottom-right corner cannot erase the
  //    first cell of the band it casts. Everything inside the window is drawn
  //    by now, which is exactly what the shadow must not cover — hence the
  //    offset, which puts the band entirely outside the window's own cells.
  painter.shadow(
    localX, localY, rect.width, rect.height, palette.shadow,
    SHADOW_OFFSET_X, SHADOW_OFFSET_Y,
  )
}

/**
 * Draw the vertical scrollbar in a window's right border column.
 * @param painter - The surface.
 * @param options - Frame geometry including the scrollbar's metrics.
 */
function drawScrollbar(painter: Painter, options: FrameOptions): void {
  const metrics = options.scrollbar
  /* c8 ignore next -- guarded by the caller. */
  if (metrics === undefined) return
  const { rect, active, palette } = options
  const localX = rect.x - painter.x
  const localY = rect.y - painter.y
  const column = localX + rect.width - 1
  const top = localY + 1
  const bottom = localY + rect.height - 2
  const trackHeight = bottom - top + 1
  /* c8 ignore next -- guarded by the caller's height check. */
  if (trackHeight <= 2) return
  const frameStyle: Style = active ? palette.windowFrameActive : palette.windowFrame
  const thumbStyle: Style = palette.scrollThumb
  const { offset, total, visible } = metrics
  painter.set(column, top - 0, '↑', frameStyle)
  painter.set(column, bottom, '↓', frameStyle)
  const innerTop = top + 1
  const innerHeight = trackHeight - 2
  const thumbSize = Math.max(1, Math.min(innerHeight, Math.round((visible / Math.max(1, total)) * innerHeight)))
  const maxOffset = Math.max(1, total - visible)
  const thumbTop = innerTop + Math.min(innerHeight - thumbSize, Math.round((offset / maxOffset) * (innerHeight - thumbSize)))
  for (let row = innerTop; row < innerTop + innerHeight; row++) {
    const isThumb = row >= thumbTop && row < thumbTop + thumbSize
    painter.set(column, row, isThumb ? '█' : '░', isThumb ? thumbStyle : frameStyle)
  }
}

/**
 * The interior rectangle of a window: the area content widgets may paint in.
 * @param rect - The window's outer rectangle.
 * @param reserveScrollbar - Whether to keep the rightmost interior column free.
 * @returns The interior rectangle, possibly zero-sized.
 */
export function interiorRect(rect: Rect, reserveScrollbar = false): Rect {
  const width = Math.max(0, rect.width - 2 - (reserveScrollbar ? SCROLLBAR_WIDTH : 0))
  return {
    x: rect.x + 1,
    y: rect.y + 1,
    width,
    height: Math.max(0, rect.height - 2),
  }
}

