/**
 * Window manager tests.
 *
 * These cover the behaviour that makes the desktop feel like a window manager
 * rather than a layout: raising on click, dragging by the title bar, resizing
 * by the grip, zooming, tiling, cascading, and modal lock. They drive the
 * manager through its public API and assert on the painted frame and the input
 * routing, which is exactly the surface the application uses.
 */
import { describe, expect, it } from 'vitest'
import { rect } from '../src/kit/cell.ts'
import { Painter } from '../src/kit/painter.ts'
import { WindowManager } from '../src/kit/wm.ts'
import type { InputEvent, MouseInput } from '../src/kit/input.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from '../src/kit/widget.ts'
import { Consumed } from '../src/kit/widget.ts'
import { frameHitTest, interiorRect } from '../src/widgets/frame.ts'
import { TURBO_VISION, resolvePalette, DEFAULT_SKIN_ID, SKINS, findSkin, skinOrDefault } from '../src/kit/skin.ts'
import { DEFAULT_SKIN_ID as DEFAULT_ID } from '../src/kit/skin.ts'

/** A widget that records what it was asked to do. */
class SpyWidget implements Widget {
  drawn = 0
  keys: KeyEvent[] = []
  mouse: MouseEvent[] = []
  consumed = true
  width = 0
  height = 0

  draw(painter: Painter, _context: WidgetContext): void {
    this.drawn++
    this.width = painter.width
    this.height = painter.height
    painter.text(0, 0, 'x'.repeat(painter.width), painter.width, {})
  }

  onKey(event: KeyEvent): Consumed {
    this.keys.push(event)
    return this.consumed ? Consumed.Yes : Consumed.No
  }

  onMouse(event: MouseEvent): Consumed {
    this.mouse.push(event)
    return this.consumed ? Consumed.Yes : Consumed.No
  }
}

function makeManager(columns = 80, rows = 24): WindowManager {
  return new WindowManager({ columns, rows, skin: TURBO_VISION })
}

function openWindow(
  manager: WindowManager,
  id: string,
  widget: Widget,
  geometry = rect(5, 3, 30, 10),
): void {
  manager.open({ id, title: id, rect: geometry, widget, closable: true })
}

const press = (x: number, y: number): MouseInput => ({ type: 'mouse', x, y, kind: 'press', button: 'left', shift: false, alt: false, ctrl: false })
const dragAt = (x: number, y: number): MouseInput => ({ type: 'mouse', x, y, kind: 'drag', button: 'left', shift: false, alt: false, ctrl: false })
const release = (x: number, y: number): MouseInput => ({ type: 'mouse', x, y, kind: 'release', button: 'left', shift: false, alt: false, ctrl: false })
const wheel = (x: number, y: number, delta: number): InputEvent => ({ type: 'mouse', x, y, kind: 'wheel', button: 'none', delta, shift: false, alt: false, ctrl: false })
const key = (name: string, text?: string): InputEvent => ({ type: 'key', key: name, ...(text === undefined ? {} : { text }) })

describe('desktop geometry', () => {
  it('reserves the top menu bar and the bottom status bands', () => {
    const manager = makeManager(80, 24)
    expect(manager.desktop).toEqual({ x: 0, y: 1, width: 80, height: 21 })
  })

  it('keeps a usable desktop on a tiny terminal', () => {
    const manager = makeManager(10, 4)
    expect(manager.desktop.height).toBeGreaterThanOrEqual(1)
  })
})

describe('window lifecycle', () => {
  it('opens a window and focuses it', () => {
    const manager = makeManager()
    openWindow(manager, 'chat', new SpyWidget())
    expect(manager.isOpen('chat')).toBe(true)
    expect(manager.activeWindowId).toBe('chat')
  })

  it('re-opening an existing window restores it without duplicating the widget', () => {
    const manager = makeManager()
    const widget = new SpyWidget()
    openWindow(manager, 'chat', widget)
    manager.close('chat')
    openWindow(manager, 'chat', new SpyWidget())
    expect(manager.all()).toHaveLength(1)
    expect(manager.get('chat')?.widget).toBe(widget)
    expect(manager.isOpen('chat')).toBe(true)
  })

  it('hands focus to the next window when the focused one closes', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget())
    openWindow(manager, 'b', new SpyWidget())
    expect(manager.activeWindowId).toBe('b')
    manager.close('b')
    expect(manager.activeWindowId).toBe('a')
  })

  it('lists windows for the Window menu', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget())
    openWindow(manager, 'b', new SpyWidget())
    expect(manager.listWindows().map(item => item.id)).toEqual(['a', 'b'])
    expect(manager.listWindows()[1]?.active).toBe(true)
  })
})

describe('z-order and hit testing', () => {
  it('raises a window when it is focused', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(0, 1, 40, 10))
    openWindow(manager, 'b', new SpyWidget(), rect(0, 1, 40, 10))
    expect(manager.windowAt(10, 5)?.id).toBe('b')
    manager.focus('a')
    expect(manager.windowAt(10, 5)?.id).toBe('a')
  })

  it('finds no window on bare desktop', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(0, 1, 10, 5))
    expect(manager.windowAt(50, 20)).toBeUndefined()
  })

  it('keeps floating windows above normal ones regardless of order', () => {
    const manager = makeManager()
    manager.open({
      id: 'dialog', title: 'Dialog', rect: rect(2, 2, 20, 8), widget: new SpyWidget(), floating: true,
    })
    openWindow(manager, 'chat', new SpyWidget(), rect(0, 1, 60, 20))
    // The chat window was focused last but the dialog still wins the hit test.
    expect(manager.windowAt(5, 5)?.id).toBe('dialog')
  })

  it('routes a click to the topmost window under the pointer', () => {
    const manager = makeManager()
    const lower = new SpyWidget()
    const upper = new SpyWidget()
    openWindow(manager, 'lower', lower, rect(0, 1, 40, 15))
    openWindow(manager, 'upper', upper, rect(0, 1, 40, 15))
    manager.handle(press(10, 5))
    expect(upper.mouse).toHaveLength(1)
    expect(lower.mouse).toHaveLength(0)
  })

  it('drops focus when the bare desktop is clicked', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(0, 1, 10, 5))
    manager.handle(press(60, 20))
    expect(manager.activeWindowId).toBeUndefined()
  })

  it('cycles focus in both directions', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget())
    openWindow(manager, 'b', new SpyWidget())
    openWindow(manager, 'c', new SpyWidget())
    expect(manager.cycle(1)).toBe('a')
    expect(manager.cycle(-1)).toBe('c')
  })
})

describe('dragging', () => {
  it('starts a move drag from the title bar', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.handle(press(10, 3))
    expect(manager.dragging).toBe(true)
    expect(manager.draggingId).toBe('a')
  })

  it('moves the window with the pointer', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.handle(press(10, 3))
    manager.handle(dragAt(20, 8))
    expect(manager.get('a')?.rect.x).toBe(15)
    expect(manager.get('a')?.rect.y).toBe(8)
  })

  it('recomputes from the original rectangle so a long drag does not drift', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.handle(press(10, 3))
    for (let step = 1; step <= 20; step++) manager.handle(dragAt(10 + step, 3 + step))
    manager.handle(dragAt(10, 3))
    // Returning the pointer to its origin must return the window exactly.
    expect(manager.get('a')?.rect).toEqual(rect(5, 3, 30, 10))
  })

  it('ends the drag on release', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.handle(press(10, 3))
    manager.handle(release(12, 4))
    expect(manager.dragging).toBe(false)
  })

  it('keeps the title bar reachable when dragged off the top', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 5, 30, 10))
    manager.handle(press(10, 5))
    manager.handle(dragAt(10, -50))
    expect(manager.get('a')?.rect.y).toBe(manager.desktop.y)
  })

  it('never lets a window be dragged entirely off the right edge', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 5, 30, 10))
    manager.handle(press(10, 5))
    manager.handle(dragAt(500, 5))
    const geometry = manager.get('a')?.rect
    /* c8 ignore next -- the window always exists here. */
    if (geometry === undefined) throw new Error('window missing')
    expect(geometry.x + 6).toBeLessThanOrEqual(manager.desktop.width)
  })

  it('ignores motion after the drag is cancelled', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.handle(press(10, 3))
    manager.cancelDrag()
    manager.handle(dragAt(40, 10))
    expect(manager.get('a')?.rect).toEqual(rect(5, 3, 30, 10))
  })
})

describe('resizing', () => {
  it('resizes from the bottom-right grip', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 20, 8))
    // The grip sits one cell inside the bottom-right corner.
    manager.handle(press(5 + 20 - 2, 3 + 8 - 1))
    expect(manager.dragging).toBe(true)
    manager.handle(dragAt(5 + 20 - 2 + 6, 3 + 8 - 1 + 3))
    expect(manager.get('a')?.rect.width).toBe(26)
    expect(manager.get('a')?.rect.height).toBe(11)
  })

  it('enforces a minimum size', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 20, 8))
    manager.handle(press(5 + 20 - 2, 3 + 8 - 1))
    manager.handle(dragAt(0, 0))
    expect(manager.get('a')?.rect.width).toBeGreaterThanOrEqual(12)
    expect(manager.get('a')?.rect.height).toBeGreaterThanOrEqual(4)
  })

  it('will not grow past the desktop edge', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(10, 5, 20, 8))
    manager.handle(press(10 + 20 - 2, 5 + 8 - 1))
    manager.handle(dragAt(500, 500))
    const geometry = manager.get('a')?.rect
    /* c8 ignore next -- the window always exists here. */
    if (geometry === undefined) throw new Error('window missing')
    expect(geometry.x + geometry.width).toBeLessThanOrEqual(manager.desktop.width)
    expect(geometry.y + geometry.height).toBeLessThanOrEqual(manager.desktop.y + manager.desktop.height)
  })
})

describe('system and zoom boxes', () => {
  it('closes the window from the system box', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    // The system box is three cells in from the right of the title bar.
    manager.handle(press(5 + 30 - 3, 3))
    expect(manager.isOpen('a')).toBe(false)
  })

  it('zooms from the zoom box and restores on a second press', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    // The zoom box is the rightmost cell of the title bar.
    manager.handle(press(5 + 30 - 1, 3))
    expect(manager.get('a')?.rect).toEqual(manager.desktop)
    expect(manager.get('a')?.zoomed).toBe(true)
    // After zooming, the zoom box has moved to the desktop's own right edge.
    manager.handle(press(manager.desktop.width - 1, manager.desktop.y))
    expect(manager.get('a')?.rect).toEqual(rect(5, 3, 30, 10))
    expect(manager.get('a')?.zoomed).toBe(false)
  })

  it('zooms on a double click of the title bar', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.handle(press(10, 3))
    manager.handle(release(10, 3))
    manager.handle(press(10, 3))
    expect(manager.get('a')?.zoomed).toBe(true)
  })
})

describe('layout commands', () => {
  it('tiles windows into a grid', () => {
    const manager = makeManager(80, 24)
    openWindow(manager, 'a', new SpyWidget())
    openWindow(manager, 'b', new SpyWidget())
    manager.tile()
    const a = manager.get('a')?.rect
    const b = manager.get('b')?.rect
    /* c8 ignore next -- both windows exist here. */
    if (a === undefined || b === undefined) throw new Error('windows missing')
    expect(a.x).toBe(0)
    expect(b.y).toBeGreaterThan(a.y)
    expect(a.width).toBe(80)
  })

  it('cascades windows with a stair-step offset', () => {
    const manager = makeManager(80, 24)
    openWindow(manager, 'a', new SpyWidget())
    openWindow(manager, 'b', new SpyWidget())
    manager.cascade()
    const a = manager.get('a')?.rect
    const b = manager.get('b')?.rect
    /* c8 ignore next -- both windows exist here. */
    if (a === undefined || b === undefined) throw new Error('windows missing')
    expect(b.x).toBeGreaterThan(a.x)
    expect(b.y).toBeGreaterThan(a.y)
  })

  it('leaves floating windows out of tiling', () => {
    const manager = makeManager()
    manager.open({ id: 'dlg', title: 'd', rect: rect(2, 2, 20, 6), widget: new SpyWidget(), floating: true })
    openWindow(manager, 'a', new SpyWidget())
    const before = manager.get('dlg')?.rect
    manager.tile()
    expect(manager.get('dlg')?.rect).toEqual(before)
  })
})

describe('modal windows', () => {
  it('keeps the keyboard on the modal window', () => {
    const manager = makeManager()
    const other = new SpyWidget()
    const modal = new SpyWidget()
    openWindow(manager, 'chat', other)
    manager.open({ id: 'ask', title: 'ask', rect: rect(10, 5, 40, 8), widget: modal, floating: true })
    manager.setModal('ask')
    manager.focus('chat')
    expect(manager.activeWindowId).toBe('ask')
  })

  it('swallows clicks aimed at windows underneath', () => {
    const manager = makeManager()
    const other = new SpyWidget()
    openWindow(manager, 'chat', other, rect(0, 1, 60, 20))
    manager.open({ id: 'ask', title: 'ask', rect: rect(10, 5, 20, 5), widget: new SpyWidget(), floating: true })
    manager.setModal('ask')
    manager.handle(press(40, 15))
    expect(other.mouse).toHaveLength(0)
  })

  it('releases the lock when cleared', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget())
    openWindow(manager, 'b', new SpyWidget())
    manager.setModal('b')
    manager.setModal(undefined)
    manager.focus('a')
    expect(manager.activeWindowId).toBe('a')
  })
})

describe('keyboard routing', () => {
  it('offers the key to the focused window', () => {
    const manager = makeManager()
    const widget = new SpyWidget()
    openWindow(manager, 'a', widget)
    manager.handle(key('x', 'x'))
    expect(widget.keys).toEqual([{ type: 'key', key: 'x', text: 'x' }])
  })

  it('reports whether the key was consumed', () => {
    const manager = makeManager()
    const widget = new SpyWidget()
    openWindow(manager, 'a', widget)
    expect(manager.handle(key('x'))).toBe(true)
    widget.consumed = false
    expect(manager.handle(key('y'))).toBe(false)
  })

  it('does nothing with no focused window', () => {
    const manager = makeManager()
    expect(manager.handle(key('x'))).toBe(false)
  })
})

describe('wheel routing', () => {
  it('scrolls the window under the pointer without raising it', () => {
    const manager = makeManager()
    const lower = new SpyWidget()
    openWindow(manager, 'lower', lower, rect(0, 1, 40, 15))
    openWindow(manager, 'upper', new SpyWidget(), rect(0, 1, 40, 5))
    manager.focus('lower')
    manager.handle(wheel(10, 12, 1))
    expect(lower.mouse.at(-1)?.kind).toBe('wheel')
    expect(lower.mouse.at(-1)?.delta).toBe(1)
    expect(manager.activeWindowId).toBe('lower')
  })
})

describe('resize reflow', () => {
  it('shrinks a window that would hang off the new edge', () => {
    const manager = makeManager(80, 24)
    openWindow(manager, 'a', new SpyWidget(), rect(40, 5, 35, 10))
    manager.resize(50, 24)
    const geometry = manager.get('a')?.rect
    /* c8 ignore next -- the window always exists here. */
    if (geometry === undefined) throw new Error('window missing')
    expect(geometry.x + geometry.width).toBeLessThanOrEqual(50)
    expect(geometry.width).toBeGreaterThanOrEqual(1)
  })

  it('refits a zoomed window to the resized desktop', () => {
    const manager = makeManager(80, 24)
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.toggleZoom('a')
    expect(manager.get('a')?.rect).toEqual(manager.desktop)
    manager.resize(100, 30)
    // A zoomed window tracks the desktop rather than keeping the old extent.
    expect(manager.get('a')?.rect).toEqual(manager.desktop)
    expect(manager.get('a')?.rect.width).toBe(100)
    expect(manager.get('a')?.rect.height).toBe(27)
  })

  it('ignores a no-op resize', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget(), rect(5, 3, 30, 10))
    manager.resize(80, 24)
    expect(manager.get('a')?.rect).toEqual(rect(5, 3, 30, 10))
  })
})

describe('frame hit testing', () => {
  const options = {
    rect: rect(2, 2, 20, 8),
    closable: true,
    resizable: true,
    scrollbar: undefined,
  }

  it('classifies the title bar, boxes, borders, grip, and interior', () => {
    expect(frameHitTest(options, 10, 2)).toBe('title')
    expect(frameHitTest(options, 2 + 20 - 1, 2)).toBe('zoom')
    expect(frameHitTest(options, 2 + 20 - 3, 2)).toBe('system')
    expect(frameHitTest(options, 2, 5)).toBe('border')
    expect(frameHitTest(options, 2 + 19, 5)).toBe('border')
    expect(frameHitTest(options, 2 + 19 - 1, 2 + 7)).toBe('grip')
    expect(frameHitTest(options, 10, 5)).toBe('inside')
    expect(frameHitTest(options, 0, 0)).toBe('outside')
  })

  it('classifies a scrollbar column when the window has one', () => {
    const scrollable = {
      ...options,
      scrollbar: { offset: 0, total: 100, visible: 10 },
    }
    // The border column becomes a scrollbar track, with arrows at the ends.
    expect(frameHitTest(scrollable, 2 + 19, 2 + 1)).toBe('scrollUp')
    expect(frameHitTest(scrollable, 2 + 19, 2 + 6)).toBe('scrollDown')
    // The thumb sits at the top for offset 0.
    expect(frameHitTest(scrollable, 2 + 19, 2 + 2)).toBe('thumb')
    expect(frameHitTest(scrollable, 2 + 19, 2 + 5)).toBe('trough')
  })
})

describe('interior geometry', () => {
  it('reserves a border on every side', () => {
    expect(interiorRect(rect(0, 0, 10, 5))).toEqual({ x: 1, y: 1, width: 8, height: 3 })
  })

  it('reserves the scrollbar column when asked', () => {
    expect(interiorRect(rect(0, 0, 10, 5), true)).toEqual({ x: 1, y: 1, width: 7, height: 3 })
  })

  it('never goes negative on a degenerate window', () => {
    expect(interiorRect(rect(0, 0, 1, 1))).toEqual({ x: 1, y: 1, width: 0, height: 0 })
  })
})

describe('painting', () => {
  it('paints the desktop backdrop and every open window', () => {
    const manager = makeManager(40, 12)
    const widget = new SpyWidget()
    openWindow(manager, 'a', widget, rect(2, 2, 20, 6))
    const frame = manager.paint()
    expect(widget.drawn).toBe(1)
    // The only window is active, so its frame is the double-line variant.
    expect(frame.row(2)).toContain('╔')
    // The menu bar band and the bottom two bands are chrome, not desktop.
    expect(frame.row(0).trimEnd()).toBe('')
  })

  it('gives the widget the interior rectangle, not the whole window', () => {
    const manager = makeManager(40, 12)
    const widget = new SpyWidget()
    openWindow(manager, 'a', widget, rect(2, 2, 20, 6))
    manager.paint()
    expect(widget.width).toBe(18)
    expect(widget.height).toBe(4)
  })

  it('does not paint a closed window', () => {
    const manager = makeManager()
    const widget = new SpyWidget()
    openWindow(manager, 'a', widget)
    manager.close('a')
    manager.paint()
    expect(widget.drawn).toBe(0)
  })

  it('shows only the topmost window when a modal is open', () => {
    const manager = makeManager(60, 20)
    const background = new SpyWidget()
    openWindow(manager, 'chat', background, rect(0, 1, 60, 18))
    manager.open({ id: 'ask', title: 'ask', rect: rect(10, 5, 30, 6), widget: new SpyWidget(), floating: true })
    manager.setModal('ask')
    manager.paint()
    // The background window's own drawing is suppressed behind a modal.
    expect(background.drawn).toBe(0)
  })

  it('draws an error card instead of crashing when a widget throws', () => {
    const manager = makeManager(40, 10)
    const exploding: Widget = {
      draw(): void {
        throw new Error('widget exploded')
      },
    }
    openWindow(manager, 'bad', exploding, rect(1, 2, 30, 5))
    const frame = manager.paint()
    expect(frame.lines().join('\n')).toContain('widget exploded')
  })

  it('reports dirty state and clears it after painting', () => {
    const manager = makeManager()
    openWindow(manager, 'a', new SpyWidget())
    expect(manager.dirty).toBe(true)
    manager.paint()
    expect(manager.dirty).toBe(false)
    manager.requestRender()
    expect(manager.dirty).toBe(true)
  })

  it('composites overlapping windows in z-order', () => {
    const manager = makeManager(40, 12)
    const lower: Widget = {
      draw(painter): void {
        painter.fill('L', {})
      },
    }
    const upper: Widget = {
      draw(painter): void {
        painter.fill('U', {})
      },
    }
    openWindow(manager, 'lower', lower, rect(1, 2, 20, 6))
    openWindow(manager, 'upper', upper, rect(10, 2, 20, 6))
    const frame = manager.paint()
    // Left of the overlap the lower window shows; inside it the upper one does.
    expect(frame.at(3, 3)?.char).toBe('L')
    expect(frame.at(15, 3)?.char).toBe('U')
  })
})

describe('skins', () => {
  it('ships the five documented skins with unique ids', () => {
    const ids = SKINS.map(skin => skin.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_SKIN_ID)
    expect(ids).toEqual(['tvision', 'phosphor', 'amber', 'slate', 'ansi'])
  })

  it('resolves every role for every skin', () => {
    for (const skin of SKINS) {
      const palette = resolvePalette(skin)
      for (const [role, style] of Object.entries(palette)) {
        expect(style, `${skin.id}.${role}`).toBeDefined()
      }
    }
  })

  it('looks up a skin case-insensitively and falls back to the default', () => {
    expect(findSkin('AMBER')?.id).toBe('amber')
    expect(findSkin('nope')).toBeUndefined()
    expect(skinOrDefault(undefined).id).toBe(DEFAULT_ID)
    expect(skinOrDefault('nope').id).toBe(DEFAULT_ID)
    expect(skinOrDefault('slate').id).toBe('slate')
  })

  it('applies a skin change to the manager palette', () => {
    const manager = makeManager()
    manager.setSkin(skinOrDefault('amber'))
    expect(manager.palette.windowFrame.fg).toBe(0xAA7000)
  })

  it('keeps the ANSI skin on the 16-colour palette so it inherits the user theme', () => {
    const palette = resolvePalette(skinOrDefault('ansi'))
    for (const style of Object.values(palette)) {
      if (style.fg !== undefined) expect(style.fg).toBeLessThan(16)
      if (style.bg !== undefined) expect(style.bg).toBeLessThan(16)
    }
  })
})
