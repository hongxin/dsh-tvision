/**
 * The menu bar and its dropdowns.
 *
 * This is the piece that makes the interface legible to someone who has never
 * seen it: `File  Session  View  Agent  Tools  Window  Help` along the top, each
 * opening a list with accelerator letters underlined. Everything the keyboard
 * can do is reachable here, in the order a person would look for it.
 *
 * Two behaviours from the era are preserved because they are what make a menu
 * bar pleasant rather than merely present:
 *
 * - **F10 enters menu mode** where the arrow keys walk the bar; while a menu is
 *   open, Left/Right switch between the neighbouring menus without closing the
 *   list, so the whole bar can be browsed with four keys.
 * - **Alt+letter opens a menu directly**, and the same letter inside an open
 *   list invokes an item.
 *
 * A dropdown is drawn as an overlay above every window by the window manager
 * (see `WindowManager.setOverlay`), because a menu that a window could cover
 * would be worse than no menu.
 * @module @dsh-tvision/dsh-tvision/widgets/menubar
 */

import type { Rect, Style } from '../kit/cell.ts'
import type { Painter } from '../kit/painter.ts'
import { SINGLE_BOX } from '../kit/painter.ts'
import type { KeyEvent, MouseEvent, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import type { ResolvedPalette } from '../kit/skin.ts'
import { textWidth } from '../kit/text.ts'

/** One row of a dropdown. */
export interface MenuItem {
  /** Stable identity, used by {@link MenuBarBase.invoke}. */
  readonly id: string
  /** The label as displayed; an `&` marks the accelerator letter. */
  readonly label: string
  /** A right-aligned shortcut hint such as `Ctrl+O`. */
  readonly shortcut?: string
  /** Whether the item is selectable right now. */
  readonly enabled?: boolean
  /** A separator row rather than an item. */
  readonly separator?: boolean
  /** A submenu opened instead of invoking an action. */
  readonly submenu?: readonly MenuItem[]
  /** What to run when chosen. */
  readonly action?: () => void
  /** One line explaining the item, shown in the status line. */
  readonly hint?: string
}

/** One top-level menu. */
export interface Menu {
  readonly id: string
  /** The title as displayed; an `&` marks the accelerator letter. */
  readonly label: string
  /** A function returning the current items, so a menu can reflect live state. */
  readonly items: () => readonly MenuItem[]
}

/** The geometry and row mapping of one open dropdown, recomputed each draw. */
interface MenuLayout {
  readonly index: number
  readonly path: readonly number[]
  readonly rect: Rect
  /** One entry per interior row; `undefined` for the border rows. */
  readonly rows: readonly (MenuItem | undefined)[]
  /** The item index shown at each row, or `-1` for border and separator rows. */
  readonly rowOf: readonly number[]
  /** Which item in this list is highlighted, or `-1` when this list is not current. */
  readonly current: number
}

/** A rectangle in screen coordinates that must be repainted, for overlay support. */
export interface OverlayRegion {
  readonly rect: Rect
  readonly draw: (painter: Painter, context: WidgetContext) => void
}

/** Where the menu bar's state machine currently is. */
type MenuMode =
  | { readonly kind: 'idle' }
  | { readonly kind: 'bar'; readonly index: number }
  | { readonly kind: 'open'; readonly index: number; readonly item: number; readonly path: readonly number[] }

/**
 * Strip an accelerator marker and report the letter that carries it.
 * @param label - A label possibly containing `&`.
 * @returns The display label and the accelerator letter, lowercased.
 */
export function parseAccelerator(label: string): { text: string; accelerator?: string } {
  const index = label.indexOf('&')
  if (index < 0) return { text: label }
  const text = label.slice(0, index) + label.slice(index + 1)
  const letter = label[index + 1]
  return letter === undefined ? { text } : { text, accelerator: letter.toLowerCase() }
}

/**
 * Render an item's label with its accelerator underlined.
 *
 * Underlining is an SGR attribute rather than a different colour, because the
 * menu is drawn on a light bar where a colour change would read as emphasis
 * rather than as a keyboard hint — and because that is how the platforms this
 * imitates did it.
 * @param label - The label with an optional `&`.
 * @param style - The row's style.
 * @param acceleratorStyle - Style for the underlined letter.
 * @returns Segments to paint in order.
 */
export function acceleratorSegments(
  label: string,
  style: Style,
  acceleratorStyle: Style,
): { text: string; style: Style }[] {
  const index = label.indexOf('&')
  if (index < 0) return [{ text: label, style }]
  const before = label.slice(0, index)
  const letter = label[index + 1] ?? ''
  const after = label.slice(index + 2)
  const segments: { text: string; style: Style }[] = []
  if (before !== '') segments.push({ text: before, style })
  if (letter !== '') segments.push({ text: letter, style: acceleratorStyle })
  if (after !== '') segments.push({ text: after, style })
  return segments
}

/** The menu bar's data and callbacks. */
export interface MenuBarOptions {
  /** The menus, in bar order. */
  menus(): readonly Menu[]
  /** Called when a menu opens or closes, so the status line can explain it. */
  describe?(menu: Menu | undefined): void
  /** Called when an item is highlighted, for the status line hint. */
  describeItem?(item: MenuItem | undefined): void
}

/**
 * The menu bar.
 *
 * Holds the whole open/closed state machine, including nested submenus, and
 * exposes {@link overlay} so the window manager can paint the open list above
 * every window.
 */
export class MenuBarBase {
  private readonly options: MenuBarOptions
  private mode: MenuMode = { kind: 'idle' }
  /** Title rectangles recorded during the last draw, for click hit-testing. */
  private titleBoxes: { index: number; start: number; end: number }[] = []
  /** The open dropdown's geometry and layout, recorded during the last draw. */
  private openLayout: MenuLayout[] = []

  /**
   * @param options - The menu source and description callbacks.
   */
  constructor(options: MenuBarOptions) {
    this.options = options
  }

  /** Whether the bar is in menu mode (F10 pressed) or a list is open. */
  get active(): boolean {
    return this.mode.kind !== 'idle'
  }

  /** Enter menu mode, highlighting the first menu. */
  enterBarMode(index = 0): void {
    this.mode = { kind: 'bar', index }
    this.options.describe?.(this.options.menus()[index])
  }

  /** Leave menu mode and close every list. */
  close(): void {
    this.mode = { kind: 'idle' }
    this.options.describe?.(undefined)
    this.options.describeItem?.(undefined)
  }

  /**
   * Open a menu by its id, as `Alt+letter` does.
   * @param id - The menu id.
   * @returns True when a menu with that id exists.
   */
  openById(id: string): boolean {
    const index = this.options.menus().findIndex(menu => menu.id === id)
    if (index < 0) return false
    this.mode = { kind: 'open', index, item: this.firstSelectable(index, []), path: [] }
    this.options.describe?.(this.options.menus()[index])
    return true
  }

  /**
   * Handle a key while the bar is active.
   * @param event - The decoded key.
   * @returns Whether the key was consumed.
   */
  handleKey(event: KeyEvent): Consumed {
    const menus = this.options.menus()
    if (event.key === 'f10') {
      if (this.mode.kind === 'idle') this.enterBarMode(0)
      else this.close()
      return Consumed.Yes
    }
    // Alt+letter opens a menu directly, whether or not the bar is active.
    if (event.alt === true && event.key.length === 1) {
      const index = menus.findIndex(menu => parseAccelerator(menu.label).accelerator === event.key)
      if (index >= 0) {
        this.mode = { kind: 'open', index, item: this.firstSelectable(index, []), path: [] }
        this.options.describe?.(menus[index])
        return Consumed.Yes
      }
      return Consumed.No
    }
    if (this.mode.kind === 'idle') return Consumed.No

    switch (event.key) {
      case 'escape':
        this.close()
        return Consumed.Yes
      case 'left':
        this.mode = this.mode.kind === 'bar'
          ? { kind: 'bar', index: (this.mode.index - 1 + menus.length) % menus.length }
          : { kind: 'open', index: (this.mode.index - 1 + menus.length) % menus.length, item: this.firstSelectable((this.mode.index - 1 + menus.length) % menus.length, []), path: [] }
        this.options.describe?.(menus[this.mode.index])
        return Consumed.Yes
      case 'right':
        this.mode = this.mode.kind === 'bar'
          ? { kind: 'bar', index: (this.mode.index + 1) % menus.length }
          : { kind: 'open', index: (this.mode.index + 1) % menus.length, item: this.firstSelectable((this.mode.index + 1) % menus.length, []), path: [] }
        this.options.describe?.(menus[this.mode.index])
        return Consumed.Yes
      case 'down':
        if (this.mode.kind === 'bar') {
          this.mode = { kind: 'open', index: this.mode.index, item: this.firstSelectable(this.mode.index, []), path: [] }
          this.options.describe?.(menus[this.mode.index])
          return Consumed.Yes
        }
        this.moveItem(1)
        return Consumed.Yes
      case 'up':
        if (this.mode.kind === 'bar') {
          this.mode = { kind: 'open', index: this.mode.index, item: this.firstSelectable(this.mode.index, []), path: [] }
          this.options.describe?.(menus[this.mode.index])
          return Consumed.Yes
        }
        this.moveItem(-1)
        return Consumed.Yes
      case 'enter':
      case 'space':
        if (this.mode.kind === 'bar') {
          this.mode = { kind: 'open', index: this.mode.index, item: this.firstSelectable(this.mode.index, []), path: [] }
          return Consumed.Yes
        }
        this.activateCurrent()
        return Consumed.Yes
      default:
        break
    }
    // A bare letter inside an open list invokes the matching accelerator.
    if (this.mode.kind === 'open' && event.key.length === 1 && event.alt !== true) {
      const items = this.itemsAt(this.mode.index, this.mode.path)
      const target = items.find((item) => {
        if (item.separator === true || item.enabled === false) return false
        return parseAccelerator(item.label).accelerator === event.key
      })
      if (target !== undefined) {
        this.run(target)
        return Consumed.Yes
      }
    }
    // Swallow everything else so the focused window does not act on a key aimed
    // at an open menu; that is the whole point of menu mode.
    return Consumed.Yes
  }

  /**
   * Handle a click on the bar or in an open list.
   * @param event - The mouse event, in screen coordinates.
   * @param origin - The bar's origin within the desktop.
   * @returns Whether the event was consumed.
   */
  handleMouse(event: MouseEvent, origin: { x: number; y: number }): Consumed {
    const localColumn = event.x - origin.x
    // A click on a title.
    if (event.y === origin.y) {
      const box = this.titleBoxes.find(candidate => localColumn >= candidate.start && localColumn < candidate.end)
      if (box === undefined) {
        if (this.mode.kind !== 'idle') this.close()
        return Consumed.No
      }
      if (event.kind === 'press') {
        // Clicking the open menu's own title closes it; clicking another swaps.
        if (this.mode.kind === 'open' && this.mode.index === box.index && this.mode.path.length === 0) this.close()
        else this.mode = { kind: 'open', index: box.index, item: this.firstSelectable(box.index, []), path: [] }
        return Consumed.Yes
      }
      return Consumed.No
    }
    if (this.mode.kind !== 'open' || event.kind !== 'press') return Consumed.No
    // A click inside the deepest open list.
    for (let depth = this.openLayout.length - 1; depth >= 0; depth--) {
      const layout = this.openLayout[depth]
      /* c8 ignore next -- depth is in range. */
      if (layout === undefined) continue
      const { rect } = layout
      if (event.x < rect.x || event.x >= rect.x + rect.width) continue
      if (event.y < rect.y || event.y >= rect.y + rect.height) continue
      const row = event.y - rect.y
      const itemIndex = layout.rowOf[row]
      if (itemIndex === undefined) continue
      const item = layout.rows[row]
      if (item === undefined || item.separator === true || item.enabled === false) return Consumed.Yes
      this.mode = { kind: 'open', index: layout.index, item: itemIndex, path: layout.path }
      this.activateCurrent()
      return Consumed.Yes
    }
    // A click anywhere else dismisses the menu without acting.
    this.close()
    return Consumed.No
  }

  /**
   * The dropdown to paint above every window, if one is open.
   *
   * The layout is computed here rather than read from the last draw, because
   * the window manager paints the bar and reads the overlay in the same frame
   * and the order must not matter.
   * @param palette - The palette.
   * @returns The overlay region, or undefined when the bar is idle or closed.
   */
  overlay(palette: ResolvedPalette): OverlayRegion | undefined {
    if (this.mode.kind !== 'open') return undefined
    this.openLayout = this.computeLayouts()
    const layouts = this.openLayout
    if (layouts.length === 0) return undefined
    const first = layouts[0]
    /* c8 ignore next -- guarded above. */
    if (first === undefined) return undefined
    let minX = first.rect.x
    let minY = first.rect.y
    let maxX = first.rect.x + first.rect.width
    let maxY = first.rect.y + first.rect.height
    for (const layout of layouts) {
      minX = Math.min(minX, layout.rect.x)
      minY = Math.min(minY, layout.rect.y)
      maxX = Math.max(maxX, layout.rect.x + layout.rect.width)
      maxY = Math.max(maxY, layout.rect.y + layout.rect.height)
    }
    return {
      rect: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
      draw: (painter) => {
        for (const layout of layouts) this.drawList(painter, layout, palette)
      },
    }
  }

  /**
   * Draw the bar itself.
   * @param painter - The top band.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    painter.fillRow(0, palette.menuBar)
    this.titleBoxes = []
    this.openLayout = []
    let column = 1
    const menus = this.options.menus()
    for (let index = 0; index < menus.length; index++) {
      const menu = menus[index]
      /* c8 ignore next -- index is in range. */
      if (menu === undefined) continue
      const { text } = parseAccelerator(menu.label)
      const selected = (this.mode.kind === 'bar' || this.mode.kind === 'open') && this.mode.index === index
      const style = selected ? palette.menuItemActive : palette.menuItem
      const width = textWidth(text) + 2
      painter.text(column, 0, ` ${text} `, width, style)
      this.titleBoxes.push({ index, start: column, end: column + width })
      column += width
    }
    // The right-hand side of the bar carries the identity of the thing, which is
    // where a Borland application put its name and version.
    const brand = 'dsh tvision'
    const brandWidth = textWidth(brand) + 2
    if (painter.width > column + brandWidth) {
      painter.text(painter.width - brandWidth - 1, 0, ` ${brand} `, brandWidth, palette.menuItem)
    }
    // Record the layout so a click can be resolved against what was drawn.
    this.openLayout = this.computeLayouts()
  }

  /**
   * Compute the geometry of the open dropdown and any nested submenu, so the
   * overlay, the hit test, and the painter all agree on where things are.
   * @returns One layout per open list, outermost first.
   */
  private computeLayouts(): MenuLayout[] {
    if (this.mode.kind !== 'open') return []
    const layouts: MenuLayout[] = []
    let index = this.mode.index
    let path: readonly number[] = this.mode.path
    let y = 1
    for (;;) {
      const items = this.itemsAt(index, path)
      if (items.length === 0) break
      const width = this.listWidth(items)
      let x: number
      if (layouts.length === 0) {
        const title = this.titleBoxes.find(box => box.index === index)
        x = title?.start ?? 1
      } else {
        const parent = layouts[layouts.length - 1]
        /* c8 ignore next -- layouts.length > 0 here. */
        if (parent === undefined) break
        // A submenu overlaps its parent's right border by one cell, the way a
        // real menu does, so the two frames read as connected.
        x = parent.rect.x + parent.rect.width - 1
      }
      const rows: (MenuItem | undefined)[] = [undefined, ...items, undefined]
      const rowOf: number[] = rows.map((item, row) => (
        row === 0 || row === rows.length - 1 || item === undefined ? -1 : row - 1
      ))
      const isDeepest = path === this.mode.path
      layouts.push({
        index,
        path,
        rect: { x, y, width, height: items.length + 2 },
        rows,
        rowOf,
        current: isDeepest ? this.mode.item : -1,
      })
      const highlighted = items[this.mode.item]
      if (!isDeepest || highlighted?.submenu === undefined || highlighted.submenu.length === 0) break
      path = [...path, this.mode.item]
      y += this.mode.item + 1
    }
    return layouts
  }

  /**
   * The widest label in a list, so the dropdown is as narrow as it can be.
   * @param items - The items.
   * @returns The interior width, including the shortcut column.
   */
  private listWidth(items: readonly MenuItem[]): number {
    let widest = 0
    for (const item of items) {
      if (item.separator === true) continue
      const { text } = parseAccelerator(item.label)
      widest = Math.max(widest, textWidth(text) + 4)
      if (item.shortcut !== undefined) widest = Math.max(widest, textWidth(text) + textWidth(item.shortcut) + 6)
      if (item.submenu !== undefined) widest = Math.max(widest, textWidth(text) + 6)
    }
    return Math.max(14, widest)
  }

  /**
   * The items at a menu index and submenu path.
   * @param index - The top-level menu index.
   * @param path - The indices walked into nested submenus.
   * @returns The items, or an empty list when the path does not resolve.
   */
  private itemsAt(index: number, path: readonly number[]): readonly MenuItem[] {
    let items = this.options.menus()[index]?.items() ?? []
    for (const step of path) {
      const item = items[step]
      if (item?.submenu === undefined) return []
      items = item.submenu
    }
    return items
  }

  /**
   * Index of the first selectable item, so opening a menu never lands on a
   * separator.
   * @param index - The menu index.
   * @param path - The submenu path.
   * @returns The item index, or 0 when the list is empty.
   */
  private firstSelectable(index: number, path: readonly number[]): number {
    const items = this.itemsAt(index, path)
    const found = items.findIndex(item => item.separator !== true && item.enabled !== false)
    return found < 0 ? 0 : found
  }

  /**
   * Move the highlight by a step, skipping separators and disabled items.
   * @param step - `1` down, `-1` up.
   */
  private moveItem(step: 1 | -1): void {
    if (this.mode.kind !== 'open') return
    const items = this.itemsAt(this.mode.index, this.mode.path)
    if (items.length === 0) return
    let next = this.mode.item
    for (let attempt = 0; attempt < items.length; attempt++) {
      next = (next + step + items.length) % items.length
      const item = items[next]
      if (item !== undefined && item.separator !== true && item.enabled !== false) break
    }
    this.mode = { ...this.mode, item: next }
    this.options.describeItem?.(this.itemsAt(this.mode.index, this.mode.path)[next])
  }

  /** Invoke the highlighted item, or open its submenu. */
  private activateCurrent(): void {
    if (this.mode.kind !== 'open') return
    const item = this.itemsAt(this.mode.index, this.mode.path)[this.mode.item]
    if (item === undefined) return
    if (item.submenu !== undefined) {
      this.mode = { kind: 'open', index: this.mode.index, item: this.firstSelectable(this.mode.index, [...this.mode.path, this.mode.item]), path: [...this.mode.path, this.mode.item] }
      return
    }
    this.run(item)
  }

  /**
   * Run an item's action and close the menu.
   * @param item - The chosen item.
   */
  private run(item: MenuItem): void {
    if (item.enabled === false || item.separator === true) return
    this.close()
    item.action?.()
  }

  /**
   * Paint one dropdown list.
   * @param painter - The overlay painter.
   * @param layout - The list's geometry and row mapping.
   * @param palette - The palette.
   */
  private drawList(painter: Painter, layout: MenuLayout, palette: ResolvedPalette): void {
    const { rect, rows, rowOf, current } = layout
    const localX = rect.x - painter.x
    const localY = rect.y - painter.y
    // The frame first, then the shadow: a dropdown's shadow starts one column
    // *outside* its right border, and drawing it first let the border's own
    // bottom-right corner erase the first cell of the shadow band.
    painter.box(localX, localY, rect.width, rect.height, palette.menuFrame, SINGLE_BOX)
    painter.shadow(localX, localY, rect.width, rect.height, palette.shadow, 2, 1)
    const innerWidth = Math.max(0, rect.width - 2)
    for (let row = 1; row < rows.length - 1; row++) {
      const item = rows[row]
      if (item === undefined) continue
      if (item.separator === true) {
        for (let column = 0; column < innerWidth; column++) {
          painter.set(localX + 1 + column, localY + row, '─', palette.menuFrame)
        }
        continue
      }
      const enabled = item.enabled !== false
      const isCurrent = current === (rowOf[row] ?? -1)
      const style = !enabled
        ? palette.menuDisabled
        : isCurrent ? palette.menuSelected : palette.menuNormal
      const acceleratorStyle = enabled && !isCurrent ? palette.menuShortcut : style
      // Paint the whole row first so the highlight spans the list, then the
      // label over it.
      for (let column = 0; column < innerWidth; column++) {
        painter.set(localX + 1 + column, localY + row, ' ', style)
      }
      let column = 1
      for (const segment of acceleratorSegments(item.label, style, acceleratorStyle)) {
        const width = textWidth(segment.text)
        if (column + width > rect.width - 1) break
        painter.text(localX + column, localY + row, segment.text, width, segment.style)
        column += width
      }
      const trailer = item.submenu !== undefined ? '▸' : (item.shortcut ?? '')
      if (trailer !== '') {
        const width = textWidth(trailer)
        painter.text(localX + rect.width - 1 - width, localY + row, trailer, width, style)
      }
    }
  }
}
