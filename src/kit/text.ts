/**
 * Text measurement and slicing in terminal columns.
 *
 * A terminal is a grid of cells, not a sequence of code points, so every
 * string that reaches a widget has to be measured the same way the terminal
 * will measure it. This module is that single measurement authority: East
 * Asian wide characters take two columns, combining marks and zero-width
 * joiners take none, and a wide glyph may never be split across a boundary.
 *
 * Widgets must never call `String.prototype.length` on display text.
 * @module @dsh-tvision/dsh-tvision/kit/text
 */

import { eastAsianWidth } from 'get-east-asian-width'

/** Zero-width characters that must attach to their neighbour: variation selectors, ZWJ, keycap. */
const ZERO_WIDTH = /[\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/u

/** Combining marks, which have no advance of their own. */
const COMBINING = /^[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF\uFE20-\uFE2F]$/u

/**
 * Grapheme segmentation, when the runtime has it.
 *
 * A cell is a *cluster*, not a code point: `👍🏽` is two code points and one
 * two-column glyph, `é` may be two code points and one one-column glyph, and a
 * flag is two regional indicators and one glyph. Measuring per code point would
 * miscount all of them and shift the rest of the row, so segmentation is not a
 * nicety here — it is the difference between a correct frame and a corrupted
 * one. `Intl.Segmenter` is present in every runtime this ships on, but the
 * per-code-point path stays as a fallback rather than throwing.
 */
const SEGMENTER: Intl.Segmenter | undefined = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : undefined

/** Whether a cluster requests emoji presentation (a variation selector-16), which is always two columns. */
const EMOJI_PRESENTATION = /\uFE0F/u

/** Whether a cluster is a regional-indicator pair (a flag), which is two columns. */
const FLAG_CLUSTER = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u

/**
 * The number of terminal columns one code point occupies.
 *
 * Deliberately conservative: a character this function calls narrow but the
 * terminal renders wide would shift every later cell on the row, so the
 * ambiguous-width code points (East Asian `A`) are treated as narrow, matching
 * the default behaviour of xterm, iTerm2, and Windows Terminal in a non-CJK
 * locale.
 * @param char - Exactly one code point (a surrogate pair counts as one).
 * @returns 0, 1, or 2 columns.
 */
export function charWidth(char: string): number {
  if (char === '') return 0
  const codePoint = char.codePointAt(0)
  /* c8 ignore next -- callers pass non-empty strings. */
  if (codePoint === undefined) return 0
  // Control characters never reach a buffer, but a stray escape would corrupt
  // the frame if it did; treat it as invisible.
  if (codePoint < 0x20 || codePoint === 0x7F) return 0
  if (ZERO_WIDTH.test(char) || COMBINING.test(char)) return 0
  // Unicode's own East Asian Width tables decide it, and they already classify
  // the emoji blocks as Wide. Ambiguous-width characters are held at 1 (see the
  // note above). The library validates that it was handed a code point.
  if (eastAsianWidth(codePoint, { ambiguousAsWide: false }) === 2) return 2
  return 1
}

/**
 * The number of columns one grapheme cluster occupies.
 *
 * A cluster is measured as a whole, which is what makes ZWJ emoji, skin-tone
 * modifiers, keycaps and flags come out right: they are two columns of
 * terminal, however many code points they took to write.
 * @param cluster - One grapheme cluster.
 * @returns 0, 1, or 2 columns.
 */
export function clusterWidth(cluster: string): number {
  if (cluster === '') return 0
  // Two columns come from exactly two things: an explicit emoji-presentation
  // request (VS16 turns `✓` into `✓️` and `1` into `1️⃣`), or a flag pair.
  // Everything else defers to the East Asian width of its code points — the
  // same table charWidth reads, so the two authorities cannot disagree. The old
  // blanket rule (any cluster merely *containing* a symbol from the emoji
  // blocks is wide) measured bare `✓` and `★` at two columns while the painter
  // drew them in one, shifting every later cell on the row.
  if (FLAG_CLUSTER.test(cluster) || EMOJI_PRESENTATION.test(cluster)) return 2
  let widest = 0
  for (const char of cluster) widest = Math.max(widest, charWidth(char))
  // Every code point zero-width means the whole cluster is invisible.
  return widest
}

/**
 * Split a string into grapheme clusters, each carrying its own width.
 * @param text - The string to split.
 * @returns Clusters in visual order.
 */
export function splitUnits(text: string): { text: string; width: number }[] {
  if (SEGMENTER !== undefined) {
    const out: { text: string; width: number }[] = []
    for (const { segment } of SEGMENTER.segment(text)) {
      out.push({ text: segment, width: clusterWidth(segment) })
    }
    return out
  }
  /* c8 ignore start -- the per-code-point fallback; Segmenter is universally present. */
  const units: { text: string; width: number }[] = []
  let pending = ''
  let pendingWidth = 0
  for (const char of text) {
    const width = charWidth(char)
    if (width === 0 && pending !== '') {
      pending += char
      continue
    }
    if (pending !== '') units.push({ text: pending, width: pendingWidth })
    pending = char
    pendingWidth = width
  }
  if (pending !== '') units.push({ text: pending, width: pendingWidth })
  return units
  /* c8 ignore stop */
}

/**
 * The number of terminal columns a string occupies.
 * @param text - The string to measure.
 * @returns The column count.
 */
export function textWidth(text: string): number {
  let width = 0
  for (const unit of splitUnits(text)) width += unit.width
  return width
}

/**
 * Truncate to a column budget without ever splitting a wide glyph.
 *
 * When the next unit would overflow, the remainder is filled with `ellipsis`
 * if it fits; otherwise the boundary is simply cut. The result never exceeds
 * `maxWidth` columns.
 * @param text - The string to truncate.
 * @param maxWidth - Maximum columns available; a non-positive budget yields `''`.
 * @param ellipsis - Marker appended when content was dropped (default `…`).
 * @returns A string of at most `maxWidth` columns.
 */
export function truncate(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return ''
  if (textWidth(text) <= maxWidth) return text
  const ellipsisWidth = textWidth(ellipsis)
  const budget = maxWidth - ellipsisWidth
  if (budget <= 0) return takeColumns(text, maxWidth)
  return `${takeColumns(text, budget)}${ellipsis}`
}

/**
 * Take the longest prefix that fits in `maxWidth` columns, without an
 * ellipsis and without splitting a glyph.
 * @param text - The string to cut.
 * @param maxWidth - Column budget.
 * @returns The prefix.
 */
export function takeColumns(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  let out = ''
  let used = 0
  for (const unit of splitUnits(text)) {
    if (used + unit.width > maxWidth) break
    out += unit.text
    used += unit.width
  }
  return out
}

/**
 * Drop the longest prefix that fits in `maxWidth` columns, keeping the tail.
 * @param text - The string to cut.
 * @param maxWidth - Column budget for the returned suffix.
 * @returns The suffix.
 */
export function takeColumnsEnd(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  const units = splitUnits(text)
  let used = 0
  let start = units.length
  while (start > 0) {
    const unit = units[start - 1]
    /* c8 ignore next -- start > 0 guarantees an element. */
    if (unit === undefined) break
    if (used + unit.width > maxWidth) break
    used += unit.width
    start--
  }
  return units.slice(start).map(unit => unit.text).join('')
}

/**
 * Pad to exactly `width` columns by appending spaces, truncating when the text
 * is already wider. This is the workhorse for filling a widget's interior.
 * @param text - The string to fit.
 * @param width - Exact target width in columns.
 * @returns A string of exactly `width` columns.
 */
export function padEnd(text: string, width: number): string {
  const current = textWidth(text)
  if (current === width) return text
  if (current > width) return takeColumns(text, width)
  return text + ' '.repeat(width - current)
}

/**
 * Centre within `width` columns, padding both sides, truncating when needed.
 * An odd remainder of one column goes to the right, matching `String.padStart`
 * intuition and keeping titles visually stable as they grow.
 * @param text - The string to centre.
 * @param width - Target width in columns.
 * @returns A string of exactly `width` columns.
 */
export function padCenter(text: string, width: number): string {
  const current = textWidth(text)
  if (current >= width) return takeColumns(text, width)
  const total = width - current
  const left = Math.floor(total / 2)
  return `${' '.repeat(left)}${text}${' '.repeat(total - left)}`
}

/**
 * Strip the zero-width characters that would corrupt a frame if a model or a
 * shell wrote them into a cell.
 * @param text - Input text.
 * @returns Text with zero-width formatting controls removed.
 */
export function stripZeroWidth(text: string): string {
  let out = ''
  for (const char of text) {
    if (charWidth(char) === 0 && char !== '\t') continue
    out += char
  }
  return out
}

/**
 * Replace tabs with spaces using a fixed tab stop, so a shell's output lands
 * on the same columns a terminal would have used.
 * @param text - Input text, possibly containing tabs and control characters.
 * @param tabWidth - Columns per tab stop (default 8, the terminal default).
 * @returns Tab-expanded text with other C0 controls removed.
 */
export function expandTabs(text: string, tabWidth = 8): string {
  let out = ''
  let column = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    if (char === '\t') {
      const stop = tabWidth - (column % tabWidth)
      out += ' '.repeat(stop)
      column += stop
      continue
    }
    // Strip C0 controls and DEL: they would move the real cursor.
    if (codePoint < 0x20 || codePoint === 0x7F) continue
    const width = charWidth(char)
    out += char
    column += width
  }
  return out
}
