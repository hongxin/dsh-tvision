/**
 * Menu bar and status bar tests.
 *
 * The menu is the discoverability surface, so its state machine is worth
 * pinning precisely: which key opens what, whether Left/Right browse the bar
 * without closing the list, whether a disabled item can be reached, and whether
 * a click lands on the item the painter actually drew. The status strip's
 * contract is narrower but just as load-bearing — every `Fn` it advertises must
 * really invoke something.
 */
import { describe, expect, it, vi } from 'vitest'
import { CellBuffer, rect } from '../src/kit/cell.ts'
import { Painter } from '../src/kit/painter.ts'
import { WindowManager } from '../src/kit/wm.ts'
import { Consumed } from '../src/kit/widget.ts'
import { TURBO_VISION, resolvePalette } from '../src/kit/skin.ts'
import {
  MenuBarBase,
  acceleratorSegments,
  parseAccelerator,
  type Menu,
} from '../src/widgets/menubar.ts'
import { StatusBar, formatDuration, formatTokens, pressureBar } from '../src/widgets/statusbar.ts'

const palette = resolvePalette(TURBO_VISION)

/** Build a menu bar with recording actions. */
function buildMenus(log: string[]): Menu[] {
  return [
    {
      id: 'file',
      label: '&File',
      items: () => [
        { id: 'new', label: '&New session', action: () => log.push('new') },
        { id: 'resume', label: '&Resume…', shortcut: 'F3', action: () => log.push('resume') },
        { id: 'sep', label: '', separator: true },
        { id: 'quit', label: 'E&xit', shortcut: 'Ctrl+Q', action: () => log.push('quit') },
      ],
    },
    {
      id: 'view',
      label: '&View',
      items: () => [
        { id: 'files', label: '&Files window', action: () => log.push('files') },
        { id: 'todo', label: '&Todo window', action: () => log.push('todo') },
        {
          id: 'layout',
          label: '&Layout',
          submenu: [
            { id: 'tile', label: '&Tile', action: () => log.push('tile') },
            { id: 'cascade', label: '&Cascade', action: () => log.push('cascade') },
          ],
        },
      ],
    },
    {
      id: 'help',
      label: '&Help',
      items: () => [
        { id: 'keys', label: '&Keyboard', action: () => log.push('keys') },
        { id: 'about', label: '&About', enabled: false, action: () => log.push('about') },
      ],
    },
  ]
}

function drawBar(bar: MenuBarBase, columns = 60, rows = 2): CellBuffer {
  const buffer = new CellBuffer(columns, rows)
  bar.draw(new Painter(buffer, rect(0, 0, columns, 1)), {
    palette,
    focused: false,
    requestRender: () => {},
  })
  return buffer
}

describe('accelerator parsing', () => {
  it('strips the marker and reports the letter', () => {
    expect(parseAccelerator('&File')).toEqual({ text: 'File', accelerator: 'f' })
    expect(parseAccelerator('E&xit')).toEqual({ text: 'Exit', accelerator: 'x' })
  })

  it('handles a label with no marker', () => {
    expect(parseAccelerator('Layout')).toEqual({ text: 'Layout' })
  })

  it('splits a label into styled segments', () => {
    const segments = acceleratorSegments('E&xit', { fg: 1 }, { fg: 2, underline: true })
    expect(segments).toEqual([
      { text: 'E', style: { fg: 1 } },
      { text: 'x', style: { fg: 2, underline: true } },
      { text: 'it', style: { fg: 1 } },
    ])
  })

  it('returns the label as one segment when there is no marker', () => {
    expect(acceleratorSegments('Layout', { fg: 1 }, { fg: 2 })).toEqual([
      { text: 'Layout', style: { fg: 1 } },
    ])
  })
})

describe('menu bar drawing', () => {
  it('draws every menu title', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    const frame = drawBar(bar)
    expect(frame.row(0)).toContain('File')
    expect(frame.row(0)).toContain('View')
    expect(frame.row(0)).toContain('Help')
  })

  it('shows the brand on the right', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    expect(drawBar(bar, 60).row(0)).toContain('dsh tvision')
  })

  it('highlights the active title in bar mode', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    bar.enterBarMode(0)
    const frame = drawBar(bar)
    // The first title starts at column 1 and is drawn with the active style.
    expect(frame.at(1, 0)?.style).toEqual(palette.menuItemActive)
  })
})

describe('keyboard navigation', () => {
  it('opens and closes bar mode with F10', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    expect(bar.active).toBe(false)
    expect(bar.handleKey({ type: 'key', key: 'f10' })).toBe(Consumed.Yes)
    expect(bar.active).toBe(true)
    expect(bar.handleKey({ type: 'key', key: 'f10' })).toBe(Consumed.Yes)
    expect(bar.active).toBe(false)
  })

  it('walks the bar with the arrow keys', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    bar.enterBarMode(0)
    bar.handleKey({ type: 'key', key: 'right' })
    expect(drawBar(bar).at(1, 0)?.style).not.toEqual(palette.menuItemActive)
    expect(bar.active).toBe(true)
  })

  it('opens the highlighted menu with Down', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    bar.enterBarMode(0)
    bar.handleKey({ type: 'key', key: 'down' })
    expect(bar.overlay(palette)).toBeDefined()
  })

  it('closes with Escape', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    bar.enterBarMode(0)
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'escape' })
    expect(bar.active).toBe(false)
    expect(bar.overlay(palette)).toBeUndefined()
  })

  it('opens a menu directly with Alt+letter', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    expect(bar.handleKey({ type: 'key', key: 'h', alt: true })).toBe(Consumed.Yes)
    expect(bar.overlay(palette)).toBeDefined()
  })

  it('ignores an Alt combination that matches no menu', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    expect(bar.handleKey({ type: 'key', key: 'z', alt: true })).toBe(Consumed.No)
  })

  it('swallows unrelated keys while a menu is open', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    bar.enterBarMode(0)
    expect(bar.handleKey({ type: 'key', key: 'q' })).toBe(Consumed.Yes)
  })

  it('passes unrelated keys through when the bar is idle', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    expect(bar.handleKey({ type: 'key', key: 'q' })).toBe(Consumed.No)
  })
})

describe('menu activation', () => {
  it('runs the highlighted item on Enter', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.enterBarMode(0)
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(log).toEqual(['new'])
    // Choosing an item closes the menu.
    expect(bar.active).toBe(false)
  })

  it('runs an item by its accelerator letter', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.enterBarMode(0)
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'r' })
    expect(log).toEqual(['resume'])
  })

  it('skips separators when moving the highlight', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.openById('file')
    // First item is 0; moving down twice must step over the separator to Exit.
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(log).toEqual(['quit'])
  })

  it('wraps the highlight around the ends', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.openById('file')
    bar.handleKey({ type: 'key', key: 'up' })
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(log).toEqual(['quit'])
  })

  it('never lands on a disabled item', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.openById('help')
    // "Keyboard" is enabled and "About" is not, so Down must stay on Keyboard.
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(log).toEqual(['keys'])
  })

  it('does not run a disabled item invoked by accelerator', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.openById('help')
    bar.handleKey({ type: 'key', key: 'a' })
    expect(log).toEqual([])
  })

  it('opens a submenu and runs its item', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    bar.openById('view')
    // Walk down to the Layout entry and open it.
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'down' })
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(bar.overlay(palette)).toBeDefined()
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(log).toEqual(['tile'])
  })

  it('reports unknown menu ids', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    expect(bar.openById('nope')).toBe(false)
    expect(bar.openById('file')).toBe(true)
  })

  it('closes when an item with no action is chosen', () => {
    const bar = new MenuBarBase({
      menus: () => [{ id: 'm', label: '&M', items: () => [{ id: 'x', label: '&X' }] }],
    })
    bar.openById('m')
    bar.handleKey({ type: 'key', key: 'enter' })
    expect(bar.active).toBe(false)
  })
})

describe('mouse interaction', () => {
  it('opens a menu when its title is clicked', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    const frame = drawBar(bar)
    const column = frame.row(0).indexOf('View')
    expect(column).toBeGreaterThan(0)
    expect(bar.handleMouse({ x: column, y: 0, kind: 'press', button: 'left' }, { x: 0, y: 0 })).toBe(Consumed.Yes)
    expect(bar.overlay(palette)).toBeDefined()
  })

  it('closes the menu when its own title is clicked again', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    const frame = drawBar(bar)
    const column = frame.row(0).indexOf('File')
    bar.handleMouse({ x: column, y: 0, kind: 'press', button: 'left' }, { x: 0, y: 0 })
    bar.handleMouse({ x: column, y: 0, kind: 'press', button: 'left' }, { x: 0, y: 0 })
    expect(bar.active).toBe(false)
  })

  it('runs the item a click lands on', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    // Draw once so the layout is known, then open and click row 1.
    drawBar(bar)
    bar.openById('file')
    drawBar(bar)
    const overlay = bar.overlay(palette)
    expect(overlay).toBeDefined()
    const inside = { x: overlay?.rect.x ?? 0, y: (overlay?.rect.y ?? 0) + 1, kind: 'press' as const, button: 'left' as const }
    expect(bar.handleMouse(inside, { x: 0, y: 0 })).toBe(Consumed.Yes)
    expect(log).toEqual(['new'])
  })

  it('ignores a click on a separator row', () => {
    const log: string[] = []
    const bar = new MenuBarBase({ menus: () => buildMenus(log) })
    drawBar(bar)
    bar.openById('file')
    drawBar(bar)
    const overlay = bar.overlay(palette)
    /* c8 ignore next -- the overlay exists after opening. */
    if (overlay === undefined) throw new Error('no overlay')
    // Row 3 is the separator between Resume and Exit.
    bar.handleMouse(
      { x: overlay.rect.x + 1, y: overlay.rect.y + 3, kind: 'press', button: 'left' },
      { x: 0, y: 0 },
    )
    expect(log).toEqual([])
    expect(bar.active).toBe(true)
  })

  it('dismisses the menu on an outside click', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    drawBar(bar)
    bar.openById('file')
    drawBar(bar)
    expect(bar.handleMouse({ x: 40, y: 10, kind: 'press', button: 'left' }, { x: 0, y: 0 })).toBe(Consumed.No)
    expect(bar.active).toBe(false)
  })

  it('reports a click on bare bar space as unconsumed', () => {
    const bar = new MenuBarBase({ menus: () => buildMenus([]) })
    drawBar(bar)
    expect(bar.handleMouse({ x: 55, y: 0, kind: 'press', button: 'left' }, { x: 0, y: 0 })).toBe(Consumed.No)
  })
})

describe('menu overlay above windows', () => {
  it('paints the dropdown over a window that covers the same cells', () => {
    const manager = new WindowManager({ columns: 40, rows: 14, skin: TURBO_VISION })
    const bar = new MenuBarBase({
      menus: () => [{ id: 'file', label: '&File', items: () => [{ id: 'new', label: '&New', action: () => {} }] }],
    })
    manager.topChrome = {
      draw: (painter, _palette, _manager) => bar.draw(painter, { palette, focused: false, requestRender: () => {} }),
      onKey: event => bar.handleKey(event) === Consumed.Yes,
      onMouse: event => bar.handleMouse(event, { x: 0, y: 0 }) === Consumed.Yes,
    }
    manager.overlayProvider = current => bar.overlay(current)
    // A window that would sit exactly where the dropdown lands.
    manager.open({
      id: 'chat',
      title: 'chat',
      rect: rect(0, 1, 40, 12),
      widget: { draw(painter) { painter.fill('.', {}) } },
    })
    bar.openById('file')
    const frame = manager.paint()
    const text = frame.lines().join('\n')
    // The dropdown's label wins over the window's fill.
    expect(text).toContain('New')
    // And wherever the dropdown covers the window, no fill character survives.
    const overlay = bar.overlay(palette)
    /* c8 ignore next -- a layout exists once the menu is open. */
    if (overlay === undefined) throw new Error('no overlay')
    for (let y = overlay.rect.y; y < overlay.rect.y + overlay.rect.height; y++) {
      const row = frame.row(y)
      for (let x = overlay.rect.x; x < overlay.rect.x + overlay.rect.width - 2; x++) {
        expect(row[x], `cell ${x},${y}`).not.toBe('.')
      }
    }
  })
})

describe('status bar', () => {
  const hints = [
    { key: 'f1', label: 'Help', action: () => {} },
    { key: 'f2', label: 'New', action: () => {} },
    { key: 'f6', label: 'Next', action: undefined },
    { key: 'f10', label: 'Menu', action: () => {} },
  ]

  function build(overrides: Partial<ConstructorParameters<typeof StatusBar>[0]> = {}): StatusBar {
    return new StatusBar({
      hints: () => hints,
      status: () => [{ text: 'deepseek-flash' }, { text: '↑1.2k ↓340' }, { text: '42% ctx' }],
      message: () => undefined,
      invoke: () => {},
      ...overrides,
    })
  }

  function draw(bar: StatusBar, columns = 80): CellBuffer {
    const buffer = new CellBuffer(columns, 2)
    bar.draw(new Painter(buffer, rect(0, 0, columns, 2)), {
      palette,
      focused: true,
      requestRender: () => {},
    })
    return buffer
  }

  it('draws the function key strip on the last row', () => {
    const frame = draw(build())
    expect(frame.row(1)).toContain('F1 Help')
    expect(frame.row(1)).toContain('F10 Menu')
  })

  it('draws the status cells right-aligned', () => {
    const frame = draw(build())
    const row = frame.row(0)
    // The rightmost cell must end at the right edge, less its trailing space.
    expect(row).toContain('deepseek-flash')
    expect(row.trimEnd().endsWith('42% ctx')).toBe(true)
    expect(row.trimEnd().length).toBeGreaterThan(row.indexOf('deepseek-flash'))
  })

  it('invokes the hint whose box was clicked', () => {
    const invoke = vi.fn()
    const bar = build({ invoke })
    draw(bar)
    const box = bar.boxes.find(candidate => candidate.key === 'f2')
    /* c8 ignore next -- the strip always has an F2 box here. */
    if (box === undefined) throw new Error('no F2 box')
    bar.handleMouse(
      { x: box.start + 1, y: 1, kind: 'press', button: 'left' },
      { x: 0, y: 0, height: 2 },
    )
    expect(invoke).toHaveBeenCalledWith('f2')
  })

  it('does not invoke on a click on bare strip background', () => {
    const invoke = vi.fn()
    // A single hint occupies one bounded slot, so the rest of the row is not a
    // button even though it is part of the strip.
    const narrow = build({
      invoke,
      hints: () => [{ key: 'f1', label: 'Help', action: () => {} }],
    })
    draw(narrow, 80)
    const box = narrow.boxes[0]
    /* c8 ignore next -- one hint always records one box. */
    if (box === undefined) throw new Error('no box')
    expect(box.end).toBeLessThan(30)
    narrow.handleMouse({ x: 79, y: 1, kind: 'press', button: 'left' }, { x: 0, y: 0, height: 2 })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('invokes the function key from the keyboard', () => {
    const action = vi.fn()
    const bar = build({ hints: () => [{ key: 'f5', label: 'Run', action }] })
    expect(bar.handleKey({ type: 'key', key: 'f5' })).toBe(Consumed.Yes)
    expect(action).toHaveBeenCalled()
  })

  it('leaves a function key with no action unconsumed', () => {
    const bar = build({ hints: () => [{ key: 'f6', label: 'Next' }] })
    expect(bar.handleKey({ type: 'key', key: 'f6' })).toBe(Consumed.No)
  })

  it('ignores a non-function key', () => {
    const bar = build()
    expect(bar.handleKey({ type: 'key', key: 'a' })).toBe(Consumed.No)
  })

  it('shows a transient message in place of the status cells', () => {
    const frame = draw(build({ message: () => ({ text: 'compacting…', tone: 'warning' }) }))
    expect(frame.row(0)).toContain('compacting…')
  })

  it('drops the lowest-priority status cell on a narrow terminal', () => {
    const bar = build({
      status: () => [
        { text: 'context 42%', priority: 1 },
        { text: 'deepseek-flash', priority: 3 },
      ],
    })
    const frame = draw(bar, 24)
    expect(frame.row(0)).toContain('deepseek-flash')
    expect(frame.row(0)).not.toContain('context')
  })

  it('falls back to a menu hint when there are no function keys', () => {
    const frame = draw(build({ hints: () => [] }))
    expect(frame.row(1)).toContain('F10 Menu')
  })
})

describe('status bar formatting', () => {
  it('formats token counts with a magnitude suffix', () => {
    expect(formatTokens(847)).toBe('847')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(45_000)).toBe('45k')
    expect(formatTokens(2_400_000)).toBe('2.4M')
    expect(formatTokens(Number.NaN)).toBe('—')
  })

  it('formats durations compactly', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(184_000)).toBe('3m04s')
    expect(formatDuration(3_720_000)).toBe('1h02m')
    expect(formatDuration(-1)).toBe('—')
  })

  it('draws a pressure bar', () => {
    expect(pressureBar(0, 10)).toBe('░░░░░░░░░░')
    expect(pressureBar(0.5, 10)).toBe('█████░░░░░')
    expect(pressureBar(1, 10)).toBe('██████████')
    expect(pressureBar(2, 4)).toBe('████')
  })
})

describe('hint strip slot arithmetic', () => {
  it('never lets the last slot run past the screen edge', () => {
    // Surplus larger than the slot count (three short hints on a narrow
    // strip) is where the old arithmetic granted the last slot one column
    // too many: the box painted past the edge and the painter clipped it.
    const bar = new StatusBar({
      hints: () => [
        { key: 'f1', label: 'A', action: () => {} },
        { key: 'f2', label: 'B', action: () => {} },
        { key: 'f3', label: 'C', action: () => {} },
      ],
      status: () => [],
      message: () => undefined,
      invoke: () => {},
    })
    const buffer = new CellBuffer(30, 2)
    bar.draw(new Painter(buffer, rect(0, 0, 30, 2)), {
      palette: resolvePalette(TURBO_VISION),
      focused: true,
      requestRender: () => {},
    })
    const boxes = bar.boxes
    const last = boxes[boxes.length - 1]
    if (last === undefined) throw new Error('no hint boxes were recorded')
    expect(last.end).toBeLessThanOrEqual(30)
    // And with surplus flowing past every slot, the strip ends flush.
    expect(last.end).toBe(30)
    expect(boxes[0]?.end ?? 0).toBeGreaterThan(0)
  })
})
