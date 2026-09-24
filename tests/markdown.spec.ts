/**
 * Markdown renderer tests.
 *
 * The pins are the design table: every block type, every inline construct,
 * the streaming-safety rule (an unclosed marker renders literally), and the
 * wrapper's width invariants — kinsoku with styled spans, CJK seam, wide
 * glyphs never split — swept across the realistic width range.
 */
import { describe, expect, it } from 'vitest'
import { markdownRows, parseBlocks, parseInline, wrapSegments } from '../src/views/markdown.ts'
import { TURBO_VISION, resolvePalette } from '../src/kit/skin.ts'
import { splitUnits, textWidth } from '../src/kit/text.ts'

const palette = resolvePalette(TURBO_VISION)
const base = palette.bodyText
const code = palette.code
const rowsOf = (text: string, width = 60): string[] => markdownRows(text, width, base, palette).map(row => row.text)

describe('block parsing', () => {
  it('headings drop their markers at every level', () => {
    expect(rowsOf('# Ship it')).toEqual(['Ship it'])
    expect(rowsOf('## Ship it')).toEqual(['Ship it'])
    expect(rowsOf('### Deep')).toEqual(['Deep'])
    expect(rowsOf('#### Deeper')).toEqual(['Deeper'])
  })

  it('headings descend by attribute on the heading colour', () => {
    const [h2] = markdownRows('## One', 60, base, palette)
    const [h3] = markdownRows('### Two', 60, base, palette)
    const [h4] = markdownRows('#### Three', 60, base, palette)
    expect(h2?.segments[0]?.style).toMatchObject({ fg: palette.heading.fg, bold: true, underline: true })
    expect(h3?.segments[0]?.style).toMatchObject({ fg: palette.heading.fg, bold: true })
    expect(h3?.segments[0]?.style.underline).toBeUndefined()
    expect(h4?.segments[0]?.style).toMatchObject({ fg: palette.heading.fg, bold: true, dim: true })
  })

  it('a heading mid-text gains a blank line before it; an opening one does not', () => {
    expect(rowsOf('body first\n\n## One')).toEqual(['body first', '', 'One'])
    expect(rowsOf('## One\n\nbody')).toEqual(['One', 'body'])
  })

  it('rules render to the measure under all three spellings', () => {
    for (const rule of ['---', '***', '___']) {
      expect(rowsOf(rule, 40)).toEqual(['─'.repeat(40)])
    }
  })

  it('quotes take a bar, lose two columns, and keep it across wraps', () => {
    const rows = rowsOf('> quoted line that is long enough to wrap at this width for sure', 30)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) expect(row.startsWith('│ ')).toBe(true)
  })

  it('a lazy continuation line joins the quote', () => {
    const blocks = parseBlocks('> first\nstill the quote')
    expect(blocks).toEqual([{ kind: 'quote', lines: ['first', 'still the quote'] }])
  })

  it('lists: bullets, ordered alignment, nesting, and task items', () => {
    const rows = rowsOf('- one\n- two\n  - nested\n1. first\n2. second\n- [x] done\n- [ ] todo')
    expect(rows).toEqual(['• one', '• two', '  • nested', '1. first', '2. second', '✓ done', '· todo'])
  })

  it('a two-space-after-marker list line is a paragraph, not an item', () => {
    expect(rowsOf('-  two spaces')).toEqual(['-  two spaces'])
  })

  it('continuation lines hang under the content, marker-width aligned', () => {
    const rows = rowsOf('- a fairly long item that will wrap at this narrow measure', 24)
    expect(rows[0]).toMatch(/^• /u)
    for (const row of rows.slice(1)) {
      expect(row.startsWith('  ')).toBe(true)
      expect(row.startsWith('  •')).toBe(false)
    }
    const ordered = rowsOf('1. a fairly long item that will wrap here ok', 24)
    expect(ordered[0]).toMatch(/^1\. /u)
    expect(ordered[1]?.startsWith('   ')).toBe(true)
  })

  it('a pipe row without its delimiter stays paragraph text', () => {
    expect(rowsOf('a | b')).toEqual(['a | b'])
  })

  it('a table renders with truly aligned columns', () => {
    const rows = rowsOf('| module | role |\n|---|---|\n| kit | the substrate |\n| app | the desktop |')
    expect(rows).toEqual([
      'module │ role         ',
      '───────┼──────────────',
      'kit    │ the substrate',
      'app    │ the desktop  ',
    ])
    // The delimiter row's alignment is honoured: right pads left, centre splits.
    const aligned = rowsOf('| count | name |\n|---:|:---:|\n| 7 | x |')
    expect(aligned[2]).toBe('    7 │  x  ')
  })

  it('a table stacks field-per-record when the measure cannot hold it', () => {
    // Aligned this wants 6+3+9 = 18 columns; 17 cannot hold it, so the
    // pairing survives as one card per record instead of wrapping into mush.
    const rows = rowsOf('| module | role |\n|---|---|\n| kit | substrate |', 17)
    expect(rows).toEqual(['module: kit', '  role: substrate'])
  })

  it('cells truncate at the cap and may carry inline styling', () => {
    const rows = markdownRows(
      '| name | notes |\n|---|---|\n| `x` | a-very-long-cell-that-will-not-fit |',
      60, base, palette,
    )
    const data = rows[2]?.text ?? ''
    expect(data).toContain('…')
    expect(data).toContain('x')
  })

  it('a header without its delimiter yet renders as prose (streaming rule)', () => {
    expect(rowsOf('| a | b |')).toEqual(['| a | b |'])
  })

  it('a bare emoji in a cell costs one column, not two — the \u2604 case', () => {
    // The weather-table bug: rows with a bare BMP emoji drifted one cell
    // left of rows without one, because the emoji measured two columns
    // while the terminal rendered one.
    const rows = rowsOf('| sky | k |\n|---|---|\n| \u2604rain | a |\n| overcast | bb |')
    expect(rows[2]).toBe('\u2604rain    │ a ')
    expect(rows[3]).toBe('overcast │ bb')
    // Both rows' separators sit at the same column: 8+3+2.
    expect(rows[2]?.indexOf('\u2502')).toBe(rows[3]?.indexOf('\u2502'))
  })

  it('CJK cells measure two columns each', () => {
    const rows = rowsOf('| 模块 | 职责 |\n|---|---|\n| kit | 底座 |')
    expect(rows[0]).toBe('模块 │ 职责')
    // 'kit' pads to the header's four columns.
    expect(rows[2]).toBe('kit  │ 底座')
  })

  it('leading and trailing blank lines collapse', () => {
    expect(rowsOf('\n\nhello\n\n')).toEqual(['hello'])
  })
})

describe('inline parsing', () => {
  it('bold, italic, code, and strike compose over the base', () => {
    const segments = parseInline('**b** *i* `c` ~~s~~', base, code)
    const byFlag = segments.map(segment => ({
      bold: segment.style.bold === true,
      italic: segment.style.italic === true,
      code: segment.style.fg === code.fg,
      strike: segment.style.strike === true,
      inverse: segment.style.inverse === true,
    }))
    expect(byFlag).toContainEqual({ bold: true, italic: false, code: false, strike: false, inverse: false })
    expect(byFlag).toContainEqual({ bold: false, italic: true, code: false, strike: false, inverse: false })
    expect(byFlag).toContainEqual({ bold: false, italic: false, code: true, strike: false, inverse: false })
    expect(byFlag).toContainEqual({ bold: false, italic: false, code: false, strike: true, inverse: false })
  })

  it('nesting composes: bold containing italic and code', () => {
    const segments = parseInline('**b *i* `c`**', base, code)
    expect(segments.some(s => s.style.bold === true && s.style.italic === true)).toBe(true)
    expect(segments.some(s => s.style.bold === true && s.style.fg === code.fg)).toBe(true)
  })

  it('unclosed markers render literally — the streaming rule', () => {
    expect(parseInline('**oops', base, code)).toEqual([{ text: '**oops', style: base }])
    expect(parseInline('a `unclosed', base, code).map(s => s.text).join('')).toBe('a `unclosed')
    expect(parseInline('[t](u', base, code)).toEqual([{ text: '[t](u', style: base }])
  })

  it('mid-expression asterisks and underscores stay literal', () => {
    expect(parseInline('a * b * c', base, code)).toEqual([{ text: 'a * b * c', style: base }])
    expect(parseInline('snake_case_word', base, code)).toEqual([{ text: 'snake_case_word', style: base }])
  })

  it('strike is strict: tilde-only and empty spans stay literal', () => {
    expect(parseInline('~~ ~~', base, code)).toEqual([{ text: '~~ ~~', style: base }])
    expect(parseInline('~~~~', base, code)).toEqual([{ text: '~~~~', style: base }])
    // A real strike still works.
    expect(parseInline('~~gone~~', base, code)[0]?.style.strike).toBe(true)
  })

  it('links render text plainly, and the url only when it differs', () => {
    expect(parseInline('[DeepSeek](https://deepseek.com)', base, code))
      .toEqual([{ text: 'DeepSeek (https://deepseek.com)', style: base }])
    expect(parseInline('[x](x)', base, code)).toEqual([{ text: 'x', style: base }])
  })

  it('code spans are data: no CJK seam inside', () => {
    const segments = parseInline('`中文x`', base, code)
    expect(segments[0]?.text).toBe('中文x')
    expect(segments[0]?.style.fg).toBe(code.fg)
    expect(segments[0]?.verbatim).toBe(true)
  })
})

describe('the segment-aware wrapper', () => {
  it('wraps on words, drops break-spaces, and never exceeds the budget', () => {
    const lines = wrapSegments([{ text: 'one two three four five six seven', style: base }], 10)
    for (const line of lines) {
      const text = line.map(segment => segment.text).join('')
      expect(textWidth(text)).toBeLessThanOrEqual(10)
      expect(text).not.toMatch(/^\s/u)
      expect(text).not.toMatch(/\s$/u)
    }
    expect(lines.map(line => line.map(segment => segment.text).join(''))).toEqual(['one two', 'three four', 'five six', 'seven'])
  })

  it('never splits a wide glyph across lines', () => {
    const lines = wrapSegments([{ text: '一二三四五六七八九十', style: base }], 7)
    for (const line of lines) {
      for (const segment of line) {
        for (const unit of splitUnits(segment.text)) expect(unit.width).not.toBe(0)
      }
    }
    expect(lines.map(line => line.map(segment => segment.text).join(''))).toEqual(['一二三', '四五六', '七八九十'.slice(0, 3), '七八九十'.slice(3)])
  })

  it('honours kinsoku with styled spans across the realistic width range', () => {
    const paragraph = '这个解析器把整个文档读入内存之后才开始输出第一个token，所以首token的延迟不会低于整个文件的读取时间。正确的做法是边读边切词。'
    for (let width = 20; width <= 78; width++) {
      const lines = wrapSegments(parseInline(paragraph, { ...base, bold: true }, code), width)
      for (const line of lines) {
        const text = line.map(segment => segment.text).join('')
        expect(textWidth(text), `width ${width}`).toBeLessThanOrEqual(width)
        expect(text, `width ${width}: line starts with closing punctuation`).not.toMatch(/^[，。、！？；：）」』…]/u)
      }
    }
  })

  it('equal adjacent styles merge into one segment', () => {
    const lines = wrapSegments([
      { text: 'one ', style: base },
      { text: 'two', style: base },
    ], 20)
    expect(lines[0]).toEqual([{ text: 'one two', style: base }])
  })

  it('rows carry the plain text and the segments in agreement', () => {
    const rows = markdownRows('# Title\n\nbody **here**', 60, base, palette)
    for (const row of rows) {
      expect(row.text).toBe(row.segments.map(segment => segment.text).join(''))
    }
    expect(rows.map(row => row.text)).toEqual(['Title', 'body here'])
  })
})
