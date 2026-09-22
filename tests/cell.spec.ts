/**
 * Cell-buffer and renderer tests.
 *
 * The renderer's contract is "make the terminal match this buffer with the
 * fewest bytes", which is only trustworthy if two properties hold: the bytes it
 * emits, replayed into a terminal, produce exactly the buffer (checked in
 * `compositor.spec.ts` against a real xterm), and an unchanged frame costs
 * nothing. These tests pin the second property and the cell-level invariants —
 * wide glyphs, clipping, and joinability — that make the first one true.
 */
import { describe, expect, it } from 'vitest'
import { BLANK_CELL, CellBuffer, containsPoint, intersects, mergeStyle, rect, styleEquals } from '../src/kit/cell.ts'
import {
  ScreenRenderer,
  cursorTo,
  detectTruecolor,
  rgbToAnsi256,
  resolveStyle,
} from '../src/kit/screen.ts'
import { isEmptyStyle, normalizeStyle, stylePatch, styleToSgr } from '../src/kit/styles.ts'
import { Painter } from '../src/kit/painter.ts'

describe('CellBuffer', () => {
  it('starts blank at the requested size', () => {
    const buffer = new CellBuffer(4, 2)
    expect(buffer.width).toBe(4)
    expect(buffer.height).toBe(2)
    expect(buffer.lines()).toEqual(['', ''])
  })

  it('joins a row back into its text', () => {
    const buffer = new CellBuffer(5, 1)
    buffer.set(0, 0, 'h')
    buffer.set(1, 0, 'i')
    expect(buffer.row(0).trimEnd()).toBe('hi')
  })

  it('keeps a wide glyph joinable after a full repaint', () => {
    const buffer = new CellBuffer(4, 1)
    // Repaint the same cell many times, which is what a diffing renderer does
    // for a live clock: stale "trailing half" cells must never accumulate.
    for (let pass = 0; pass < 5; pass++) {
      buffer.set(0, 0, '你', {}, true)
      buffer.set(1, 0, '')
    }
    expect(buffer.row(0).trimEnd()).toBe('你')
    expect(buffer.at(1, 0)?.char).toBe('')
    expect(buffer.at(0, 0)?.wide).toBe(true)
  })

  it('clears the orphaned trailer when a wide glyph is overwritten', () => {
    const buffer = new CellBuffer(4, 1)
    buffer.set(0, 0, '你', {}, true)
    buffer.set(1, 0, '')
    buffer.set(0, 0, 'a')
    expect(buffer.row(0).trimEnd()).toBe('a')
  })

  it('clears the lead flag when the trailer is overwritten', () => {
    const buffer = new CellBuffer(4, 1)
    buffer.set(0, 0, '你', {}, true)
    buffer.set(1, 0, '')
    buffer.set(1, 0, 'b')
    expect(buffer.at(0, 0)?.wide).toBe(false)
    expect(buffer.row(0).trimEnd()).toBe('你b')
  })

  it('ignores out-of-bounds writes', () => {
    const buffer = new CellBuffer(2, 2)
    buffer.set(-1, 0, 'x')
    buffer.set(0, -1, 'x')
    buffer.set(2, 0, 'x')
    buffer.set(0, 2, 'x')
    expect(buffer.lines()).toEqual(['', ''])
  })

  it('reports bounds correctly', () => {
    const buffer = new CellBuffer(3, 2)
    expect(buffer.inBounds(0, 0)).toBe(true)
    expect(buffer.inBounds(2, 1)).toBe(true)
    expect(buffer.inBounds(3, 1)).toBe(false)
    expect(buffer.inBounds(0, 2)).toBe(false)
  })

  it('snapshots without aliasing the live grid', () => {
    const buffer = new CellBuffer(2, 1)
    buffer.set(0, 0, 'a')
    const copy = buffer.snapshot()
    buffer.set(0, 0, 'b')
    expect(copy.row(0).trimEnd()).toBe('a')
  })

  it('retains trailing blanks only when asked', () => {
    const buffer = new CellBuffer(3, 1)
    buffer.set(0, 0, 'a')
    expect(buffer.lines()).toEqual(['a'])
    expect(buffer.lines({ trimEnd: false })).toEqual(['a  '])
  })

  it('treats a one-row clear as a restyle, not a reallocation', () => {
    const buffer = new CellBuffer(2, 1)
    buffer.set(0, 0, 'a')
    buffer.clear({ bg: 4 })
    expect(buffer.at(0, 0)?.style.bg).toBe(4)
    expect(buffer.at(0, 0)?.char).toBe(' ')
  })
})

describe('cell geometry and styles', () => {
  it('normalises negative extents to zero', () => {
    expect(rect(1, 2, -3, -4)).toEqual({ x: 1, y: 2, width: 0, height: 0 })
  })

  it('hit-tests the half-open extent', () => {
    const r = rect(2, 3, 4, 5)
    expect(containsPoint(r, 2, 3)).toBe(true)
    expect(containsPoint(r, 5, 7)).toBe(true)
    expect(containsPoint(r, 6, 3)).toBe(false)
    expect(containsPoint(r, 2, 8)).toBe(false)
  })

  it('detects intersection', () => {
    expect(intersects(rect(0, 0, 3, 3), rect(2, 2, 3, 3))).toBe(true)
    expect(intersects(rect(0, 0, 2, 2), rect(2, 0, 2, 2))).toBe(false)
  })

  it('merges styles field by field and lets undefined clear a field', () => {
    const merged = mergeStyle({ fg: 1, bg: 2, bold: true }, { fg: 3, bold: undefined })
    expect(merged).toEqual({ fg: 3, bg: 2 })
  })

  it('returns the base style when the overlay is empty', () => {
    const base = { fg: 1 }
    expect(mergeStyle(base, {})).toBe(base)
    expect(mergeStyle(base, undefined)).toBe(base)
  })

  it('compares styles by value', () => {
    expect(styleEquals({ fg: 1, bold: true }, { fg: 1, bold: true })).toBe(true)
    expect(styleEquals({ fg: 1 }, { fg: 2 })).toBe(false)
    expect(styleEquals({}, { bold: true })).toBe(false)
  })

  it('exposes a frozen blank cell', () => {
    expect(BLANK_CELL.char).toBe(' ')
    expect(Object.isFrozen(BLANK_CELL)).toBe(true)
  })
})

describe('style encoding', () => {
  it('encodes the base eight colours as 30-37 and 40-47', () => {
    expect(styleToSgr({ fg: 1, bg: 4 })).toBe('\u001B[0;31;44m')
  })

  it('restates the attributes a style sets', () => {
    expect(styleToSgr({ bold: true, underline: true })).toBe('\u001B[0;1;4;39;49m')
  })

  it('encodes the bright eight as 90-97 and 100-107', () => {
    expect(styleToSgr({ fg: 9, bg: 12 })).toContain('91')
    expect(styleToSgr({ fg: 9, bg: 12 })).toContain('104')
  })

  it('encodes a 24-bit value as 38;2 and a 256-index as 38;5', () => {
    // Getting this boundary wrong is how the Borland cyan (0x00AAAA) came out
    // purple: it was 43690, read as palette index 170. And reading a palette
    // index as 24-bit is the same bug one layer down: index 200 emitted as
    // 38;2;0;0;200 is a near-black, not the cube entry the downgrade picked.
    expect(styleToSgr({ fg: 0x00AAAA })).toContain('38;2;0;170;170')
    expect(styleToSgr({ fg: 200 })).toContain('38;5;200')
    expect(styleToSgr({ bg: 200 })).toContain('48;5;200')
  })

  it('emits a 24-bit value below 256 as RGB unless the style was downgraded', () => {
    // The Borland blue 0x0000A8 is 168 decimal — numerically inside the
    // palette-index range. On a truecolour terminal the raw skin colour must go
    // out as RGB; emitting index 168 paints the whole desktop cube-pink. Only
    // resolveStyle's output may use the 5;N form for such values.
    expect(styleToSgr({ bg: 0x0000A8 }, false)).toContain('48;2;0;0;168')
    expect(styleToSgr({ fg: 0x0000A8 }, false)).toContain('38;2;0;0;168')
    expect(stylePatch(undefined, { bg: 0x0000A8 }, false)).toContain('48;2;0;0;168')
    // Downgraded styles keep the index form — that is what their numbers are.
    expect(styleToSgr({ bg: 168 }, true)).toContain('48;5;168')
    // The theme-mapped sixteen stay theme-mapped in both modes.
    expect(styleToSgr({ fg: 1, bg: 4 }, false)).toBe('\u001B[0;31;44m')
  })

  it('keeps a palette index a palette index', () => {
    // Below the limit the terminal's own theme resolves the colour, which is the
    // whole point of the ansi skin.
    expect(styleToSgr({ fg: 4 })).toContain('34')
    expect(styleToSgr({ fg: 14 })).toContain('96')
  })

  it('encodes a truecolour as 38;2', () => {
    expect(styleToSgr({ fg: 0x112233 })).toContain('38;2;17;34;51')
  })

  it('emits a bare reset for an empty style', () => {
    expect(styleToSgr({})).toBe('\u001B[0m')
    expect(isEmptyStyle({})).toBe(true)
    expect(isEmptyStyle({ bold: false })).toBe(false)
  })

  it('patches only what changed', () => {
    // Same colours, no attributes on either side: nothing to say.
    expect(stylePatch({ fg: 1, bg: 2 }, { fg: 1, bg: 2 })).toBe('')
    // A foreground change says only that.
    expect(stylePatch({ fg: 1, bg: 2 }, { fg: 3, bg: 2 })).toBe('\u001B[33m')
  })

  it('actively clears an attribute the previous style had', () => {
    // Bold must be turned *off* on the wire, not merely omitted, or the rest of
    // the row inherits it.
    expect(stylePatch({ bold: true }, {})).toBe('\u001B[22m')
  })

  it('restates fully when there is no previous style', () => {
    expect(stylePatch(undefined, { fg: 1 })).toBe(styleToSgr({ fg: 1 }))
  })

  it('normalises a partial style into a comparable one', () => {
    const normalised = normalizeStyle({ fg: 1 })
    expect(normalised.bold).toBe(false)
    expect(styleEquals(normalised, normalizeStyle({ fg: 1 }))).toBe(true)
    expect(styleEquals(normalised, normalizeStyle({ fg: 1, bold: true }))).toBe(false)
  })
})

describe('colour downgrade', () => {
  it('maps pure black and white onto their exact cube entries', () => {
    // Both are exact cube hits, so the cube wins; black is also equidistant
    // from the grey ramp's first entry and the tie is broken towards the cube.
    expect(rgbToAnsi256(0x000000)).toBe(16)
    expect(rgbToAnsi256(0xFFFFFF)).toBe(231)
  })

  it('maps a near-neutral grey onto the grey ramp', () => {
    // 0x808080 sits far from every cube level but right next to ramp entry 244.
    expect(rgbToAnsi256(0x808080)).toBe(244)
  })

  it('maps a saturated colour onto the cube', () => {
    const index = rgbToAnsi256(0xFF0000)
    // 16 + 36*5 = 196 is the cube's pure red.
    expect(index).toBe(196)
  })

  it('leaves ANSI indices untouched', () => {
    expect(resolveStyle({ fg: 4, bg: 1 }, false)).toEqual({ fg: 4, bg: 1 })
  })

  it('downgrades truecolour when the terminal cannot take it', () => {
    const resolved = resolveStyle({ fg: 0x0000A8 }, false)
    expect(resolved.fg).toBeLessThan(0x100)
  })

  it('passes truecolour through when it can', () => {
    const style = { fg: 0x0000A8 }
    expect(resolveStyle(style, true)).toBe(style)
  })

  it('detects truecolour from the environment', () => {
    expect(detectTruecolor({ COLORTERM: 'truecolor' })).toBe(true)
    expect(detectTruecolor({ COLORTERM: '24bit' })).toBe(true)
    expect(detectTruecolor({ TERM: 'xterm-direct' })).toBe(true)
    expect(detectTruecolor({ TERM_PROGRAM: 'iTerm.app' })).toBe(true)
    expect(detectTruecolor({ TERM: 'xterm-256color' })).toBe(false)
    expect(detectTruecolor({})).toBe(false)
  })
})

describe('ScreenRenderer', () => {
  /** Build a frame with a single character so a diff has something to find. */
  const frameWith = (char: string): CellBuffer => {
    const buffer = new CellBuffer(4, 2)
    buffer.set(1, 0, char, { fg: 1 })
    return buffer
  }

  it('emits downgraded colours as 38;5, not as misread truecolour', () => {
    // The renderer is where the downgrade meets the SGR encoder: a terminal
    // without truecolour support must see the palette index it was promised,
    // because an index reinterpreted as RGB is how every skin turns to mud.
    const renderer = new ScreenRenderer(false)
    const buffer = new CellBuffer(4, 2)
    buffer.set(1, 0, 'a', { fg: 0x00AAAA })
    const output = renderer.render(buffer, { x: 0, y: 0, visible: false })
    expect(output).toContain('38;5;')
    expect(output).not.toContain('38;2;')
  })

  it('wraps a frame in synchronized-output markers', () => {
    const renderer = new ScreenRenderer(false)
    const output = renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    expect(output.startsWith('\u001B[?2026h')).toBe(true)
    expect(output.endsWith('\u001B[?2026l')).toBe(true)
  })

  it('emits nothing for an identical frame', () => {
    const renderer = new ScreenRenderer(false)
    renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    const second = renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    expect(second).toBe('')
  })

  it('emits only the changed row on an incremental frame', () => {
    const renderer = new ScreenRenderer(false)
    renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    const second = renderer.render(frameWith('b'), { x: 0, y: 0, visible: true })
    expect(second).toContain(cursorTo(1, 0))
    // The unchanged second row must not be repainted.
    expect(second).not.toContain(cursorTo(0, 1))
  })

  it('repaints everything after invalidate', () => {
    const renderer = new ScreenRenderer(false)
    renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    renderer.invalidate()
    const second = renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    expect(second).toContain(cursorTo(0, 0))
    expect(second).toContain(cursorTo(0, 1))
  })

  it('hides the cursor when asked and shows it when parked', () => {
    const renderer = new ScreenRenderer(false)
    expect(renderer.render(frameWith('a'), { x: 0, y: 0, visible: false })).toContain('\u001B[?25l')
    const shown = renderer.render(frameWith('a'), { x: 2, y: 1, visible: true })
    expect(shown).toContain('\u001B[?25h')
    expect(shown).toContain(cursorTo(2, 1))
  })

  it('tracks byte statistics', () => {
    const renderer = new ScreenRenderer(false)
    renderer.render(frameWith('a'), { x: 0, y: 0, visible: true })
    expect(renderer.stats.bytes).toBeGreaterThan(0)
    expect(renderer.stats.rows).toBe(2)
  })

  it('enters and leaves the full-screen session with matching modes', () => {
    const enter = ScreenRenderer.enter()
    const leave = ScreenRenderer.leave()
    // Alternate screen in, alternate screen out.
    expect(enter).toContain('\u001B[?1049h')
    expect(leave).toContain('\u001B[?1049l')
    // Mouse reporting on, then off, in the reverse order.
    for (const mode of ['1000', '1002', '1006']) {
      expect(enter).toContain(`\u001B[?${mode}h`)
      expect(leave).toContain(`\u001B[?${mode}l`)
    }
    expect(enter).toContain('\u001B[?2004h')
    expect(leave).toContain('\u001B[?2004l')
    // The cursor must come back before the screen is handed over.
    expect(leave).toContain('\u001B[?25h')
  })

  it('omits mouse modes when mouse support is disabled', () => {
    expect(ScreenRenderer.enter({ mouse: false })).not.toContain('1006')
    expect(ScreenRenderer.leave({ mouse: false })).not.toContain('1006')
  })
})

describe('painting multi-codepoint clusters', () => {
  /** A painter rooted at column 4, so a local/absolute mix-up shows. */
  const offsetPainter = (width: number): { painter: Painter; buffer: CellBuffer } => {
    const buffer = new CellBuffer(width + 4, 1)
    const painter = new Painter(buffer, rect(4, 0, width, 1))
    return { painter, buffer }
  }

  it('paints a skin-tone emoji as one glyph in two columns', () => {
    // Measured as 4 columns for the pair below; painting per code point drew
    // four columns instead, dropping whatever followed.
    const { painter, buffer } = offsetPainter(6)
    painter.text(0, 0, '\u{1F44D}\u{1F3FD} hi', 6, {})
    // The row includes the four columns before the painter's region; the
    // painted part must reproduce the original text exactly, which is the
    // join-the-row-back invariant the wide/trailer pair exists to keep.
    const row = buffer.row(0).slice(4)
    expect(row.startsWith('\u{1F44D}\u{1F3FD} hi')).toBe(true)
    expect(buffer.at(4, 0)?.wide).toBe(true)
    expect(buffer.at(5, 0)?.char).toBe('')
  })

  it('paints a ZWJ family as one glyph, not three', () => {
    const { painter, buffer } = offsetPainter(4)
    painter.text(0, 0, '\u{1F468}\u200D\u{1F469}\u200D\u{1F466}', 4, {})
    const row = buffer.row(0).slice(4)
    expect(row.startsWith('\u{1F468}\u200D\u{1F469}\u200D\u{1F466}')).toBe(true)
    expect(buffer.at(4, 0)?.wide).toBe(true)
    expect(buffer.at(5, 0)?.char).toBe('')
  })

  it('attaches a combining mark to the cell inside the region, in buffer coordinates', () => {
    // The bug appended the accent to absolute column 0 — thirty columns away in
    // a real desktop — because the local column was used as a buffer x.
    const { painter, buffer } = offsetPainter(4)
    buffer.set(0, 0, 'X', {})
    painter.text(0, 0, 'e\u0301', 4, {})
    expect(buffer.at(0, 0)?.char).toBe('X')
    expect(buffer.at(4, 0)?.char).toBe('e\u0301')
  })
})
