/**
 * Markdown rendering for the transcript: blocks, inline spans, and a
 * segment-aware wrapper.
 *
 * An agent's prose is markdown whether the transcript likes it or not — the
 * models emit headings, lists, emphasis, and code spans by habit — and
 * rendering the markers literally (`**bold**` with its asterisks) reads as
 * broken. This module turns a text piece into styled rows, following the
 * conventions terminal renderers converged on (pi's TUI, glamour, Claude
 * Code): structure is expressed with attributes — bold, underline, reverse —
 * because attributes survive every skin, and colour is spent almost nowhere.
 *
 * Two properties are load-bearing:
 *
 * - **Streaming safety.** Every marker is only consumed when its closing
 *   partner has arrived; a half-streamed `**bold` renders literally and
 *   becomes bold one chunk later. No partial state, no flicker.
 * - **The wrapper never lies about width.** Wrapping operates on grapheme
 *   clusters carrying styles, with the same kinsoku (禁則) and CJK rules the
 *   plain-text wrapper honours — a wide glyph is never split, closing
 *   punctuation never opens a line.
 * @module @dsh-tvision/dsh-tvision/views/markdown
 */

import type { Style } from '../kit/cell.ts'
import type { ResolvedPalette } from '../kit/skin.ts'
import { NO_LINE_END, NO_LINE_START, splitUnits, spreadCjkLatin, textWidth } from '../kit/text.ts'

/** One styled run of text; consecutive runs with equal style are merged. */
export interface MdSeg {
  readonly text: string
  readonly style: Style
}

/** One visual row: the plain text (search and snapshots read this) and runs. */
export interface MdRow {
  readonly text: string
  readonly segments: readonly MdSeg[]
}

/**
 * Render a markdown text as wrapped, styled rows.
 * @param text - The markdown source (a text piece; fences arrive only if the
 * caller did not split them — a stray fence line passes through literally).
 * @param width - The column budget for the body.
 * @param base - The body style spans compose over.
 * @param palette - The active skin, for the quote and task-marker roles.
 * @returns One row per visual line.
 */
export function markdownRows(
  text: string,
  width: number,
  base: Style,
  palette: ResolvedPalette,
): MdRow[] {
  if (width <= 0) return [{ text: '', segments: [{ text: '', style: base }] }]
  const rows: MdRow[] = []
  for (const block of parseBlocks(text)) {
    rows.push(...blockRows(block, width, base, palette))
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

/** A parsed block-level element. */
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'hr' }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; items: ListItem[] }
  | { kind: 'paragraph'; text: string }

/** One list item: its marker (rendered), its content lines, and children. */
interface ListItem {
  /** The rendered marker, e.g. `• `, `1. `, `✓ `; width aligns continuations. */
  readonly marker: string
  readonly markerStyle: Style | 'task-done' | 'task-todo' | 'plain'
  /** Content lines of this item (already stripped of the source marker). */
  readonly lines: string[]
  /** Nested list items beneath this one; filled during parsing. */
  children: ListItem[]
}

/**
 * Split markdown source into blocks.
 *
 * Deliberately small: paragraphs, headings, rules, quotes, and lists (with
 * nesting by two-space indent and task items). Tables are not attempted — a
 * pipe row falls through as paragraph text, which is the honest fallback at a
 * sixty-column measure.
 * @param text - The markdown source.
 * @returns Blocks in document order.
 */
export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index++
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: heading[1]?.length ?? 1, text: heading[2] ?? '' })
      index++
      continue
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      blocks.push({ kind: 'hr' })
      index++
      continue
    }
    if (line.startsWith('>')) {
      const quoted: string[] = []
      while (index < lines.length) {
        const current = lines[index] ?? ''
        if (current.startsWith('>')) {
          quoted.push(current.replace(/^>\s?/u, ''))
          index++
          continue
        }
        // Lazy continuation: a non-blank, non-marker line extends the quote.
        if (current.trim() !== '' && !isBlockStart(current)) {
          quoted.push(current)
          index++
          continue
        }
        break
      }
      blocks.push({ kind: 'quote', lines: quoted })
      continue
    }
    if (isListMarker(line)) {
      const [items, next] = parseList(lines, index, '')
      blocks.push({ kind: 'list', items })
      index = next
      continue
    }
    // Paragraph: until a blank line or the start of another block.
    const paragraph: string[] = [line]
    index++
    while (index < lines.length) {
      const current = lines[index] ?? ''
      if (current.trim() === '' || isBlockStart(current)) break
      paragraph.push(current)
      index++
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
  }
  return blocks
}

/** Whether a line begins a construct the paragraph loop must yield to. */
function isBlockStart(line: string): boolean {
  return /^(#{1,6})\s/u.test(line)
    || /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/u.test(line)
    || line.startsWith('>')
    || isListMarker(line)
}

/** Whether a line opens a list item at any of the accepted indents. */
function isListMarker(line: string): boolean {
  return /^(-|\*|\+)\s\S/u.test(line) || /^\d{1,3}\.\s\S/u.test(line)
}

/**
 * Parse a list (and its nested lists) starting at `index`.
 * @param lines - The document lines.
 * @param index - The first item's line.
 * @param depth - The nesting level, for two-space indent accounting.
 * @returns The items and the index of the first line after the list.
 */
function parseList(lines: string[], index: number, indent: string): [ListItem[], number] {
  const items: ListItem[] = []
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      // A blank line ends the list unless the next non-blank line continues
      // it (loose list); look ahead one line.
      const after = lines[index + 1] ?? ''
      if (after.startsWith(indent) && (isListMarker(after.slice(indent.length)) || after.slice(indent.length).startsWith(' '))) {
        index++
        continue
      }
      break
    }
    if (!line.startsWith(indent)) break
    const rest = line.slice(indent.length)
    const marker = /^([*+-])\s(\S.*)$/u.exec(rest)
    const ordered = /^(\d{1,3}\.)\s(\S.*)$/u.exec(rest)
    if (marker === null && ordered === null) {
      // Continuation of the previous item, or the end of this list.
      if (rest.startsWith(' ') && items.length > 0) {
        const item = items[items.length - 1]
        if (item !== undefined) item.lines.push(rest.trim())
        index++
        continue
      }
      break
    }
    const rawMarker = marker?.[1] ?? ordered?.[1] ?? ''
    let content = marker?.[2] ?? ordered?.[2] ?? ''
    // Task list: `[x] `/`[ ] ` immediately after the bullet.
    const task = /^\[([ xX])\]\s+(.*)$/u.exec(content)
    let itemMarker = ordered !== null ? `${rawMarker} ` : '• '
    let taskState: 'task-done' | 'task-todo' | undefined
    if (marker !== null && task !== null) {
      taskState = (task[1] ?? ' ').toLowerCase() === 'x' ? 'task-done' : 'task-todo'
      content = task[2] ?? ''
      itemMarker = taskState === 'task-done' ? '✓ ' : '· '
    }
    const item: ListItem = {
      marker: itemMarker,
      markerStyle: taskState ?? 'plain',
      lines: [content],
      children: [],
    }
    items.push(item)
    index++
    // Nested list: the next line is indented deeper than this level — by
    // however much the writer chose (two spaces under a bullet, three under
    // `1. `); the nested run's own indent becomes its level's indent.
    {
      const nextLine = lines[index] ?? ''
      const nestedIndent = /^[ ]+/u.exec(nextLine)?.[0] ?? ''
      if (nextLine.trim() !== '' && nestedIndent.length > indent.length
        && isListMarker(nextLine.slice(nestedIndent.length))) {
        const [children, next] = parseList(lines, index, nestedIndent)
        const target = items[items.length - 1]
        if (target !== undefined) target.children = children
        index = next
      }
    }
  }
  return [items, index]
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

/**
 * Parse inline markdown into styled segments.
 *
 * Recognises `**bold**`, `*italic*` / `_italic_` (word-bounded), `` `code` ``
 * (reverse video), `~~strike~~` (strictly spaced or word-bound content), and
 * `[text](url)`. Every construct requires its closing partner to have
 * arrived, so a half-streamed marker renders literally.
 * @param text - The source line, markers included.
 * @param base - The style segments compose over.
 * @returns Styled segments covering the whole line.
 */
export function parseInline(text: string, base: Style): MdSeg[] {
  const segments: MdSeg[] = []
  // The scanning cursor over the raw source; plain text between constructs
  // accumulates in `pending`.
  let cursor = 0
  let pending = ''
  const flush = (style: Style): void => {
    if (pending === '') return
    segments.push({ text: pending, style })
    pending = ''
  }
  const source = text
  while (cursor < source.length) {
    const rest = source.slice(cursor)
    // Inline code: shortest `...` span; no nesting inside.
    if (rest.startsWith('`')) {
      const close = rest.indexOf('`', 1)
      if (close > 0) {
        flush(base)
        // Code characters are data: no CJK seam, no further parsing.
        segments.push({ text: rest.slice(1, close), style: { ...base, inverse: true } })
        cursor += close + 1
        continue
      }
    }
    // Bold, then italic on the single-character markers.
    if (rest.startsWith('**')) {
      const span = matchSpan(rest, '**')
      if (span !== undefined) {
        flush(base)
        segments.push(...parseInline(span, { ...base, bold: true }))
        cursor += span.length + 4
        continue
      }
    }
    if (rest.startsWith('~~')) {
      // Strict: inner content must not be empty, all-tilde, or
      // space-flanked tilde runs — `~~~` and `~~ ~~` stay literal.
      const span = matchSpan(rest, '~~')
      if (span !== undefined && !/^~+$/u.test(span.trim()) && span.trim() !== '') {
        flush(base)
        segments.push(...parseInline(span, { ...base, strike: true }))
        cursor += span.length + 4
        continue
      }
    }
    const link = /^\[([^\]]{1,80})\]\(([^()\s]{1,200})\)/u.exec(rest)
    if (link !== null) {
      const label = link[1] ?? ''
      const url = link[2] ?? ''
      flush(base)
      // The shown URL in parentheses is the affordance; an underline on top
      // of it is visual noise across a whole paragraph.
      const shown = label === url || url === '' ? label : `${label} (${url})`
      segments.push({ text: shown, style: base })
      cursor += link[0].length
      continue
    }
    if (rest.startsWith('*') || (rest.startsWith('_') && !/\w|$/u.test(source[cursor - 1] ?? ''))) {
      const marker = rest[0] ?? ''
      const span = matchSpan(rest, marker, source[cursor - 1])
      if (span !== undefined) {
        flush(base)
        segments.push(...parseInline(span, { ...base, italic: true }))
        cursor += span.length + 2
        continue
      }
    }
    pending += source[cursor]
    cursor += 1
  }
  flush(base)
  // The CJK/Latin seam is display dressing; apply it to non-code runs only.
  return segments.map(segment =>
    segment.style.inverse === true
      ? segment
      : { ...segment, text: spreadCjkLatin(segment.text) }
  )
}

/**
 * Match a closing-delimited span at the start of `rest`.
 * @param rest - The remaining source, starting at the opener.
 * @param opener - The delimiter, e.g. `**`.
 * @param before - The character before the opener (flanking check).
 * @param closeIndexHint - Precomputed close position, when the caller found one.
 * @returns The span's inner content, or undefined when unclosed.
 */
function matchSpan(rest: string, opener: string, before?: string, closeIndexHint?: number): string | undefined {
  const close = closeIndexHint ?? rest.indexOf(opener, opener.length)
  if (close < opener.length) return undefined
  const inner = rest.slice(opener.length, close)
  if (inner === '') return undefined
  // Delimiters need a non-space inner flank on both sides — `a * b * c` is
  // not emphasis — and `_` only at word boundaries.
  if (opener === '_' || opener === '*') {
    if (before !== undefined && /\w/u.test(before) && opener === '_') return undefined
    if (inner.startsWith(' ') || inner.endsWith(' ')) return undefined
  }
  return inner
}

/* ------------------------------------------------------------------ */
/* Blocks to rows                                                      */
/* ------------------------------------------------------------------ */

/** Render one block as rows. */
function blockRows(block: Block, width: number, base: Style, palette: ResolvedPalette): MdRow[] {
  switch (block.kind) {
    case 'heading': {
      const style = block.level === 1
        ? { ...base, bold: true, underline: true }
        : { ...base, bold: true }
      const source = block.level >= 3 ? `${'#'.repeat(block.level)} ${block.text}` : block.text
      return wrapSegments(parseInline(source, style), width).map(toRow)
    }
    case 'hr':
      return [{ text: '─'.repeat(width), segments: [{ text: '─'.repeat(width), style: base }] }]
    case 'quote': {
      const quoteStyle = { ...palette.reasoning, italic: true }
      const rows: MdRow[] = []
      for (const line of block.lines) {
        const inner = wrapSegments(parseInline(line, quoteStyle), Math.max(1, width - 2))
        for (const line2 of inner) {
          rows.push({
            text: `│ ${line2.map(seg => seg.text).join('')}`,
            segments: [{ text: '│ ', style: palette.reasoning }, ...line2],
          })
        }
      }
      return rows
    }
    case 'paragraph':
      return wrapSegments(parseInline(block.text, base), width).map(toRow)
    case 'list':
      return listRows(block.items, width, base, palette, 0)
    /* c8 ignore next 2 -- the union is exhaustive. */
    default:
      return []
  }
}

/** Render list items (recursively) with hanging indents. */
function listRows(
  items: readonly ListItem[],
  width: number,
  base: Style,
  palette: ResolvedPalette,
  depth: number,
): MdRow[] {
  const rows: MdRow[] = []
  const indent = '  '.repeat(depth)
  for (const item of items) {
    const markerStyle = item.markerStyle === 'task-done'
      ? palette.toolSuccess
      : item.markerStyle === 'task-todo'
        ? palette.bodyText
        : base
    const room = Math.max(1, width - textWidth(indent) - textWidth(item.marker))
    const hang = ' '.repeat(textWidth(item.marker))
    // Each logical line wraps to `room` columns; the first visual row of the
    // first logical line carries the marker, every later visual row hangs by
    // the marker's width so content stays aligned.
    for (const [lineIndex, line] of item.lines.entries()) {
      const wrapped = wrapSegments(parseInline(line, base), room)
      for (const [wrapIndex, segs] of wrapped.entries()) {
        const carriesMarker = lineIndex === 0 && wrapIndex === 0
        const prefixText = carriesMarker ? `${indent}${item.marker}` : `${indent}${hang}`
        const prefixSegs: MdSeg[] = carriesMarker
          ? [{ text: indent, style: base }, { text: item.marker, style: markerStyle }]
          : [{ text: prefixText, style: base }]
        rows.push({
          text: `${prefixText}${segs.map(segment => segment.text).join('')}`,
          segments: mergeSegs([...prefixSegs, ...segs]),
        })
      }
    }
    if (item.children.length > 0) rows.push(...listRows(item.children, width, base, palette, depth + 1))
  }
  return rows
}

/* ------------------------------------------------------------------ */
/* Segment-aware wrapping                                              */
/* ------------------------------------------------------------------ */

/** One grapheme cluster with its width and style. */
interface Unit {
  readonly text: string
  readonly width: number
  readonly style: Style
}

/**
 * Wrap styled segments to a column budget with the same discipline the
 * plain-text wrapper follows: word boundaries when there are any, hard cut
 * with kinsoku pull-back when a run has none, wide glyphs never split.
 * @param segments - The styled source.
 * @param width - The column budget.
 * @returns One segment list per visual line, equal styles merged.
 */
export function wrapSegments(segments: readonly MdSeg[], width: number): MdSeg[][] {
  if (width <= 0) return [segments.slice()]
  const units: Unit[] = []
  for (const segment of segments) {
    for (const unit of splitUnits(segment.text)) {
      units.push({ text: unit.text, width: unit.width, style: segment.style })
    }
  }
  const lines: Unit[][] = []
  let line: Unit[] = []
  let lineW = 0
  let index = 0
  while (index < units.length) {
    const unit = units[index]
    if (unit === undefined) break
    if (isWhitespace(unit.text)) {
      // A whitespace run carries onto the current line (and counts toward its
      // width); at a line start it is dropped, which is what makes a break
      // clean. The break itself below additionally trims a trailing run.
      const held: Unit[] = []
      while (index < units.length) {
        const probe = units[index]
        if (probe === undefined || !isWhitespace(probe.text)) break
        held.push(probe)
        index++
      }
      if (line.length > 0) {
        line.push(...held)
        lineW += sumWidth(held)
      }
      continue
    }
    // A word: the maximal run of non-whitespace units.
    const word: Unit[] = []
    let wordW = 0
    while (index < units.length) {
      const probe = units[index]
      if (probe === undefined || isWhitespace(probe.text)) break
      word.push(probe)
      wordW += probe.width
      index++
    }
    if (line.length > 0 && lineW + wordW > width) {
      // A wrapped line never shows its trailing break-space.
      lines.push(trimTrailingSpace(line))
      line = []
      lineW = 0
      // Re-attempt the word on the fresh line (index already advanced past it).
      if (wordW > width) {
        let rest = word
        while (sumWidth(rest) > width) {
          const head = takeUnitsKinsoku(rest, width)
          lines.push(head)
          rest = rest.slice(head.length)
        }
        line = rest
        lineW = sumWidth(rest)
      } else {
        line = word
        lineW = wordW
      }
      continue
    }
    if (wordW > width) {
      // A word too wide even alone: hard cut with kinsoku, from anywhere.
      let rest = word
      if (line.length > 0) {
        lines.push(line)
        line = []
        lineW = 0
      }
      while (sumWidth(rest) > width) {
        const head = takeUnitsKinsoku(rest, width)
        lines.push(head)
        rest = rest.slice(head.length)
      }
      line = rest
      lineW = sumWidth(rest)
      continue
    }
    line.push(...word)
    lineW += wordW
  }
  if (line.length > 0) lines.push(line)
  if (lines.length === 0) lines.push([])
  return lines.map(line => mergeSegs(line.map(unit => ({ text: unit.text, style: unit.style }))))
}

/** A copy of the line without its trailing whitespace units. */
function trimTrailingSpace(line: readonly Unit[]): Unit[] {
  let end = line.length
  while (end > 0 && isWhitespace(line[end - 1]?.text ?? '')) end--
  return line.slice(0, end)
}

/** Whether a cluster is breakable whitespace. */
function isWhitespace(text: string): boolean {
  return text === ' ' || text === '\t'
}

/** Sum the column widths of units. */
function sumWidth(units: readonly Unit[]): number {
  let total = 0
  for (const unit of units) total += unit.width
  return total
}

/**
 * Take the longest prefix of units that fits `width`, pulling back whole
 * clusters so closing punctuation never opens a line and opening brackets
 * never end one — the unit-level mirror of the plain-text cutter.
 */
function takeUnitsKinsoku(units: readonly Unit[], width: number): Unit[] {
  let count = 0
  let used = 0
  while (count < units.length) {
    const unit = units[count]
    if (unit === undefined || used + unit.width > width) break
    used += unit.width
    count++
  }
  for (;;) {
    const nextStart = units[count]?.text ?? ''
    if (count < units.length && NO_LINE_START.has(nextStart)) {
      if (count === 0) break
      count--
      continue
    }
    const lastEnd = units[count - 1]?.text ?? ''
    if (count > 0 && NO_LINE_END.has(lastEnd)) {
      count--
      if (count === 0) break
      continue
    }
    break
  }
  return units.slice(0, count)
}

/** Merge adjacent segments with equal style; equality is field-by-field. */
function mergeSegs(segments: readonly MdSeg[]): MdSeg[] {
  const out: MdSeg[] = []
  for (const segment of segments) {
    const last = out[out.length - 1]
    if (last !== undefined && styleEqual(last.style, segment.style)) {
      out[out.length - 1] = { text: last.text + segment.text, style: last.style }
      continue
    }
    out.push(segment)
  }
  return out
}

/** Field-by-field style equality (the renderer's own comparator). */
function styleEqual(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim
    && a.italic === b.italic && a.underline === b.underline && a.blink === b.blink
    && a.inverse === b.inverse && a.strike === b.strike
}

/** An MdRow from a wrapped line of segments. */
function toRow(segments: readonly MdSeg[]): MdRow {
  return { text: segments.map(segment => segment.text).join(''), segments }
}
