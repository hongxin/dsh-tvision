/**
 * Multi-line composer tests.
 *
 * The box edits the way Claude Code's does, and these pin the semantics that
 * make it feel that way: Enter submits and `\`+Enter breaks, Up/Down walk the
 * rows while the buffer spans more than one and fall through to history while
 * it does not, and the readline keys (Home/End, Ctrl+A/E/U/K) are line-wise —
 * which on a single-line buffer is exactly what they always were, so the
 * behaviour nobody thinks about did not change.
 */
import { describe, expect, it } from 'vitest'
import { CellBuffer, rect } from '../src/kit/cell.ts'
import { Painter } from '../src/kit/painter.ts'
import { TURBO_VISION, resolvePalette } from '../src/kit/skin.ts'
import { Composer, type ComposerTheme } from '../src/app/composer.ts'

const palette = resolvePalette(TURBO_VISION)
const theme: ComposerTheme = {
  body: palette.inputBody,
  prompt: palette.inputPrompt,
  hint: palette.inputHint,
  completion: palette.listNormal,
  completionSelected: palette.listFocused,
}

/** A composer over recorded submissions and history. */
function build(options: { history?: readonly string[] } = {}) {
  const submitted: string[] = []
  const composer = new Composer({
    submit: (text) => { submitted.push(text) },
    changed: () => {},
    history: () => options.history ?? [],
    prompt: () => 'dsh> ',
  }, theme)
  return { composer, submitted }
}

/** Draw the composer into a buffer of the given size and return the rows. */
function paint(composer: Composer, width = 40, height = 8): string[] {
  const buffer = new CellBuffer(width, height)
  composer.draw(new Painter(buffer, rect(0, 0, width, height)), {
    palette, focused: true, requestRender: () => {},
  })
  return buffer.lines()
}

const key = (name: string, extra: Record<string, unknown> = {}): Parameters<Composer['onKey']>[0] =>
  ({ type: 'key', key: name, ...extra }) as never
const enter = () => key('enter')

describe('breaking lines', () => {
  it('Enter submits; Alt+Enter and Shift+Enter break', () => {
    const { composer, submitted } = build()
    composer.insert('one')
    composer.onKey(key('enter', { alt: true }))
    expect(submitted).toEqual([])
    composer.insert('two')
    composer.onKey(enter())
    expect(submitted).toEqual(['one\ntwo'])
  })

  it('a backslash before the caret becomes the break, Claude Code style', () => {
    const { composer, submitted } = build()
    composer.insert('first \\')
    composer.onKey(enter())
    expect(submitted).toEqual([])
    expect(composer.value).toBe('first \n')
    composer.insert('second')
    composer.onKey(enter())
    expect(submitted).toEqual(['first \nsecond'])
  })

  it('a backslash elsewhere still submits with the backslash in place', () => {
    const { composer, submitted } = build()
    composer.insert('a\\b')
    composer.onKey(enter())
    expect(submitted).toEqual(['a\\b'])
  })

  it('Backspace at a line break joins the lines', () => {
    const { composer } = build()
    composer.setValue('one\ntwo', 4)
    composer.onKey(key('backspace'))
    expect(composer.value).toBe('onetwo')
    expect(composer.caret).toBe(3)
  })

  it('a paste keeps its breaks', () => {
    const { composer } = build()
    composer.onKey(key('paste', { text: 'a\r\nb\nc' }))
    expect(composer.value).toBe('a\nb\nc')
  })
})

describe('moving between rows', () => {
  /** A composer with `first\nsecond` and the caret at the end. */
  function twoLines() {
    const { composer } = build()
    composer.setValue('first\nsecond')
    return composer
  }

  it('Up and Down move the caret between lines', () => {
    const composer = twoLines()
    paint(composer)
    composer.onKey(key('up'))
    expect(composer.caret).toBe(5)
    composer.onKey(key('left'))
    composer.onKey(key('down'))
    // The column carried down: position 4 on line two.
    expect(composer.caret).toBe(10)
  })

  it('Up clamps its column to the shorter line above', () => {
    const { composer } = build()
    composer.setValue('a\nbbbb')
    paint(composer)
    composer.onKey(key('up'))
    expect(composer.value).toBe('a\nbbbb')
    expect(composer.caret).toBe(1)
  })

  it('Up on the first line stays; Down on the last line stays', () => {
    const composer = twoLines()
    composer.setValue('one\ntwo', 0)
    paint(composer)
    composer.onKey(key('up'))
    expect(composer.caret).toBe(0)
    // 'one\ntwo' is seven characters: the caret at the end is index 7.
    composer.setValue('one\ntwo')
    paint(composer)
    composer.onKey(key('down'))
    expect(composer.caret).toBe(7)
  })

  it('falls through to history while the buffer is one display row', () => {
    const { composer } = build({ history: ['older'] })
    composer.setValue('fresh')
    composer.onKey(key('up'))
    expect(composer.value).toBe('older')
    composer.onKey(key('down'))
    expect(composer.value).toBe('fresh')
  })

  it('walks rows, not history, when a single logical line wraps', () => {
    const { composer } = build({ history: ['older'] })
    composer.setValue('word '.repeat(16).trimEnd())
    // The layout width is only known after a draw.
    paint(composer, 30)
    const caretBefore = composer.caret
    composer.onKey(key('up'))
    expect(composer.caret).toBeLessThan(caretBefore)
    expect(composer.value).not.toBe('older')
  })
})

describe('line-wise readline keys', () => {
  it('Home and End act on the logical line', () => {
    const composer = (() => { const c = build().composer; c.setValue('one\ntwo\nthree', 9); return c })()
    composer.onKey(key('home'))
    expect(composer.caret).toBe(8)
    composer.onKey(key('end'))
    expect(composer.caret).toBe(13)
  })

  it('Ctrl+A and Ctrl+E are line-wise too', () => {
    const { composer } = build()
    composer.setValue('one\ntwo\nthree', 9)
    composer.onKey(key('ctrl+a'))
    expect(composer.caret).toBe(8)
    composer.onKey(key('ctrl+e'))
    expect(composer.caret).toBe(13)
  })

  it('Ctrl+U kills to the start of the line, joining nothing above', () => {
    const { composer } = build()
    composer.setValue('keep\nwipe me', 12)
    composer.onKey(key('ctrl+u'))
    expect(composer.value).toBe('keep\n')
    expect(composer.caret).toBe(5)
  })

  it('Ctrl+K kills to the end of the line, joining nothing below', () => {
    const { composer } = build()
    composer.setValue('wipe me\nkeep', 0)
    composer.onKey(key('ctrl+k'))
    expect(composer.value).toBe('\nkeep')
  })

  it('on a single line they are the old whole-buffer behaviour', () => {
    const { composer } = build()
    composer.setValue('abcdef', 3)
    composer.onKey(key('home'))
    expect(composer.caret).toBe(0)
    composer.onKey(key('end'))
    expect(composer.caret).toBe(6)
    composer.onKey(key('ctrl+u'))
    expect(composer.value).toBe('')
  })

  it('Ctrl+W stops at the line break', () => {
    const { composer } = build()
    // Mid-word on the second line: the word before the caret dies, the first
    // line and the rest of the word stay.
    composer.setValue('one two\nthree', 11)
    composer.onKey(key('ctrl+w'))
    expect(composer.value).toBe('one two\nee')
    // At the start of the second line there is no word before the caret on
    // this line, so nothing dies and the break survives.
    composer.setValue('one two\nthree', 8)
    composer.onKey(key('ctrl+w'))
    expect(composer.value).toBe('one two\nthree')
  })
})

describe('the growing block', () => {
  it('occupies one row when empty and when short', () => {
    const { composer } = build()
    expect(composer.contentRows(40)).toBe(1)
    composer.insert('short')
    expect(composer.contentRows(40)).toBe(1)
  })

  it('grows with explicit lines', () => {
    const { composer } = build()
    composer.insert('a\nb\nc')
    expect(composer.contentRows(40)).toBe(3)
  })

  it('wraps a long line at the width', () => {
    const { composer } = build()
    composer.insert('y'.repeat(100))
    // 'dsh> ' costs five columns: 35 per row, so 100 y's are three rows.
    expect(composer.contentRows(40)).toBe(3)
  })

  it('never renders a row wider than the area', () => {
    const { composer } = build()
    composer.insert('中文'.repeat(60))
    const rows = paint(composer, 30, 10)
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(30)
  })

  it('paints the sigil only on the first row and indents the rest', () => {
    const { composer } = build()
    composer.insert('aaaa\nbbbb')
    const rows = paint(composer, 40, 4)
    expect(rows[0]?.startsWith('dsh> ')).toBe(true)
    expect(rows[1]?.startsWith('     ')).toBe(true)
    expect(rows[1]?.trimStart()).toBe('bbbb')
  })

  it('shows how much is hidden when the block scrolls', () => {
    const { composer } = build()
    // Caret at the start of `d`: one row hidden above, two below.
    composer.setValue('a\nb\nc\nd\ne', 6)
    const rows = paint(composer, 40, 2)
    expect(rows[0]?.startsWith('↑')).toBe(true)
    expect(rows.some(row => row.includes('↓'))).toBe(true)
  })

  it('keeps the caret row inside a short area', () => {
    const { composer } = build()
    composer.insert('one\ntwo\nthree\nfour')
    // Draw into two rows; the caret is on the last line, so the window must
    // have scrolled to show it.
    const rows = paint(composer, 40, 2)
    expect(rows.some(row => row.includes('four'))).toBe(true)
  })

  it('places the caret by a click on the right row', () => {
    const { composer } = build()
    composer.insert('one\ntwo')
    paint(composer, 40, 4)
    composer.onMouse({ x: 7, y: 1, kind: 'press', button: 'left' })
    expect(composer.value[composer.caret]).toBe('o')
  })

  it('the hardware cursor follows the caret onto its row', () => {
    const { composer } = build()
    composer.insert('one\ntwo')
    paint(composer, 40, 4)
    const top = composer.caretOffset().y
    composer.onKey(key('up'))
    paint(composer, 40, 4)
    expect(composer.caretOffset().y).toBeLessThan(top)
  })

  it('submitting clears the block back to one row', () => {
    const { composer, submitted } = build()
    composer.insert('a\nb\nc')
    expect(composer.contentRows(40)).toBe(3)
    composer.onKey(enter())
    expect(submitted).toEqual(['a\nb\nc'])
    expect(composer.contentRows(40)).toBe(1)
  })

  it('a blank multi-line buffer does not submit', () => {
    const { composer, submitted } = build()
    composer.insert('\n\n  \n')
    composer.onKey(enter())
    expect(submitted).toEqual([])
  })

  it('reports the last line as the visible line', () => {
    const { composer } = build()
    composer.insert('first\nsecond')
    expect(composer.visibleLine()).toBe('second')
  })
})

describe('completions in a multi-line buffer', () => {
  it('offers the token from the line the caret is on', () => {
    const seen: string[] = []
    const composer = new Composer({
      submit: () => {},
      complete: (token) => { seen.push(token); return [] },
      prompt: () => 'dsh> ',
    }, theme)
    composer.insert('first\n/mo')
    composer.onKey(key('tab'))
    expect(seen.at(-1)).toBe('/mo')
  })
})
