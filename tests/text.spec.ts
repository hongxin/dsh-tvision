/**
 * Text measurement is the foundation everything else sits on: if a width is
 * wrong by one, every cell after the mistake on that row lands in the wrong
 * place. These tests pin the behaviour that matters — wide glyphs, grapheme
 * clusters, and never splitting a glyph at a boundary.
 */
import { describe, expect, it } from 'vitest'
import {
  charWidth,
  clusterWidth,
  expandTabs,
  padCenter,
  padEnd,
  splitUnits,
  stripZeroWidth,
  takeColumns,
  takeColumnsEnd,
  textWidth,
  truncate,
} from '../src/kit/text.ts'

describe('charWidth', () => {
  it('measures ASCII as one column', () => {
    expect(charWidth('a')).toBe(1)
    expect(charWidth(' ')).toBe(1)
    expect(charWidth('~')).toBe(1)
  })

  it('measures CJK and fullwidth forms as two columns', () => {
    expect(charWidth('字')).toBe(2)
    expect(charWidth('中')).toBe(2)
    expect(charWidth('ａ')).toBe(2)
    expect(charWidth('。')).toBe(2)
  })

  it('measures combining marks as zero columns', () => {
    expect(charWidth('\u0301')).toBe(0)
    expect(charWidth('\u200B')).toBe(0)
  })

  it('measures control characters as zero columns', () => {
    expect(charWidth('\u0007')).toBe(0)
    expect(charWidth('\u007F')).toBe(0)
  })

  it('holds ambiguous-width characters at one column', () => {
    // U+00B1 PLUS-MINUS SIGN is East Asian "ambiguous": wide in a CJK locale,
    // narrow otherwise. The default assumption is narrow, matching xterm.
    expect(charWidth('±')).toBe(1)
  })

  it('measures box drawing as one column', () => {
    expect(charWidth('─')).toBe(1)
    expect(charWidth('╔')).toBe(1)
    expect(charWidth('█')).toBe(1)
  })
})

describe('clusterWidth', () => {
  it('measures a flag as one two-column glyph, not two singles', () => {
    expect(clusterWidth('🇯🇵')).toBe(2)
  })

  it('measures a skin-tone emoji as one glyph', () => {
    expect(clusterWidth('👍🏽')).toBe(2)
  })

  it('measures a keycap sequence as one glyph', () => {
    expect(clusterWidth('1\uFE0F\u20E3')).toBe(2)
  })

  it('passes through a plain character', () => {
    expect(clusterWidth('a')).toBe(1)
    expect(clusterWidth('字')).toBe(2)
  })
})

describe('textWidth', () => {
  it('sums columns, not code points', () => {
    expect(textWidth('hello')).toBe(5)
    expect(textWidth('你好')).toBe(4)
    expect(textWidth('a你b')).toBe(4)
  })

  it('counts a ZWJ emoji sequence as two columns', () => {
    // The family emoji is four code points joined by ZWJ; terminals draw one
    // glyph two columns wide.
    expect(textWidth('👨‍👩‍👧')).toBe(2)
  })

  it('is empty-safe', () => {
    expect(textWidth('')).toBe(0)
  })
})

describe('splitUnits', () => {
  it('returns one unit per grapheme cluster', () => {
    const units = splitUnits('a👍🏽b')
    expect(units.map(unit => unit.text)).toEqual(['a', '👍🏽', 'b'])
    expect(units.map(unit => unit.width)).toEqual([1, 2, 1])
  })

  it('keeps a combining mark attached to its base', () => {
    const units = splitUnits('e\u0301x')
    expect(units).toHaveLength(2)
    expect(units[0]?.text).toBe('e\u0301')
    expect(units[0]?.width).toBe(1)
  })
})

describe('truncate', () => {
  it('leaves a string that fits untouched', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('appends an ellipsis when it drops content', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
  })

  it('uses a caller-supplied marker', () => {
    // Six columns fits six characters exactly, so nothing is dropped; five
    // columns must give up three for the marker.
    expect(truncate('abcdef', 6, '...')).toBe('abcdef')
    expect(truncate('abcdef', 5, '...')).toBe('ab...')
  })

  it('never splits a wide glyph', () => {
    // Two wide glyphs need four columns; three columns can hold one plus the
    // ellipsis, so the second glyph must be dropped whole rather than halved.
    expect(truncate('你好', 3)).toBe('你…')
    expect(textWidth(truncate('你好', 3))).toBeLessThanOrEqual(3)
  })

  it('returns empty for a non-positive budget', () => {
    expect(truncate('abc', 0)).toBe('')
    expect(truncate('abc', -1)).toBe('')
  })

  it('gives up the glyph entirely when not even the marker fits', () => {
    // A single column cannot hold a two-column glyph and must not hold half of
    // one, so the result is empty rather than a stray space or a broken glyph.
    expect(truncate('你好', 1)).toBe('')
  })
})

describe('takeColumns', () => {
  it('takes the longest fitting prefix', () => {
    expect(takeColumns('abcdef', 3)).toBe('abc')
    expect(takeColumns('你好', 3)).toBe('你')
    expect(takeColumns('你好', 4)).toBe('你好')
  })
})

describe('takeColumnsEnd', () => {
  it('keeps the tail', () => {
    expect(takeColumnsEnd('abcdef', 2)).toBe('ef')
    expect(takeColumnsEnd('你好', 2)).toBe('好')
    expect(takeColumnsEnd('你好', 3)).toBe('好')
  })
})

describe('padEnd and padCenter', () => {
  it('pads to an exact column width', () => {
    expect(padEnd('ab', 5)).toBe('ab   ')
    expect(textWidth(padEnd('你好', 5))).toBe(5)
  })

  it('truncates when the text is already wider', () => {
    expect(padEnd('abcdef', 3)).toBe('abc')
  })

  it('centres with the odd column going right', () => {
    expect(padCenter('ab', 5)).toBe(' ab  ')
    expect(padCenter('ab', 4)).toBe(' ab ')
  })
})

describe('stripZeroWidth', () => {
  it('drops formatting controls that would corrupt a frame', () => {
    expect(stripZeroWidth('a\u200Bb')).toBe('ab')
  })

  it('keeps ordinary text', () => {
    expect(stripZeroWidth('hello')).toBe('hello')
  })
})

describe('expandTabs', () => {
  it('expands to the next multiple-of-eight stop by default', () => {
    expect(expandTabs('\tx')).toBe('        x')
    expect(expandTabs('ab\tx')).toBe('ab      x')
  })

  it('honours a custom tab width', () => {
    expect(expandTabs('ab\tx', 4)).toBe('ab  x')
  })

  it('drops C0 controls that would move the real cursor', () => {
    expect(expandTabs('a\u0007b')).toBe('ab')
  })

  it('counts a wide glyph as two columns when locating the next stop', () => {
    // After a two-column glyph the tab must fill to column 8, not 7.
    expect(expandTabs('字\tx')).toBe('字      x')
  })
})

describe('symbol clusters', () => {
  it('measures a bare ambiguous symbol as one column', () => {
    // The old rule forced two columns on any cluster containing a symbol from
    // the emoji blocks, while charWidth and the painter both said one — every
    // such glyph shifted its row. A bare check mark is text presentation.
    expect(textWidth('\u2713 done')).toBe(6)
    expect(clusterWidth('\u2713')).toBe(1)
    expect(clusterWidth('\u2605')).toBe(1)
  })

  it('measures an explicit emoji-presentation request as two columns', () => {
    expect(clusterWidth('\u2713\uFE0F')).toBe(2)
    expect(clusterWidth('1\uFE0F\u20E3')).toBe(2)
  })

  it('measures an unpaired regional indicator as narrow', () => {
    expect(clusterWidth('\u{1F1E9}')).toBe(1)
    expect(clusterWidth('\u{1F1E9}\u{1F1EA}')).toBe(2)
  })
})
