/**
 * End-to-end compositor tests.
 *
 * These are the tests that justify owning a cell-grid renderer instead of
 * reusing a line-based one: a frame is written to a real terminal emulator and
 * read back as cells. If overlapping windows, drop shadows, clipping, or wide
 * characters were wrong, the emulator's grid would not match the buffer we
 * painted — and no amount of asserting on escape strings would catch it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CellBuffer, rect } from '../src/kit/cell.ts'
import { Painter, ASCII_BOX, DOUBLE_BOX, SINGLE_BOX, clipToWidth, truncateCached } from '../src/kit/painter.ts'
import { ScreenRenderer } from '../src/kit/screen.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const terminals: HeadlessTerminal[] = []

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose()
})

/**
 * Paint a buffer into a fresh emulator.
 * @param buffer - The frame to paint.
 * @param terminal - The emulator to paint into.
 */
async function paint(buffer: CellBuffer, terminal: HeadlessTerminal): Promise<void> {
  const renderer = new ScreenRenderer(true)
  renderer.invalidate()
  await terminal.writeAndSettle(renderer.render(buffer, { x: 0, y: 0, visible: false }))
}

/**
 * Compare a painted buffer against what the terminal actually shows, cell for
 * character. This is the central invariant of the whole renderer.
 * @param buffer - What we painted.
 * @param terminal - The emulator.
 */
function expectTerminalMatches(buffer: CellBuffer, terminal: HeadlessTerminal): void {
  const view = terminal.snapshot()
  for (let y = 0; y < buffer.height; y++) {
    expect(view.rawRows[y], `row ${y}`).toBe(buffer.row(y))
  }
}

function newTerminal(columns: number, rows: number): HeadlessTerminal {
  const terminal = new HeadlessTerminal(columns, rows)
  terminals.push(terminal)
  return terminal
}

describe('Painter', () => {
  it('clips writes to its own region', () => {
    const buffer = new CellBuffer(10, 3)
    const painter = new Painter(buffer, rect(2, 1, 4, 1))
    painter.fill('x')
    painter.set(-1, 0, 'L', {})
    painter.set(4, 0, 'R', {})
    painter.set(0, -1, 'U', {})
    painter.set(0, 1, 'D', {})
    expect(buffer.row(0).trimEnd()).toBe('')
    expect(buffer.row(1).trimEnd()).toBe('  xxxx')
    expect(buffer.row(2).trimEnd()).toBe('')
  })

  it('nests sub-painters without letting a grandchild escape', () => {
    const buffer = new CellBuffer(12, 3)
    const outer = new Painter(buffer, rect(1, 0, 6, 3))
    const inner = outer.sub(2, 1, 4, 2)
    inner.fill('y')
    expect(buffer.row(0).trimEnd()).toBe('')
    expect(buffer.row(1).trimEnd()).toBe('   yyyy')
    expect(buffer.row(2).trimEnd()).toBe('   yyyy')
  })

  it('draws a box outline that leaves the interior alone', () => {
    const buffer = new CellBuffer(6, 4)
    const painter = new Painter(buffer, rect(0, 0, 6, 4))
    painter.box(0, 0, 6, 4, {}, SINGLE_BOX)
    expect(buffer.lines()).toEqual([
      '┌────┐',
      '│    │',
      '│    │',
      '└────┘',
    ])
  })

  it('draws a double box when asked', () => {
    const buffer = new CellBuffer(4, 3)
    new Painter(buffer, rect(0, 0, 4, 3)).box(0, 0, 4, 3, {}, DOUBLE_BOX)
    expect(buffer.lines()).toEqual(['╔══╗', '║  ║', '╚══╝'])
  })

  it('degrades a degenerate box to a rule', () => {
    const buffer = new CellBuffer(4, 2)
    new Painter(buffer, rect(0, 0, 4, 2)).box(0, 0, 4, 1, {}, SINGLE_BOX)
    expect(buffer.lines()[0]).toBe('────')
  })

  it('draws an ASCII box when the font has no box glyphs', () => {
    const buffer = new CellBuffer(4, 3)
    new Painter(buffer, rect(0, 0, 4, 3)).box(0, 0, 4, 3, {}, ASCII_BOX)
    expect(buffer.lines()).toEqual(['+--+', '|  |', '+--+'])
  })

  it('casts a shadow to the right and below', () => {
    const buffer = new CellBuffer(8, 5)
    const painter = new Painter(buffer, rect(0, 0, 8, 5))
    painter.fill(' ', { bg: 9 })
    painter.shadow(1, 1, 3, 2, { bg: 1 }, 2, 1)
    // Two columns right of the rectangle, over its height plus the vertical
    // offset, and one row below starting at the horizontal offset. The bottom
    // band stops where the right band begins, so they do not overlap.
    expect(buffer.at(4, 2)?.style.bg).toBe(1)
    expect(buffer.at(5, 2)?.style.bg).toBe(1)
    expect(buffer.at(3, 3)?.style.bg).toBe(1)
    expect(buffer.at(5, 3)?.style.bg).toBe(1)
    expect(buffer.at(6, 3)?.style.bg).toBe(9)
    // Nothing outside the shadow geometry.
    expect(buffer.at(0, 0)?.style.bg).toBe(9)
    expect(buffer.at(7, 4)?.style.bg).toBe(9)
  })

  it('embeds a title in a horizontal rule', () => {
    const buffer = new CellBuffer(12, 1)
    new Painter(buffer, rect(0, 0, 12, 1)).hRule(0, 0, 12, {}, 'Title', undefined, 1)
    expect(buffer.row(0).replace(/\s+$/u, '')).toBe('─Title──────')
  })

  it('right-aligns text in its cell', () => {
    const buffer = new CellBuffer(10, 1)
    new Painter(buffer, rect(0, 0, 10, 1)).text(0, 0, 'ab', 10, {}, { align: 'right' })
    expect(buffer.row(0).trimEnd()).toBe('        ab')
  })

  it('centres text in its cell', () => {
    const buffer = new CellBuffer(9, 1)
    new Painter(buffer, rect(0, 0, 9, 1)).text(0, 0, 'abc', 9, {}, { align: 'center' })
    expect(buffer.row(0).trimEnd()).toBe('   abc')
  })

  it('never lets a wide glyph straddle the right edge', () => {
    const buffer = new CellBuffer(3, 1)
    // Two wide glyphs need four columns; only one fits in three.
    new Painter(buffer, rect(0, 0, 3, 1)).text(0, 0, '你好', 3, {}, { ellipsis: false })
    // One glyph plus the cell it left blank; a row joins back to the original
    // text with no stray space where the dropped glyph would have been.
    expect(buffer.row(0)).toBe('你 ')
  })

  it('attaches a combining mark to the preceding cell', () => {
    const buffer = new CellBuffer(4, 1)
    new Painter(buffer, rect(0, 0, 4, 1)).text(0, 0, 'e\u0301x', 4, {})
    expect(buffer.row(0).trimEnd()).toBe('e\u0301x')
  })

  it('paints the whole cell background even for short text', () => {
    const buffer = new CellBuffer(6, 1)
    new Painter(buffer, rect(0, 0, 6, 1)).text(0, 0, 'ab', 6, { bg: 3, fg: 7 })
    for (let x = 0; x < 6; x++) expect(buffer.at(x, 0)?.style.bg).toBe(3)
  })

})

describe('clipping helpers', () => {
  it('clipToWidth cuts without a marker', () => {
    expect(clipToWidth('abcdef', 3)).toBe('abc')
    expect(clipToWidth('你好', 1)).toBe('')
  })

  it('truncateCached adds a marker only when it drops something', () => {
    expect(truncateCached('abc', 5)).toBe('abc')
    expect(truncateCached('abcdef', 4)).toBe('abc…')
    expect(truncateCached('abc', 1)).toBe('…')
    expect(truncateCached('abc', 0)).toBe('')
  })
})

describe('terminal round-trip', () => {
  it('reproduces a plain buffer exactly', async () => {
    const terminal = newTerminal(20, 5)
    const buffer = new CellBuffer(20, 5)
    const painter = new Painter(buffer, rect(0, 0, 20, 5))
    painter.text(0, 0, 'hello world', 20, {})
    painter.text(0, 2, 'second line', 20, {})
    await paint(buffer, terminal)
    expectTerminalMatches(buffer, terminal)
    expect(terminal.snapshot().rows[0]).toBe('hello world')
  })

  it('reproduces a frame with wide characters', async () => {
    const terminal = newTerminal(24, 3)
    const buffer = new CellBuffer(24, 3)
    const painter = new Painter(buffer, rect(0, 0, 24, 3))
    painter.text(0, 0, '中文测试', 24, {})
    painter.text(0, 1, 'a你b好c', 24, {})
    await paint(buffer, terminal)
    expectTerminalMatches(buffer, terminal)
    expect(terminal.snapshot().rows[0]).toBe('中文测试')
  })

  it('lays out an emoji row without corrupting the cells around it', () => {
    // Emoji width is the one thing terminals genuinely disagree about, so this
    // asserts the buffer's own invariant — text after the emoji starts at the
    // column the emoji's measured width says it should — rather than a grid
    // comparison the emulator cannot arbitrate.
    const buffer = new CellBuffer(24, 2)
    const painter = new Painter(buffer, rect(0, 0, 24, 2))
    painter.text(0, 0, 'ok 👍 done', 24, {})
    expect(buffer.row(0).startsWith('ok 👍')).toBe(true)
    // Whatever width the emoji was given, the tail must follow it immediately.
    expect(buffer.row(0).replace(/\s+$/u, '')).toBe('ok 👍 done')
  })

  it('reproduces box drawing and shadows', async () => {
    const terminal = newTerminal(30, 10)
    const buffer = new CellBuffer(30, 10)
    const painter = new Painter(buffer, rect(0, 0, 30, 10))
    painter.fill(' ', { bg: 4 })
    painter.shadow(3, 2, 12, 5, { bg: 0 })
    painter.box(3, 2, 12, 5, { fg: 6 }, DOUBLE_BOX)
    painter.text(5, 3, 'Window', 8, { fg: 7, bg: 6 })
    await paint(buffer, terminal)
    expectTerminalMatches(buffer, terminal)
    expect(terminal.snapshot().rows[2]).toContain('╔')
  })

  it('applies foreground and background colours per cell', async () => {
    const terminal = newTerminal(10, 1)
    const buffer = new CellBuffer(10, 1)
    const painter = new Painter(buffer, rect(0, 0, 10, 1))
    painter.text(0, 0, 'aa', 2, { fg: 1, bg: 4 })
    painter.text(2, 0, 'bb', 2, { fg: 2, bg: 0 })
    await paint(buffer, terminal)
    const spans = terminal.spans(0)
    const first = spans[0]
    const second = spans[1]
    expect(first?.fg).toBe('red')
    expect(first?.bg).toBe('blue')
    expect(second?.fg).toBe('green')
    expect(second?.bg).toBe('black')
  })

  it('applies bold and dim attributes', async () => {
    const terminal = newTerminal(10, 1)
    const buffer = new CellBuffer(10, 1)
    const painter = new Painter(buffer, rect(0, 0, 10, 1))
    painter.text(0, 0, 'B', 1, { bold: true })
    painter.text(1, 0, 'd', 1, { dim: true })
    await paint(buffer, terminal)
    const view = terminal.snapshot()
    expect(view.cells[0]?.[0]?.bold).toBe(true)
    expect(view.cells[0]?.[1]?.dim).toBe(true)
  })

  it('turns an attribute back off mid-row', async () => {
    const terminal = newTerminal(10, 1)
    const buffer = new CellBuffer(10, 1)
    const painter = new Painter(buffer, rect(0, 0, 10, 1))
    painter.text(0, 0, 'BB', 2, { bold: true })
    painter.text(2, 0, 'pp', 2, {})
    await paint(buffer, terminal)
    const view = terminal.snapshot()
    expect(view.cells[0]?.[0]?.bold).toBe(true)
    expect(view.cells[0]?.[2]?.bold).toBe(false)
  })

  it('reproduces an incrementally repainted frame', async () => {
    const terminal = newTerminal(30, 8)
    const renderer = new ScreenRenderer(true)
    const build = (label: string): CellBuffer => {
      const buffer = new CellBuffer(30, 8)
      const painter = new Painter(buffer, rect(0, 0, 30, 8))
      painter.fill(' ', { bg: 4 })
      painter.box(1, 1, 20, 5, { fg: 6 }, SINGLE_BOX)
      painter.text(3, 2, label, 16, { fg: 7 })
      return buffer
    }
    await terminal.writeAndSettle(renderer.render(build('first'), { x: 0, y: 0, visible: false }))
    await terminal.writeAndSettle(renderer.render(build('second'), { x: 0, y: 0, visible: false }))
    await terminal.writeAndSettle(renderer.render(build('third'), { x: 0, y: 0, visible: false }))
    expectTerminalMatches(build('third'), terminal)
  })

  it('reproduces a frame after content shrinks', async () => {
    const terminal = newTerminal(20, 4)
    const renderer = new ScreenRenderer(true)
    const wide = new CellBuffer(20, 4)
    new Painter(wide, rect(0, 0, 20, 4)).text(0, 0, 'a much longer line here', 20, {})
    await terminal.writeAndSettle(renderer.render(wide, { x: 0, y: 0, visible: false }))
    const narrow = new CellBuffer(20, 4)
    new Painter(narrow, rect(0, 0, 20, 4)).text(0, 0, 'short', 20, {})
    await terminal.writeAndSettle(renderer.render(narrow, { x: 0, y: 0, visible: false }))
    expectTerminalMatches(narrow, terminal)
    expect(terminal.snapshot().rows[0]).toBe('short')
  })

  it('lets a window cover its own shadow without a notch', async () => {
    const terminal = newTerminal(20, 6)
    const buffer = new CellBuffer(20, 6)
    const painter = new Painter(buffer, rect(0, 0, 20, 6))
    painter.shadow(2, 1, 8, 3, { bg: 0 })
    painter.box(2, 1, 8, 3, {}, SINGLE_BOX)
    painter.text(3, 2, 'inner', 6, {})
    await paint(buffer, terminal)
    expectTerminalMatches(buffer, terminal)
    expect(terminal.snapshot().rows[1]).toBe('  ┌──────┐')
  })

  it('repaints correctly after a resize', async () => {
    const terminal = newTerminal(20, 4)
    const renderer = new ScreenRenderer(true)
    const small = new CellBuffer(20, 4)
    new Painter(small, rect(0, 0, 20, 4)).text(0, 0, 'before', 20, {})
    await terminal.writeAndSettle(renderer.render(small, { x: 0, y: 0, visible: false }))
    renderer.invalidate()
    terminal.resize(30, 6)
    const big = new CellBuffer(30, 6)
    new Painter(big, rect(0, 0, 30, 6)).text(0, 5, 'after resize', 30, {})
    await terminal.writeAndSettle(renderer.render(big, { x: 0, y: 0, visible: false }))
    const view = terminal.snapshot()
    expect(view.rows[0]).toBe('')
    expect(view.rows[5]).toBe('after resize')
  })
})
