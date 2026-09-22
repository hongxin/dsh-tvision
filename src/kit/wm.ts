/**
 * The window manager: window geometry, z-order, focus, dragging, resizing, and
 * the frame loop that composites everything onto the desktop.
 *
 * The model is deliberately the old one, because the old one is right for a
 * character grid: a desktop is an ordered list of windows, the last one is on
 * top, and *everything* — transcript, composer, project tree, dialogs — is a
 * window. There is no special case for a "main view"; the chat is just the
 * window that happens to be biggest and was opened first.
 *
 * Two properties make overlapping windows safe here, and both are structural
 * rather than conventional:
 *
 * 1. Painting is done into an off-screen {@link CellBuffer} through a
 *    {@link Painter} clipped to each window's rectangle, in z-order. A widget
 *    that draws outside its bounds cannot corrupt a neighbour, because the
 *    painter drops the write.
 * 2. Input is dispatched by hit-testing the same rectangles in reverse
 *    z-order. A click can only ever reach the topmost window under the pointer.
 * @module dsh-tvision/kit/wm
 */

import { CellBuffer, rect as makeRect, type Rect, type Style } from './cell.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from './widget.ts'
import type { InputEvent, KeyInput, MouseInput } from './input.ts'
import type { ResolvedPalette, Skin } from './skin.ts'
import { resolvePalette } from './skin.ts'
import { HIDDEN_CURSOR, ScreenRenderer, type CursorState } from './screen.ts'
import { Painter } from './painter.ts'
import { drawFrame, frameHitTest, interiorRect } from './frame.ts'

/** Minimum window size the manager will allow a drag to produce. */
export const MIN_WINDOW_WIDTH = 12
/** Minimum window height the manager will allow a drag to produce. */
export const MIN_WINDOW_HEIGHT = 4

/**
 * The default floor below which the manager paints its "terminal too small"
 * notice instead of a desktop. Exported so the application's own
 * `MINIMUM_TERMINMINAL` constant is this value rather than a second copy that
 * can drift; a manager whose host knows better passes its own `minimum`.
 */
export const DEFAULT_MINIMUM_TERMINMINAL = Object.freeze({ columns: 40, rows: 10 })

/** The too-small notice's constant lines; the two size lines are inserted between. */
const TOO_SMALL_TITLE = 'terminal too small'
/** See {@link TOO_SMALL_TITLE}; spread after the size lines. */
const TOO_SMALL_TAIL: readonly string[] = ['', 'resize to continue']

/** How a window is created. */
export interface WindowSpec {
  /** Stable identity, used by `focusWindow`, `closeWindow` and the View menu. */
  readonly id: string
  /** Title shown in the title bar and the Window menu. */
  readonly title: string
  /** Initial rectangle in screen coordinates. */
  readonly rect: Rect
  /** The content widget. */
  readonly widget: Widget
  /** Whether the window participates in the Window menu and cascade (default true). */
  readonly listed?: boolean
  /** Whether the title bar shows a system box that closes it (default false). */
  readonly closable?: boolean
  /** Whether the bottom-right grip resizes it (default true). */
  readonly resizable?: boolean
  /** Whether the frame draws a scrollbar (default false). */
  readonly scrollable?: boolean
  /**
   * Whether this window floats above every normal window.
   *
   * Normal windows are ordered among themselves; a floating window is always
   * composited and hit-tested after all of them, whatever its creation order.
   * This is how dialogs stay on top without the caller having to re-raise them
   * every time a normal window is focused.
   */
  readonly floating?: boolean
  /**
   * Called once when the window is closed, after its state is updated.
   *
   * This is how a modal dialog learns it was dismissed by its system box or the
   * Window menu: without a callback here, the window can close while the
   * promise behind it stays pending forever, which is a wedged agent turn.
   */
  readonly onClose?: () => void
}

/**
 * A live window: its specification plus the geometry and state the manager
 * mutates (position, size, zoom memory, scroll metrics).
 */
export class Window {
  /** Stable identity. */
  readonly id: string
  /** The content widget. */
  readonly widget: Widget
  /** Title shown in the title bar; mutable so a view can show a dirty marker. */
  title: string
  /** Current outer rectangle. */
  rect: Rect
  /** Whether the Window menu lists it and cascade places it. */
  readonly listed: boolean
  /** Whether the title bar's system box closes it. */
  readonly closable: boolean
  /** Whether the grip resizes it. */
  readonly resizable: boolean
  /** Whether the frame draws a vertical scrollbar. */
  readonly scrollable: boolean
  /** Whether the window floats above normal windows. */
  readonly floating: boolean
  /** Called once when this window closes; see {@link WindowSpec.onClose}. */
  readonly onClose: (() => void) | undefined
  /** True after the user closed it; the manager skips it until re-opened. */
  closed = false
  /**
   * Whether the window is zoomed to fill the desktop.
   *
   * Tracked separately from {@link restoreRect}, which is also used to remember
   * the geometry a drag started from: conflating the two made a window report
   * itself zoomed the moment it was dragged.
   */
  private zoomedFlag = false
  /** The rectangle to restore to when un-zoomed. */
  private restoreRect: Rect | undefined
  /** Scroll metrics the frame's scrollbar renders, when `scrollable`. */
  scroll: { offset: number; total: number; visible: number } | undefined
  /** Interior row index that should show a separator rule, or -1. */
  separatorRow = -1

  /**
   * @param spec - The creation spec.
   */
  constructor(spec: WindowSpec) {
    this.id = spec.id
    this.title = spec.title
    this.rect = spec.rect
    this.widget = spec.widget
    this.listed = spec.listed ?? true
    this.closable = spec.closable ?? false
    this.resizable = spec.resizable ?? true
    this.scrollable = spec.scrollable ?? false
    this.floating = spec.floating ?? false
    this.onClose = spec.onClose
  }

  /** Whether the window is currently zoomed to fill the desktop. */
  get zoomed(): boolean {
    return this.zoomedFlag
  }

  /**
   * Re-assert the zoom flag after a geometry operation that necessarily cleared
   * it. Used by the resize loop, which clamps first and re-fits second.
   */
  markZoomed(): void {
    this.zoomedFlag = true
  }

  /**
   * Refit a zoomed window to a new desktop. A zoomed window has no geometry of
   * its own, so it must track the desktop rather than keep a stale extent.
   * @param desktop - The desktop rectangle.
   */
  fitDesktop(desktop: Rect): void {
    if (!this.zoomedFlag) return
    this.rect = makeRect(desktop.x, desktop.y, desktop.width, desktop.height)
  }

  /** The interior rectangle content widgets paint in. */
  get interior(): Rect {
    return interiorRect(this.rect, this.scrollable && this.scroll !== undefined)
  }

  /**
   * Zoom to fill `desktop`, remembering the previous rectangle.
   * @param desktop - The desktop rectangle to fill.
   */
  zoom(desktop: Rect): void {
    if (this.zoomedFlag) {
      this.rect = this.restoreRect ?? this.rect
      this.restoreRect = undefined
      this.zoomedFlag = false
      return
    }
    this.restoreRect = this.rect
    this.zoomedFlag = true
    this.fitDesktop(desktop)
  }

  /**
   * Restore the rectangle a drag started from.
   *
   * Every motion event of a drag recomputes the geometry from the drag's
   * *original* rectangle rather than accumulating deltas, so rounding and
   * clamping cannot drift the window away from the pointer over a long drag.
   * @param origin - The rectangle captured when the drag began.
   */
  restoreForDrag(origin: Rect): void {
    this.rect = origin
    this.restoreRect = undefined
    this.zoomedFlag = false
  }

  /**
   * Move so the top-left lands at a point, clamped so six title-bar columns
   * and one row always stay on the desktop and the window can be dragged back.
   * @param x - Target left column.
   * @param y - Target top row.
   * @param desktop - The desktop rectangle.
   */
  moveTo(x: number, y: number, desktop: Rect): void {
    this.restoreRect = undefined
    this.zoomedFlag = false
    const minX = desktop.x - this.rect.width + 6
    const maxX = desktop.x + desktop.width - 6
    const minY = desktop.y
    const maxY = desktop.y + desktop.height - 2
    this.rect = makeRect(
      Math.max(minX, Math.min(maxX, x)),
      Math.max(minY, Math.min(maxY, y)),
      this.rect.width,
      this.rect.height,
    )
  }

  /**
   * Resize from the bottom-right corner, respecting the minimums and the
   * desktop's edges.
   * @param width - Target width in columns.
   * @param height - Target height in rows.
   * @param desktop - The desktop rectangle.
   */
  resizeTo(width: number, height: number, desktop: Rect): void {
    this.restoreRect = undefined
    this.zoomedFlag = false
    const maxWidth = desktop.x + desktop.width - this.rect.x
    const maxHeight = desktop.y + desktop.height - this.rect.y
    this.rect = makeRect(
      this.rect.x,
      this.rect.y,
      Math.max(MIN_WINDOW_WIDTH, Math.min(maxWidth, width)),
      Math.max(MIN_WINDOW_HEIGHT, Math.min(maxHeight, height)),
    )
  }

  /**
   * Place the window without the minimum-size clamp, used by layout commands.
   * @param next - The new rectangle.
   */
  setRect(next: Rect): void {
    this.restoreRect = undefined
    this.zoomedFlag = false
    this.rect = makeRect(next.x, next.y, Math.max(1, next.width), Math.max(1, next.height))
  }
}

/** A snapshot of the desktop this frame, handed to the chrome widgets. */
export interface WindowListItem {
  readonly id: string
  readonly title: string
  readonly active: boolean
  readonly open: boolean
}

/** Options for {@link WindowManager}. */
export interface WindowManagerOptions {
  /** Initial desktop size in columns and rows. */
  readonly columns: number
  readonly rows: number
  /** The active skin. */
  readonly skin: Skin
  /** How many rows the top chrome (menu bar) occupies. */
  readonly topInset?: number
  /** How many rows the bottom chrome (status line + hint bar) occupies. */
  readonly bottomInset?: number
  /**
   * The smallest desktop that is still usable, in columns and rows.
   *
   * Below it the manager stops trying to lay out a desktop and paints a notice
   * instead. A window manager crammed into 20 columns is not a smaller version
   * of itself; it is a screen of overlapping fragments, and every widget's
   * minimum-size assumption is wrong at once. Saying so is the only honest
   * thing to draw.
   */
  readonly minimum?: { readonly columns: number; readonly rows: number }
  /** Whether box-drawing glyphs are available; false falls back to ASCII. */
  readonly unicode?: boolean
  /**
   * How many rows each chrome band gets for a screen height. When present,
   * {@link WindowManager.resize} re-plans the bands itself before reflowing,
   * so the order — plan against the new height, then lay windows out against
   * the new bands — is owned by the one place that reflows rather than
   * remembered by every caller.
   */
  readonly chrome?: (rows: number) => { top: number; bottom: number }
}

/** What a chrome widget (menu bar, hint bar) is drawn through. */
export interface ChromeWidget {
  /**
   * Paint the chrome into its band.
   * @param painter - Clipped to the band.
   * @param palette - The resolved palette.
   * @param manager - The live manager, for state such as the active window.
   */
  draw(painter: Painter, palette: ResolvedPalette, manager: WindowManager): void

  /**
   * Handle a key before the focused window sees it, so global accelerators win.
   * @param event - The decoded key.
   * @param manager - The live manager.
   * @returns True when the chrome consumed the event.
   */
  onKey?(event: KeyEvent, manager: WindowManager): boolean

  /**
   * Handle a mouse event inside the chrome's band.
   *
   * Receives screen coordinates and returns the rectangle it invalidated, so
   * the manager knows what to repaint (a dropdown covers windows below it).
   * @param event - The decoded mouse event.
   * @param manager - The live manager.
   * @returns True when the chrome consumed the event.
   */
  onMouse?(event: MouseEvent, manager: WindowManager): boolean
}

/** What {@link WindowManager.overlayProvider} returns for one frame. */
export interface OverlaySurface {
  /** The screen rectangle the overlay covers, for invalidation and hit testing. */
  readonly rect: Rect
  /**
   * Paint the overlay. Coordinates are screen-absolute; the painter is clipped
   * to the whole frame rather than to `rect`, so a dropdown may cast its shadow
   * outside its own bounds.
   * @param painter - The frame painter.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void
}

/** A drag in progress. */
interface DragState {
  readonly kind: 'move' | 'resize'
  readonly windowId: string
  readonly originX: number
  readonly originY: number
  readonly rect: Rect
}

/**
 * The desktop.
 *
 * Owns the frame loop: {@link paint} composites everything into a
 * {@link CellBuffer}, {@link render} hands that buffer to a
 * {@link ScreenRenderer}. Nothing else in the system writes to the terminal.
 */
export class WindowManager {
  /** The active skin. */
  skin: Skin
  /** Resolved roles for the active skin. */
  palette: ResolvedPalette
  /** @internal The windows, bottom to top among normal windows. */
  private windows: Window[] = []
  private nextZ = 1
  /** Higher wins among floating windows only. */
  private floatingOrder = new Map<string, number>()
  private activeId: string | undefined
  private columns: number
  private rows: number
  private topInsetValue: number
  private bottomInsetValue: number
  /** The usability floor; see {@link WindowManagerOptions.minimum}. */
  readonly minimum: { readonly columns: number; readonly rows: number }
  /** The chrome band planner, when the host supplied one. */
  private readonly chromePlanner: ((rows: number) => { top: number; bottom: number }) | undefined
  private drag: DragState | undefined
  private lastClick: { x: number; y: number; at: number; id: string } | undefined
  private wantsRender = true
  /** The renderer, created lazily once the terminal is known. */
  private renderer: ScreenRenderer | undefined
  /** The overlay region painted this frame, if any. */
  private overlayRect: Rect | undefined
  /** The last painted frame, kept for tests and for the debug overlay. */
  private frame: CellBuffer | undefined
  /**
   * The spare buffer paint() writes into next. Two buffers alternate: the
   * renderer retains the painted one as its diff basis, so it must never be
   * the one being overwritten, and a fully-rewritten fresh surface each frame
   * costs a whole grid of cell allocations at repaint rate.
   */
  private spare: CellBuffer | undefined
  /** Set while a modal dialog is open, to swallow clicks on lower windows. */
  private modalId: string | undefined
  private cursor: CursorState = HIDDEN_CURSOR
  private readonly unicode: boolean
  private onRequestRender: (() => void) | undefined
  /** Chrome drawn in the top band, if any. */
  topChrome: ChromeWidget | undefined
  /** Chrome drawn in the bottom band, if any. */
  bottomChrome: ChromeWidget | undefined
  /**
   * A surface that must be composited above every window, returned fresh each
   * frame. The menu bar uses it for its open dropdown: a menu a window could
   * cover would be worse than no menu at all, and a dropdown is not a window
   * (it has no title bar, does not focus, and ignores the window cycle).
   */
  overlayProvider: ((palette: ResolvedPalette) => OverlaySurface | undefined) | undefined
  /**
   * Input handler for the overlay region, tried before any window. Returning
   * true consumes the event, which is what stops a click "through" an open menu
   * from reaching the window underneath it.
   */
  overlayInput: ((event: MouseEvent) => boolean) | undefined

  /**
   * @param options - Desktop size, skin, and chrome insets.
   */
  constructor(options: WindowManagerOptions) {
    this.skin = options.skin
    this.palette = resolvePalette(options.skin)
    this.columns = Math.max(1, options.columns)
    this.rows = Math.max(1, options.rows)
    this.topInsetValue = options.topInset ?? 1
    this.bottomInsetValue = options.bottomInset ?? 2
    this.minimum = options.minimum ?? DEFAULT_MINIMUM_TERMINMINAL
    this.chromePlanner = options.chrome
    this.unicode = options.unicode ?? true
  }

  /** The usable desktop rectangle, excluding the chrome bands. */
  get desktop(): Rect {
    return makeRect(
      0,
      this.topInsetValue,
      this.columns,
      Math.max(1, this.rows - this.topInsetValue - this.bottomInsetValue),
    )
  }

  /** Total screen columns. */
  get width(): number {
    return this.columns
  }

  /** Total screen rows. */
  get height(): number {
    return this.rows
  }

  /**
   * The bottom chrome band's rectangle, so a chrome widget can hit-test a click
   * against the same geometry the manager painted it into.
   * @returns The band rectangle.
   */
  get bottomBand(): Rect {
    return makeRect(0, this.rows - this.bottomInsetValue, this.columns, this.bottomInsetValue)
  }

  /**
   * The top chrome band's rectangle.
   * @returns The band rectangle.
   */
  get topBand(): Rect {
    return makeRect(0, 0, this.columns, this.topInsetValue)
  }

  /** The id of the window that owns the keyboard, if any. */
  get activeWindowId(): string | undefined {
    return this.activeId
  }

  /** The window that owns the keyboard, if any. */
  get activeWindow(): Window | undefined {
    return this.windows.find(window => window.id === this.activeId)
  }

  /**
   * Register the render-request hook. Called by the application, which owns the
   * coalescing timer.
   * @param hook - The callback.
   */
  setRenderRequestHook(hook: () => void): void {
    this.onRequestRender = hook
  }

  /** Ask for another frame. Safe to call at any rate; the application coalesces. */
  requestRender(): void {
    this.wantsRender = true
    this.onRequestRender?.()
  }

  /** Whether a frame is due. */
  get dirty(): boolean {
    return this.wantsRender
  }

  /**
   * Attach (or replace) the renderer. Called once the terminal supports are
   * known; until then the manager can still paint into its buffer, which is
   * what the tests do.
   * @param renderer - The renderer.
   */
  attachRenderer(renderer: ScreenRenderer): void {
    this.renderer = renderer
  }

  /**
   * Replace the chrome band heights.
   *
   * The bands are fixed at construction, but the right sizes depend on the
   * screen height, which changes. Re-planning them here keeps one authority for
   * the arithmetic instead of scattering it between the manager and the app.
   * @param top - Rows for the top band.
   * @param bottom - Rows for the bottom band.
   */
  setChrome(top: number, bottom: number): void {
    if (top === this.topInsetValue && bottom === this.bottomInsetValue) return
    this.topInsetValue = Math.max(0, top)
    this.bottomInsetValue = Math.max(0, bottom)
    this.renderer?.invalidate()
    this.requestRender()
  }

  /**
   * Resize the desktop and reflow every window into the new bounds.
   * @param columns - New width.
   * @param rows - New height.
   */
  resize(columns: number, rows: number): void {
    const nextColumns = Math.max(1, columns)
    const nextRows = Math.max(1, rows)
    if (nextColumns === this.columns && nextRows === this.rows) return
    this.columns = nextColumns
    this.rows = nextRows
    // Bands first, windows second: the reflow below lays windows out against
    // the desktop these bands leave, so planning happens here — before any
    // caller of resize() can forget the order.
    if (this.chromePlanner !== undefined) {
      const plan = this.chromePlanner(this.rows)
      this.setChrome(plan.top, plan.bottom)
    }
    const desktop = this.desktop
    for (const window of this.windows) {
      const wasZoomed = window.zoomed
      // Clamp to the room actually left between the window's origin and the
      // desktop's far edge, allowing for a degenerate desktop.
      const maxWidth = Math.max(1, desktop.x + desktop.width - window.rect.x)
      const maxHeight = Math.max(1, desktop.y + desktop.height - window.rect.y)
      if (window.rect.width > maxWidth || window.rect.height > maxHeight) {
        window.setRect(makeRect(
          window.rect.x,
          window.rect.y,
          Math.min(window.rect.width, maxWidth),
          Math.min(window.rect.height, maxHeight),
        ))
      }
      // A zoomed window has no geometry of its own; re-fit it after the clamp,
      // which would otherwise have cleared the zoom.
      if (wasZoomed) {
        window.setRect(desktop)
        window.markZoomed()
      }
    }
    this.renderer?.invalidate()
    this.requestRender()
  }

  /**
   * Apply a new skin.
   * @param skin - The skin to switch to.
   */
  setSkin(skin: Skin): void {
    this.skin = skin
    this.palette = resolvePalette(skin)
    this.requestRender()
  }

  /**
   * Add a window, focusing it.
   * @param spec - The window to create.
   * @returns The live window.
   */
  open(spec: WindowSpec): Window {
    const existing = this.windows.find(window => window.id === spec.id)
    if (existing !== undefined) {
      existing.closed = false
      this.focus(spec.id)
      return existing
    }
    const window = new Window(spec)
    this.windows.push(window)
    if (window.floating) this.floatingOrder.set(window.id, this.nextZ++)
    this.focus(window.id)
    return window
  }

  /**
   * Close (hide) a window. The instance is kept so re-opening restores the
   * same widget, its scroll position, and its selection.
   * @param id - The window id.
   * @returns True when a window was closed.
   */
  close(id: string): boolean {
    const window = this.windows.find(candidate => candidate.id === id)
    if (window === undefined || window.closed) return false
    window.closed = true
    // Closing the modal window ends the modal lock. Without this the dangling
    // id swallowed every later click on every window and re-pinned focus to a
    // window that no longer exists — a desktop wedged by its own close box.
    if (this.modalId === id) this.modalId = undefined
    if (this.activeId === id) {
      // Hand focus to the topmost remaining window, the way a real desktop does.
      const next = this.orderedWindows().filter(candidate => !candidate.closed && candidate.id !== id).pop()
      this.activeId = next?.id
    }
    window.onClose?.()
    this.requestRender()
    return true
  }

  /**
   * Show or hide a window.
   * @param id - The window id.
   * @param open - Whether it should be open.
   */
  setOpen(id: string, open: boolean): void {
    if (open) {
      const window = this.windows.find(candidate => candidate.id === id)
      if (window !== undefined) {
        window.closed = false
        this.focus(id)
      }
      return
    }
    this.close(id)
  }

  /** Whether a window exists and is not closed. */
  isOpen(id: string): boolean {
    const window = this.windows.find(candidate => candidate.id === id)
    return window !== undefined && !window.closed
  }

  /**
   * Look up a window by id.
   * @param id - The window id.
   * @returns The window, open or closed, or undefined.
   */
  get(id: string): Window | undefined {
    return this.windows.find(window => window.id === id)
  }

  /** Every window, open or closed, in listing order. */
  all(): readonly Window[] {
    return this.windows
  }

  /**
   * Raise and focus a window.
   * @param id - The window id.
   * @param options - `raise: false` focuses without changing z-order, which is
   * what a click on an already-focused window should do.
   */
  focus(id: string, options: { raise?: boolean } = {}): void {
    const window = this.windows.find(candidate => candidate.id === id)
    if (window === undefined || window.closed) return
    const changed = this.activeId !== id
    this.activeId = id
    if (options.raise ?? true) {
      if (window.floating) this.floatingOrder.set(id, this.nextZ++)
      else {
        // Move to the end of the normal band, preserving the relative order of
        // floating windows by leaving them where they are in the array.
        const index = this.windows.indexOf(window)
        if (index >= 0) {
          this.windows.splice(index, 1)
          this.windows.push(window)
        }
      }
    }
    // A modal dialog holds the keyboard until it is dismissed; clicking another
    // window must not steal it, or an approval prompt could be answered by
    // accident. A modal id whose window is gone is not a lock, it is a leak —
    // treat it as no modal at all.
    const modal = this.modalId === undefined ? undefined : this.get(this.modalId)
    if (modal !== undefined && !modal.closed && this.modalId !== id) {
      this.activeId = this.modalId
      return
    }
    if (changed || options.raise !== false) this.requestRender()
  }

  /**
   * Mark a window as modal: it keeps the keyboard and swallows clicks aimed at
   * any window beneath it.
   * @param id - The window id, or undefined to clear.
   */
  setModal(id: string | undefined): void {
    this.modalId = id
    if (id !== undefined) this.focus(id)
    this.requestRender()
  }

  /** The window currently holding the keyboard modally, if any. */
  get modalWindowId(): string | undefined {
    return this.modalId
  }

  /**
   * Cycle focus through the open, listed windows.
   * @param direction - `1` for the next window, `-1` for the previous.
   * @returns The newly focused window id, if any.
   */
  cycle(direction: 1 | -1): string | undefined {
    const ordered = this.orderedWindows().filter(window => !window.closed && window.listed)
    if (ordered.length === 0) return undefined
    const current = ordered.findIndex(window => window.id === this.activeId)
    const next = ordered[(current + direction + ordered.length) % ordered.length]
    if (next === undefined) return undefined
    this.focus(next.id)
    return next.id
  }

  /**
   * Toggle the focused window between zoomed and restored.
   * @param id - The window id, defaulting to the focused one.
   */
  toggleZoom(id?: string): void {
    const target = id === undefined ? this.activeWindow : this.get(id)
    if (target === undefined || target.closed) return
    target.zoom(this.desktop)
    this.requestRender()
  }

  /**
   * Tile every open, listed window into a grid, the way `Window ▸ Tile` did.
   * One window fills the desktop; two split it; more than four wrap into rows.
   */
  tile(): void {
    const open = this.orderedWindows().filter(window => !window.closed && window.listed && !window.floating)
    if (open.length === 0) return
    const desktop = this.desktop
    const columns = open.length <= 3 ? 1 : 2
    const rows = Math.ceil(open.length / columns)
    const cellWidth = Math.floor(desktop.width / columns)
    const cellHeight = Math.floor(desktop.height / rows)
    open.forEach((window, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      const isLastColumn = column === columns - 1
      const isLastRow = row === rows - 1
      window.setRect(makeRect(
        desktop.x + column * cellWidth,
        desktop.y + row * cellHeight,
        isLastColumn ? desktop.width - column * cellWidth : cellWidth,
        isLastRow ? desktop.height - row * cellHeight : cellHeight,
      ))
    })
    this.requestRender()
  }

  /**
   * Offset every open window by a step and raise them in order, the way
   * `Window ▸ Cascade` did.
   */
  cascade(): void {
    const open = this.orderedWindows().filter(window => !window.closed && window.listed && !window.floating)
    if (open.length === 0) return
    const desktop = this.desktop
    const stepX = 4
    const stepY = 2
    const baseWidth = Math.max(MIN_WINDOW_WIDTH, Math.floor(desktop.width * 0.62))
    const baseHeight = Math.max(MIN_WINDOW_HEIGHT, Math.floor(desktop.height * 0.62))
    open.forEach((window, index) => {
      const x = desktop.x + (index * stepX) % Math.max(1, desktop.width - baseWidth + stepX)
      const y = desktop.y + (index * stepY) % Math.max(1, desktop.height - baseHeight + stepY)
      window.setRect(makeRect(
        x,
        y,
        Math.min(baseWidth, desktop.x + desktop.width - x),
        Math.min(baseHeight, desktop.y + desktop.height - y),
      ))
      this.focus(window.id)
    })
    this.requestRender()
  }

  /**
   * The windows in compositing and hit-testing order: normal windows in z-order
   * followed by floating windows in their own z-order.
   * @returns The ordered list, lowest first.
   */
  orderedWindows(): Window[] {
    const normal = this.windows.filter(window => !window.floating)
    const floating = this.windows
      .filter(window => window.floating)
      .sort((a, b) => (this.floatingOrder.get(a.id) ?? 0) - (this.floatingOrder.get(b.id) ?? 0))
    return [...normal, ...floating]
  }

  /**
   * The window at a screen point, ignoring closed windows.
   * @param x - Screen column.
   * @param y - Screen row.
   * @returns The topmost window under the point, or undefined on bare desktop.
   */
  windowAt(x: number, y: number): Window | undefined {
    const ordered = this.orderedWindows()
    for (let index = ordered.length - 1; index >= 0; index--) {
      const window = ordered[index]
      if (window === undefined || window.closed) continue
      if (x >= window.rect.x && x < window.rect.x + window.rect.width
        && y >= window.rect.y && y < window.rect.y + window.rect.height) {
        return window
      }
    }
    return undefined
  }

  /**
   * The window menu's contents, for the Window dropdown.
   * @returns One entry per listed window.
   */
  listWindows(): WindowListItem[] {
    return this.windows
      .filter(window => window.listed)
      .map(window => ({
        id: window.id,
        title: window.title,
        active: window.id === this.activeId,
        open: !window.closed,
      }))
  }

  /**
   * Paint the whole desktop.
   * @returns The frame buffer, also retained for {@link lastFrame}.
   */
  paint(): CellBuffer {
    // Alternate buffers, allocating only on a size change. The retained
    // previous frame — the renderer's diff basis — is never written through
    // this reference again, and clear() reuses the cell records it finds, so
    // steady-state painting allocates nothing.
    if (this.spare === undefined || this.spare.width !== this.columns || this.spare.height !== this.rows) {
      this.spare = new CellBuffer(this.columns, this.rows)
    }
    const buffer = this.spare
    this.spare = this.frame
    const desktopStyle: Style = this.palette.desktop
    buffer.clear(desktopStyle)
    const root = new Painter(buffer, makeRect(0, 0, this.columns, this.rows))
    // Too small to compose: say so rather than draw a screen of fragments.
    if (this.columns < this.minimum.columns || this.rows < this.minimum.rows) {
      this.paintTooSmall(root)
      this.frame = buffer
      this.wantsRender = false
      return buffer
    }
    this.paintBackground(root)
    for (const window of this.orderedWindows()) {
      if (window.closed) continue
      this.paintWindow(root, window)
    }
    this.paintChrome(root)
    // The overlay goes last so nothing can cover it. Its region is recorded so
    // input routing can refuse clicks aimed through it.
    const overlay = this.overlayProvider?.(this.palette)
    this.overlayRect = overlay?.rect
    overlay?.draw(root, {
      palette: this.palette,
      focused: false,
      requestRender: () => this.requestRender(),
    })
    this.frame = buffer
    this.wantsRender = false
    return buffer
  }

  /**
   * The notice shown when the terminal is below the usability floor.
   *
   * Kept to what fits, which at 20 columns is very little: the sizes and one
   * instruction. Anything more is itself a wrapping problem.
   * @param root - The root painter.
   */
  private paintTooSmall(root: Painter): void {
    // The constant lines are hoisted: a resize drag repaints dozens of times a
    // second, and only the two size lines differ between paints.
    const lines = [
      TOO_SMALL_TITLE,
      `${this.columns}x${this.rows}`,
      `needs ${this.minimum.columns}x${this.minimum.rows}`,
      ...TOO_SMALL_TAIL,
    ]
    const top = Math.max(0, Math.floor((this.rows - lines.length) / 2))
    for (let index = 0; index < lines.length; index++) {
      const row = top + index
      if (row >= this.rows) break
      const line = lines[index] ?? ''
      // The warning role's hue on the terminal's own background: a bare palette
      // index here would ignore the skin, and the ansi skin exists to remap it.
      root.text(0, row, line, this.columns, { fg: this.palette.warning.fg }, { align: 'center', ellipsis: false })
    }
  }

  /**
   * Whether the screen is large enough to compose a desktop.
   * @returns True when a desktop would be usable.
   */
  get usable(): boolean {
    return this.columns >= this.minimum.columns && this.rows >= this.minimum.rows
  }

  /**
   * Paint the desktop backdrop: a full field of light-shade cells, which is
   * what Borland shipped — `TDeskTop::defaultBkgrnd` is `'\xB0'` (░) painted on
   * every cell, a surface rather than a checkerboard. A window's drop shadow
   * crossing it is what makes the texture read as depth.
   * @param root - The root painter.
   */
  private paintBackground(root: Painter): void {
    const desktop = this.desktop
    const style: Style = this.palette.desktop
    if (desktop.width <= 0 || desktop.height <= 0) return
    const pattern = this.unicode ? '░' : '.'
    for (let y = 0; y < desktop.height; y++) {
      for (let x = 0; x < desktop.width; x++) {
        root.set(desktop.x + x, desktop.y + y, pattern, style)
      }
    }
  }

  /**
   * Paint one window: its content first, then its frame on top, so the frame is
   * never overdrawn by a widget that ignored its bounds.
   * @param root - The root painter.
   * @param window - The window to paint.
   */
  private paintWindow(root: Painter, window: Window): void {
    const active = window.id === this.activeId
    const hidden = this.isHidden(window)
    drawFrame(root, {
      rect: window.rect,
      title: window.title,
      active,
      zoomed: window.zoomed,
      closable: window.closable,
      resizable: window.resizable,
      palette: this.palette,
      scrollbar: window.scrollable ? (window.scroll ?? { offset: 0, total: 1, visible: 1 }) : undefined,
      separatorRow: window.separatorRow,
      paintContent: hidden
        ? undefined
        : (contentPainter) => { this.paintContent(window, contentPainter, active) },
    })
  }

  /**
   * Draw a window's content into its already-cleared interior.
   * @param window - The window.
   * @param contentPainter - A painter clipped to the interior.
   * @param active - Whether this window owns the keyboard.
   */
  private paintContent(window: Window, contentPainter: Painter, active: boolean): void {
    const context: WidgetContext = {
      palette: this.palette,
      focused: active,
      requestRender: () => this.requestRender(),
      origin: { x: contentPainter.x, y: contentPainter.y },
    }
    try {
      window.widget.draw(contentPainter, context)
    } catch (error) {
      // A crashing view must not take the IDE down: the session is still live
      // and the user still needs a working composer.
      this.paintWidgetFailure(contentPainter, error)
    }
    if (window.scrollable) window.scroll = this.measureWindow(window)
    if (active) {
      const cursor = window.widget.cursor?.()
      if (cursor !== undefined) this.cursor = cursor
    }
  }

  /**
   * Whether a window's content is hidden because a modal dialog is open above it.
   * @param window - The window.
   * @returns True when the content should not be painted.
   */
  private isHidden(window: Window): boolean {
    if (this.modalId === undefined || this.modalId === window.id) return false
    const modal = this.get(this.modalId)
    if (modal === undefined || modal.closed) return false
    return !window.floating
  }

  /**
   * Draw an error card inside a window whose widget threw. A crashing view must
   * not take the whole IDE down: the session is still live and the user still
   * needs to be able to type.
   * @param painter - The window's interior.
   * @param error - Whatever was thrown.
   */
  private paintWidgetFailure(painter: Painter, error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    painter.text(0, 0, ' widget failed to render ', painter.width, this.palette.error)
    const lines = message.split('\n')
    let row = 1
    for (const line of lines) {
      if (row >= painter.height) break
      painter.text(0, row, line, painter.width, this.palette.error)
      row++
    }
  }

  /**
   * Paint the top and bottom chrome bands.
   * @param root - The root painter.
   */
  private paintChrome(root: Painter): void {
    if (this.topInsetValue > 0 && this.topChrome !== undefined) {
      const band = new Painter(root.target, makeRect(0, 0, this.columns, this.topInsetValue))
      this.topChrome.draw(band, this.palette, this)
    }
    if (this.bottomInsetValue > 0 && this.bottomChrome !== undefined) {
      const band = new Painter(
        root.target,
        makeRect(0, this.rows - this.bottomInsetValue, this.columns, this.bottomInsetValue),
      )
      this.bottomChrome.draw(band, this.palette, this)
    }
  }

  /**
   * Read the scroll metrics a window's widget reports, if it can.
   * @param window - The window.
   * @returns Scroll offset, total, and visible rows.
   */
  private measureWindow(window: Window): { offset: number; total: number; visible: number } {
    const measurable = window.widget as {
      scrollMetrics?: () => { offset: number; total: number; visible: number } | undefined
    }
    const interior = window.interior
    return measurable.scrollMetrics?.()
      ?? { offset: 0, total: interior.height, visible: interior.height }
  }

  /** The most recently painted frame, for tests and screenshots. */
  lastFrame(): CellBuffer | undefined {
    return this.frame
  }

  /**
   * Paint a frame and return the bytes that make it the terminal's content.
   *
   * The manager does not write: the application owns the terminal handle, so it
   * can order the write against input draining, progress reports, and teardown.
   * @returns The escape sequence to write, or `''` when nothing changed.
   */
  render(): string {
    const buffer = this.paint()
    if (this.renderer === undefined) return ''
    const output = this.renderer.render(buffer, this.cursor)
    this.cursor = HIDDEN_CURSOR
    return output
  }

  /**
   * Handle a decoded input event.
   * @param event - The event from the decoder.
   * @returns True when the event was consumed.
   */
  handle(event: InputEvent): boolean {
    switch (event.type) {
      case 'resize':
        this.resize(event.columns, event.rows)
        return true
      case 'paste':
        return this.dispatchKey({ type: 'key', key: 'paste', text: event.text })
      case 'focus':
        // A window that loses terminal focus drops its drag, so a pointer
        // release delivered to another application cannot leave a window stuck
        // to the cursor.
        if (!event.focused) this.drag = undefined
        return false
      case 'mouse':
        return this.handleMouse(event)
      case 'key':
        return this.dispatchKey(event)
      /* c8 ignore next 2 -- exhaustive over the union. */
      default:
        return false
    }
  }

  /**
   * Route a key: chrome first (so `F10` and accelerators always work), then the
   * focused window.
   * @param event - The decoded key.
   * @returns True when consumed.
   */
  private dispatchKey(event: KeyInput): boolean {
    if (this.topChrome?.onKey?.(event, this) === true) {
      this.requestRender()
      return true
    }
    const active = this.activeWindow
    if (active === undefined || active.closed) {
      if (this.bottomChrome?.onKey?.(event, this) === true) {
        this.requestRender()
        return true
      }
      return false
    }
    const context: WidgetContext = {
      palette: this.palette,
      focused: true,
      requestRender: () => this.requestRender(),
      origin: { x: active.interior.x, y: active.interior.y },
    }
    const consumed = active.widget.onKey?.(event, context) === 1
    if (consumed) this.requestRender()
    else if (this.bottomChrome?.onKey?.(event, this) === true) {
      // Truthful from here too: the chrome answered the key, so the event was
      // consumed even though the focused widget did not. A false return lets a
      // caller re-dispatch what was already handled.
      this.requestRender()
      return true
    }
    return consumed
  }

  /**
   * Route a mouse event: an active drag first, then chrome, then the topmost
   * window under the pointer.
   * @param event - The decoded mouse event.
   * @returns True when consumed.
   */
  private handleMouse(event: MouseInput): boolean {
    // 1. A drag in progress owns every motion event until the button is released.
    //    A terminal that does not report motion bit 32 sends a plain press for
    //    each pointer move, so a live drag must accept presses too.
    if (this.drag !== undefined) {
      const window = this.get(this.drag.windowId)
      if (window === undefined) {
        this.drag = undefined
        return false
      }
      const dx = event.x - this.drag.originX
      const dy = event.y - this.drag.originY
      if (this.drag.kind === 'move') {
        const targetX = this.drag.rect.x + dx
        const targetY = this.drag.rect.y + dy
        window.restoreForDrag(this.drag.rect)
        window.moveTo(targetX, targetY, this.desktop)
      } else {
        window.restoreForDrag(this.drag.rect)
        window.resizeTo(this.drag.rect.width + dx, this.drag.rect.height + dy, this.desktop)
      }
      this.requestRender()
      if (event.kind === 'release') this.drag = undefined
      return true
    }

    // 2. The chrome bands sit above every window.
    const normalized = toMouseEvent(event)
    if (event.kind === 'wheel') {
      if (this.topChrome?.onMouse?.(normalized, this) === true) {
        this.requestRender()
        return true
      }
      if (this.bottomChrome?.onMouse?.(normalized, this) === true) {
        this.requestRender()
        return true
      }
    } else if (event.y < this.topInsetValue || event.y >= this.rows - this.bottomInsetValue) {
      const chrome = event.y < this.topInsetValue ? this.topChrome : this.bottomChrome
      if (chrome?.onMouse?.(normalized, this) === true) {
        this.requestRender()
        return true
      }
      // A click on bare chrome closes any open menu and stops there.
      return true
    }

    // 3. An overlay surface (an open menu) intercepts before any window, so a
    //    click cannot fall through to the window the dropdown is covering.
    if (this.overlayRect !== undefined && this.overlayInput !== undefined) {
      const rect = this.overlayRect
      if (event.x >= rect.x && event.x < rect.x + rect.width
        && event.y >= rect.y && event.y < rect.y + rect.height) {
        if (this.overlayInput(normalized)) {
          this.requestRender()
          return true
        }
      }
    }

    // 4. The topmost window under the pointer.
    const window = this.windowAt(event.x, event.y)
    if (window === undefined) {
      // Bare desktop: clicking it drops focus, the way it did in the era.
      if (event.button === 'left' && event.kind === 'press' && this.modalId === undefined) {
        this.activeId = undefined
        this.requestRender()
        return true
      }
      return false
    }
    if (this.modalId !== undefined && window.id !== this.modalId) return true

    const part = frameHitTest({
      rect: window.rect,
      closable: window.closable,
      resizable: window.resizable,
      scrollbar: window.scrollable ? (window.scroll ?? { offset: 0, total: 1, visible: 1 }) : undefined,
    }, event.x, event.y)

    if (event.kind === 'wheel') {
      this.focus(window.id, { raise: false })
      this.forwardMouse(window, normalized)
      this.requestRender()
      return true
    }

    if (event.kind === 'press' && event.button === 'left') {
      const now = Date.now()
      const previous = this.lastClick
      const isDouble = previous !== undefined
        && previous.id === window.id
        && now - previous.at < 450
        && Math.abs(previous.x - event.x) <= 1
        && Math.abs(previous.y - event.y) <= 1
      this.lastClick = { x: event.x, y: event.y, at: now, id: window.id }

      if (part === 'system' && window.closable) {
        this.close(window.id)
        return true
      }
      if (part === 'zoom' && window.closable) {
        this.toggleZoom(window.id)
        return true
      }
      if (part === 'title' && isDouble && window.resizable) {
        this.toggleZoom(window.id)
        return true
      }
      if ((part === 'title' || part === 'border' || part === 'inside') && !event.alt) {
        this.focus(window.id)
      }
      if (part === 'title') {
        this.drag = { kind: 'move', windowId: window.id, originX: event.x, originY: event.y, rect: window.rect }
        return true
      }
      if (part === 'grip') {
        this.drag = { kind: 'resize', windowId: window.id, originX: event.x, originY: event.y, rect: window.rect }
        return true
      }
      if (part === 'scrollUp') {
        this.forwardMouse(window, { ...normalized, kind: 'wheel', delta: -1 })
        return true
      }
      if (part === 'scrollDown') {
        this.forwardMouse(window, { ...normalized, kind: 'wheel', delta: 1 })
        return true
      }
      if (part === 'inside') {
        this.forwardMouse(window, normalized)
        return true
      }
      return true
    }
    if (part === 'inside' && (event.kind === 'release' || event.button !== 'left')) {
      return this.forwardMouse(window, normalized)
    }
    return false
  }

  /**
   * Hand a mouse event to a window's widget.
   * @param window - The target window.
   * @param event - The event, in screen coordinates.
   * @returns True when the widget consumed it.
   */
  private forwardMouse(window: Window, event: MouseEvent): boolean {
    const interior = window.interior
    const context: WidgetContext = {
      palette: this.palette,
      focused: window.id === this.activeId,
      requestRender: () => this.requestRender(),
      origin: { x: interior.x, y: interior.y },
    }
    const consumed = window.widget.onMouse?.(event, context) === 1
    if (consumed) this.requestRender()
    return consumed
  }

  /**
   * Start a drag programmatically. Exposed for the tests, which drive dragging
   * without synthesising a whole pointer gesture.
   * @param windowId - The window to drag.
   * @param kind - Move or resize.
   * @param originX - The pointer's starting column.
   * @param originY - The pointer's starting row.
   * @returns True when the drag started.
   */
  beginDrag(windowId: string, kind: 'move' | 'resize', originX: number, originY: number): boolean {
    const window = this.get(windowId)
    if (window === undefined || window.closed) return false
    this.drag = { kind, windowId, originX, originY, rect: window.rect }
    return true
  }

  /** Whether a drag is in progress. */
  get dragging(): boolean {
    return this.drag !== undefined
  }

  /** The window id currently being dragged, if any. */
  get draggingId(): string | undefined {
    return this.drag?.windowId
  }

  /** Cancel any in-flight drag without applying further motion. */
  cancelDrag(): void {
    this.drag = undefined
  }
}

/**
 * Convert a decoded terminal mouse report into the widget-layer event.
 * @param event - The decoder's event.
 * @returns The normalised event.
 */
function toMouseEvent(event: MouseInput): MouseEvent {
  return {
    x: event.x,
    y: event.y,
    kind: event.kind,
    button: event.button,
    delta: event.delta,
    shift: event.shift,
    alt: event.alt,
    ctrl: event.ctrl,
  }
}
