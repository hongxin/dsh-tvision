/**
 * The transcript view: turns a {@link SessionDocument} into rows of styled text
 * and paints the visible slice into a window.
 *
 * The layout is a gutter plus a content column:
 *
 * ```text
 *  > You
 *    refactor the parser so it streams
 *
 *  | Agent
 *    Right — the parser should push chunks as they arrive rather than
 *    buffering the whole document first.
 *
 *  ~ bash                                    ok · 0.4s
 *    ┌──────────────────────────────────────────────┐
 *    │ npm test -- parser                           │
 *    └──────────────────────────────────────────────┘
 * ```
 *
 * The gutter is what makes a dense transcript scannable: your own turns are
 * `>`, the agent's are `|`, tool calls are `~`, and failures are `!`, so the
 * shape of a conversation is legible before a word of it is read.
 *
 * Rows are cached against `(width, revision, expanded)`. A streaming response
 * changes the document on every token, so the cache is rebuilt then — but a
 * repaint caused by a cursor blink, a clock tick, or a window being uncovered
 * costs a single comparison.
 * @module @dsh-tvision/dsh-tvision/views/transcript
 */

import type { Style } from '../kit/cell.ts'
import type { Painter } from '../kit/painter.ts'
import type { MouseEvent, Widget, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import type { ResolvedPalette } from '../kit/skin.ts'
import { spreadCjkLatin, takeColumns, textWidth } from '../kit/text.ts'
import { formatDuration } from '../widgets/statusbar.ts'
import type { ContentPiece, Entry, SessionDocument } from '../session/model.ts'

/** One rendered row of the transcript. */
export interface TranscriptRow {
  /** The full text of the row, gutter included. */
  readonly text: string
  /** Style for the gutter columns. */
  readonly gutterStyle: Style
  /** Style for the body. */
  readonly style: Style
  /** The entry this row came from, for hit testing and for "jump to here". */
  readonly entryId: number
  /** True for a row that begins an entry, which gets a blank row before it. */
  readonly startsEntry?: boolean
}

/** How the transcript draws itself. */
export interface TranscriptTheme {
  /** Width of the gutter column, in cells. */
  readonly gutterWidth: number
  /** Whether tool cards are drawn collapsed to a one-line summary. */
  readonly collapsed: boolean
  /** Whether reasoning text is shown at all. */
  readonly showReasoning: boolean
}

/**
 * The canvas: paints rows and keeps the scroll position.
 *
 * Scroll is measured in *rows*, not entries, because that is what the user
 * perceives — the wheel moves the text, not the cards. `stickToBottom` is the
 * behaviour every chat interface needs and none of them get right on the first
 * try: new output follows the end until the user scrolls away, and then it must
 * *stop* following, or reading history becomes impossible.
 */
export class TranscriptView implements Widget {
  private readonly document: SessionDocument
  private theme: TranscriptTheme
  private rows: TranscriptRow[] = []
  private cacheKey = ''
  /** The palette the cached rows were built for, compared by identity. */
  private cachedPalette: ResolvedPalette | undefined
  private scrollTop = 0
  private stick = true
  private lastHeight = 0
  /** The width of the last paint, so rows can be measured on demand. */
  private lastWidth = 0
  /** The palette of the last paint, for the same reason. */
  private lastPalette: ResolvedPalette | undefined
  private lastLimit = 0
  /** Which entries are individually expanded, overriding the theme default. */
  private readonly expanded = new Set<number>()

  /**
   * @param document - The session document to render.
   * @param theme - Layout and visibility options.
   */
  constructor(document: SessionDocument, theme: TranscriptTheme) {
    this.document = document
    this.theme = theme
  }

  /**
   * Change the layout options and drop the cached rows.
   * @param theme - The new layout and visibility options.
   */
  setTheme(theme: TranscriptTheme): void {
    this.theme = theme
    this.cacheKey = ''
  }

  /**
   * Whether reasoning text is being rendered.
   *
   * A real accessor rather than a cast on the private field: `Ctrl+R` flips
   * this, and a caller peeking the field by name breaks silently on a rename.
   * @returns True when reasoning rows are shown.
   */
  get showReasoning(): boolean {
    return this.theme.showReasoning
  }

  /**
   * How many entries are individually expanded beyond the theme default.
   *
   * The F4 toggle reads this to decide direction: zero means everything is at
   * the default (collapsed) and the key expands; anything else means expanded
   * and the key collapses. `toggleEntry` counts here too, which reads as "any
   * expansion means expanded" — the honest answer for a two-state key.
   * @returns The number of expanded entries.
   */
  get expandedCount(): number {
    return this.expanded.size
  }

  /**
   * Whether the view is pinned to the newest output.
   * @returns True when new rows scroll the view automatically.
   */
  get following(): boolean {
    return this.stick
  }

  /**
   * The first visible row index.
   * @returns The row index at the top of the viewport.
   */
  get offset(): number {
    return this.scrollTop
  }

  /**
   * How far the view can scroll, recomputed from the current document.
   *
   * Derived rather than cached: a key arrives before the next paint, and a key
   * handler that thinks the document is one row long would swallow the arrow
   * keys the composer needs.
   * @returns The highest valid scroll offset.
   */
  private limit(palette?: ResolvedPalette): number {
    const active = palette ?? this.lastPalette
    const rows = active === undefined || this.lastWidth === 0
      ? this.rows.length
      : this.rowsFor(this.lastWidth, active).length
    return Math.max(0, rows - Math.max(1, this.lastHeight))
  }

  /**
   * Total rows in the document at the last rendered width.
   * @returns The row count.
   */
  get total(): number {
    return this.rows.length
  }

  /** Scroll to the very top and stop following. */
  scrollToStart(): void {
    this.scrollTop = 0
    this.stick = false
  }

  /** Scroll to the very end and resume following. */
  scrollToEnd(): void {
    this.stick = true
  }

  /**
   * Scroll by a number of rows.
   * @param delta - Negative scrolls towards the start.
   */
  scrollBy(delta: number): void {
    if (this.rows.length === 0) return
    const max = this.limit()
    const next = Math.max(0, Math.min(max, this.scrollTop + delta))
    // Reaching the bottom by hand re-arms following; moving away from it
    // disarms, which is the whole interaction.
    this.stick = next >= max
    this.scrollTop = next
  }

  /**
   * Toggle one entry between collapsed and expanded.
   * @param entryId - The entry id.
   */
  toggleEntry(entryId: number): void {
    if (this.expanded.has(entryId)) this.expanded.delete(entryId)
    else this.expanded.add(entryId)
    this.cacheKey = ''
  }

  /** Expand every tool card that can be expanded. */
  expandAll(): void {
    for (const entry of this.document.all) this.expanded.add(entry.id)
    this.cacheKey = ''
  }

  /** Collapse every individually expanded card. */
  collapseAll(): void {
    this.expanded.clear()
    this.cacheKey = ''
  }

  /**
   * Rebuild the row list if the document, the width, or the options changed.
   * @param width - The content width in columns.
   * @param palette - The active palette.
   * @returns The rows.
   */
  rowsFor(width: number, palette: ResolvedPalette): TranscriptRow[] {
    // The cache key carries the palette by identity, not as a string: skins
    // resolve to a fresh object per activation, so the reference *is* the skin,
    // and without it F9 left stale-coloured rows until the next document
    // revision bumped them out.
    const key = [
      width,
      this.document.revision,
      this.theme.collapsed ? 'c' : 'e',
      this.theme.showReasoning ? 'r' : 'n',
      [...this.expanded].sort((a, b) => a - b).join(','),
    ].join('|')
    if (key === this.cacheKey && palette === this.cachedPalette) return this.rows
    this.rows = buildRows(this.document.all, width, palette, this.theme, this.expanded)
    this.cacheKey = key
    this.cachedPalette = palette
    return this.rows
  }

  /**
   * Paint the transcript.
   * @param painter - The window interior.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    this.lastWidth = painter.width
    this.lastPalette = palette
    const rows = this.rowsFor(painter.width, palette)
    this.lastHeight = painter.height
    if (this.stick) this.scrollTop = Math.max(0, rows.length - painter.height)
    const max = Math.max(0, rows.length - painter.height)
    this.lastLimit = max
    this.scrollTop = Math.min(this.scrollTop, max)
    for (let row = 0; row < painter.height; row++) {
      const source = rows[this.scrollTop + row]
      if (source === undefined) break
      // A blank spacer row before each entry keeps the transcript breathable
      // without every entry having to remember to emit one.
      this.paintRow(painter, row, source, painter.width)
    }
    // A "scrolled up" indicator in the bottom-right, so a reader knows there is
    // more below without the title bar having to say so.
    if (!this.stick && rows.length > painter.height) {
      const label = ` ↓ ${rows.length - this.scrollTop - painter.height} more `
      painter.text(painter.width - textWidth(label), painter.height - 1, label, textWidth(label), palette.diffMeta)
    }
  }

  /**
   * Paint one row, gutter and body separately so they can be styled apart.
   * @param painter - The window interior.
   * @param row - The destination row.
   * @param source - The row to paint.
   * @param width - Available columns.
   */
  private paintRow(painter: Painter, row: number, source: TranscriptRow, width: number): void {
    const gutterWidth = Math.min(this.theme.gutterWidth, width)
    const gutter = takeColumns(source.text, gutterWidth)
    painter.text(0, row, gutter, gutterWidth, source.gutterStyle)
    const body = source.text.slice(gutter.length)
    painter.text(gutterWidth, row, body, Math.max(0, width - gutterWidth), source.style)
    void width
  }

  /**
   * Handle scroll keys. The transcript is a viewer, so it takes the keys a pager
   * takes and nothing else; everything else belongs to the composer.
   * @param event - The key event.
   * @returns Whether the key was consumed.
   */
  onKey(event: { key: string; ctrl?: boolean; alt?: boolean }): Consumed {
    // A modified key is never a pager key: `Alt+Up` and `Ctrl+Home` belong to
    // whoever else wants them.
    if (event.ctrl === true || event.alt === true) return Consumed.No
    const max = this.limit()
    switch (event.key) {
      case 'pageup':
        if (this.scrollTop <= 0) return Consumed.No
        this.scrollBy(-Math.max(1, this.lastHeight - 1))
        return Consumed.Yes
      case 'pagedown':
        if (this.scrollTop >= max) return Consumed.No
        this.scrollBy(Math.max(1, this.lastHeight - 1))
        return Consumed.Yes
      case 'home':
        if (this.scrollTop <= 0) return Consumed.No
        this.scrollToStart()
        return Consumed.Yes
      case 'end':
        if (this.scrollTop >= max) return Consumed.No
        this.scrollToEnd()
        return Consumed.Yes
      case 'up':
        // Passing the key on at the top is what lets Up reach the composer's
        // history instead of being silently swallowed.
        if (this.scrollTop <= 0) return Consumed.No
        this.scrollBy(-1)
        return Consumed.Yes
      case 'down':
        // At the end, Down means "newer history", not "scroll further".
        if (this.scrollTop >= max) return Consumed.No
        this.scrollBy(1)
        return Consumed.Yes
      default:
        return Consumed.No
    }
  }

  /**
   * Handle the wheel.
   * @param event - The mouse event, in screen coordinates relative to the widget.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent): Consumed {
    if (event.kind !== 'wheel') return Consumed.No
    this.scrollBy((event.delta ?? 1) * 3)
    return Consumed.Yes
  }

  /**
   * Scroll metrics for the window's scrollbar.
   * @returns Offset, total, and visible rows.
   */
  scrollMetrics(): { offset: number; total: number; visible: number } {
    const total = this.lastLimit + Math.max(1, this.lastHeight)
    return {
      offset: this.scrollTop,
      total: Math.max(1, total),
      visible: Math.max(1, this.lastHeight),
    }
  }
}

/**
 * Build the full row list for a document.
 *
 * Kept as a free function so the row builder can be tested without a window, a
 * painter, or a palette beyond the styles it reads.
 * @param entries - The document's entries.
 * @param width - The content width in columns.
 * @param palette - The active palette.
 * @param theme - Layout and visibility options.
 * @param expanded - Entries individually expanded beyond the theme default.
 * @returns The rows, oldest first.
 */
export function buildRows(
  entries: readonly Entry[],
  width: number,
  palette: ResolvedPalette,
  theme: TranscriptTheme,
  expanded: ReadonlySet<number> = new Set(),
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const bodyWidth = Math.max(8, width - theme.gutterWidth)
  let first = true
  for (const entry of entries) {
    if (!first) rows.push(blankRow(entry.id))
    first = false
    rows.push(...entryRows(entry, bodyWidth, palette, theme, expanded))
  }
  if (rows.length === 0) {
    rows.push({
      text: '  nothing here yet — type a message below, or press F1 for help',
      gutterStyle: palette.reasoning,
      style: palette.reasoning,
      entryId: -1,
    })
  }
  return rows
}

/** A blank spacer row attributed to the entry that follows it. */
function blankRow(entryId: number): TranscriptRow {
  return { text: '', gutterStyle: {}, style: {}, entryId }
}

/**
 * The rows for one entry.
 * @param entry - The entry.
 * @param width - Body width in columns.
 * @param palette - The palette.
 * @param theme - Layout options.
 * @param expanded - Entries expanded beyond the default.
 * @returns The rows.
 */
function entryRows(
  entry: Entry,
  width: number,
  palette: ResolvedPalette,
  theme: TranscriptTheme,
  expanded: ReadonlySet<number>,
): TranscriptRow[] {
  switch (entry.kind) {
    case 'user':
      return messageRows(entry, width, palette, '>', palette.userLabel, palette.bodyText)
    case 'context':
      return messageRows(entry, width, palette, '+', palette.diffMeta, palette.reasoning)
    case 'assistant':
      return assistantRows(entry, width, palette, theme, expanded)
    case 'tool':
      return toolRows(entry, width, palette, theme, expanded)
    case 'notice':
      return messageRows(entry, width, palette, '-', palette.notice, palette.notice)
    case 'error':
      return messageRows(entry, width, palette, '!', palette.error, palette.error)
    case 'compaction':
      return messageRows(entry, width, palette, '~', palette.diffMeta, palette.reasoning)
    /* c8 ignore next 2 -- exhaustive over EntryKind. */
    default:
      return []
  }
}

/**
 * The widest column prose is wrapped to, however wide the window is.
 *
 * A reading measure, not a frame limit: a full-width transcript on a wide
 * terminal runs to fifty characters of Chinese per line, which is a wall of
 * text rather than a paragraph. Tool cards, code blocks, and diffs keep the
 * whole interior — their content is shape-bearing and the frames exist to be
 * filled. Sixty columns is the classic comfortable measure, ~30 CJK glyphs.
 */
const PROSE_MAX_COLUMNS = 60

/** Wrap prose at the measure or the available width, whichever is smaller. */
function proseWidth(available: number): number {
  return Math.min(available, PROSE_MAX_COLUMNS)
}

/**
 * A simple gutter-plus-prose entry.
 * @param entry - The entry.
 * @param width - Body width.
 * @param palette - The palette.
 * @param marker - The one-character gutter marker.
 * @param gutterStyle - Style for the marker.
 * @param bodyStyle - Style for the prose.
 * @returns The rows.
 */
function messageRows(
  entry: Entry,
  width: number,
  palette: ResolvedPalette,
  marker: string,
  gutterStyle: Style,
  bodyStyle: Style,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const heading = entry.title ?? ''
  rows.push({
    text: `${marker} ${heading}`,
    gutterStyle,
    style: gutterStyle,
    entryId: entry.id,
    startsEntry: true,
  })
  for (const line of wrapText(spreadCjkLatin(entry.text ?? ''), proseWidth(width - 2))) {
    rows.push({ text: `  ${line}`, gutterStyle, style: bodyStyle, entryId: entry.id })
  }
  void palette
  return rows
}

/**
 * An assistant entry: reasoning (when shown), prose, and code blocks.
 * @param entry - The entry.
 * @param width - Body width.
 * @param palette - The palette.
 * @param theme - Layout options.
 * @param expanded - Entries expanded beyond the default.
 * @returns The rows.
 */
function assistantRows(
  entry: Entry,
  width: number,
  palette: ResolvedPalette,
  theme: TranscriptTheme,
  expanded: ReadonlySet<number>,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  const duration = entry.endedAt === undefined ? undefined : entry.endedAt - entry.time
  const trailer = entry.streaming === true
    ? ' …'
    : duration === undefined ? '' : ` · ${formatDuration(duration)}`
  rows.push({
    text: `| ${entry.title ?? 'Agent'}${trailer}`,
    gutterStyle: palette.assistantLabel,
    style: palette.assistantLabel,
    entryId: entry.id,
    startsEntry: true,
  })
  const pieces = entry.pieces ?? piecesFromEntry(entry)
  for (const piece of pieces) {
    if (piece.kind === 'reasoning') {
      if (!theme.showReasoning) continue
      const inner = width - 4
      for (const line of wrapText(spreadCjkLatin(piece.text), proseWidth(inner))) {
        rows.push({ text: `  · ${line}`, gutterStyle: palette.reasoning, style: palette.reasoning, entryId: entry.id })
      }
      continue
    }
    if (piece.kind === 'code') {
      const inner = width - 5
      const label = piece.language === undefined ? ' code ' : ` ${piece.language} `
      rows.push({
        text: `  ┌${label}${'─'.repeat(Math.max(0, inner - textWidth(label)))}┐`,
        gutterStyle: palette.code,
        style: palette.diffMeta,
        entryId: entry.id,
      })
      for (const line of piece.text.replace(/\n$/u, '').split('\n')) {
        for (const wrapped of wrapText(line, inner)) {
          rows.push({ text: `  │ ${wrapped}`, gutterStyle: palette.code, style: palette.code, entryId: entry.id })
        }
      }
      rows.push({
        text: `  └${'─'.repeat(inner)}┘`,
        gutterStyle: palette.code,
        style: palette.diffMeta,
        entryId: entry.id,
      })
      continue
    }
    for (const line of wrapText(spreadCjkLatin(piece.text), proseWidth(width - 2))) {
      rows.push({ text: `  ${line}`, gutterStyle: palette.assistantLabel, style: palette.bodyText, entryId: entry.id })
    }
  }
  void expanded
  return rows
}

/**
 * A tool card.
 *
 * Collapsed, it is one line: the tool name, its first argument, and the outcome.
 * Expanded, it gains a framed body with the arguments and the result — or a diff,
 * when the tool produced one, because a file edit is the one tool result that is
 * genuinely unreadable as prose.
 * @param entry - The entry.
 * @param width - Body width.
 * @param palette - The palette.
 * @param theme - Layout options.
 * @param expanded - Entries expanded beyond the default.
 * @returns The rows.
 */
function toolRows(
  entry: Entry,
  width: number,
  palette: ResolvedPalette,
  theme: TranscriptTheme,
  expanded: ReadonlySet<number>,
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  // The theme sets the default; an explicit toggle inverts it for that entry.
  const toggled = expanded.has(entry.id)
  const open = toggled ? true : !theme.collapsed
  const state = entry.state ?? 'running'
  const stateStyle = state === 'error'
    ? palette.toolError
    : state === 'ok' ? palette.toolSuccess : palette.toolRunning
  const stateLabel = state === 'error' ? 'failed' : state === 'ok' ? 'ok' : 'running'
  const elapsed = entry.endedAt === undefined ? '' : ` · ${formatDuration(entry.endedAt - entry.time)}`
  const summary = summarizeArgs(entry.args)
  const heading = `~ ${entry.title ?? 'tool'}`
  const room = Math.max(0, width - textWidth(heading) - textWidth(stateLabel) - 6)
  const shownSummary = takeColumns(summary, room)
  rows.push({
    text: `${heading}  ${shownSummary}`.trimEnd(),
    gutterStyle: palette.toolHeader,
    style: palette.toolHeader,
    entryId: entry.id,
    startsEntry: true,
  })
  rows.push({
    text: `  ${stateLabel}${elapsed} ${open ? '▾' : '▸'}`,
    gutterStyle: stateStyle,
    style: stateStyle,
    entryId: entry.id,
  })
  if (!open) return rows
  const inner = Math.max(4, width - 4)
  const frame = (label: string): void => {
    rows.push({
      text: `  ┌${label}${'─'.repeat(Math.max(0, inner - textWidth(label)))}┐`,
      gutterStyle: palette.toolBody,
      style: palette.diffMeta,
      entryId: entry.id,
    })
  }
  const close = (): void => {
    rows.push({
      text: `  └${'─'.repeat(inner)}┘`,
      gutterStyle: palette.toolBody,
      style: palette.diffMeta,
      entryId: entry.id,
    })
  }
  if (entry.args !== undefined && entry.args !== '') {
    frame(' args ')
    for (const line of wrapText(prettyJson(entry.args), inner - 2)) {
      rows.push({ text: `  │ ${line}`, gutterStyle: palette.toolBody, style: palette.toolBody, entryId: entry.id })
    }
    close()
  }
  if (entry.diff !== undefined && entry.diff.length > 0) {
    frame(' diff ')
    for (const line of entry.diff) {
      const style = line.startsWith('+') && !line.startsWith('+++')
        ? palette.diffAdded
        : line.startsWith('-') && !line.startsWith('---')
          ? palette.diffRemoved
          : palette.diffMeta
      for (const wrapped of wrapText(line, inner - 2)) {
        rows.push({ text: `  │ ${wrapped}`, gutterStyle: style, style, entryId: entry.id })
      }
    }
    close()
  }
  if (entry.result !== undefined && entry.result !== '') {
    const lines = entry.lines ?? entry.result.split('\n')
    frame(` output (${lines.length} lines) `)
    for (const line of lines) {
      for (const wrapped of wrapText(line, inner - 2)) {
        rows.push({
          text: `  │ ${wrapped}`,
          gutterStyle: palette.toolBody,
          style: state === 'error' ? palette.toolError : palette.toolBody,
          entryId: entry.id,
        })
      }
    }
    close()
  }
  return rows
}

/**
 * Reconstruct pieces for an entry that was settled without them.
 * @param entry - The entry.
 * @returns Pieces in order.
 */
function piecesFromEntry(entry: Entry): ContentPiece[] {
  const pieces: ContentPiece[] = []
  if (entry.reasoning !== undefined && entry.reasoning !== '') {
    pieces.push({ kind: 'reasoning', text: entry.reasoning })
  }
  if (entry.text !== undefined && entry.text !== '') pieces.push({ kind: 'text', text: entry.text })
  return pieces
}

/**
 * A one-line description of a tool call's arguments.
 *
 * A coding agent's calls are overwhelmingly shaped `{command}`, `{path}`,
 * `{query}`, or `{pattern}`, so looking for those first produces a useful
 * summary almost always; the full JSON is one expansion away.
 * @param args - The raw argument JSON, or undefined.
 * @returns A short label.
 */
export function summarizeArgs(args: string | undefined): string {
  if (args === undefined || args === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(args)
  } catch {
    /* c8 ignore next -- a non-JSON argument string is shown as-is. */
    return takeColumns(args.replace(/\s+/gu, ' '), 60)
  }
  if (parsed === null || typeof parsed !== 'object') return takeColumns(String(parsed), 60)
  const record = parsed as Record<string, unknown>
  for (const key of ['command', 'path', 'file_path', 'query', 'pattern', 'url', 'prompt', 'name']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return takeColumns(value.replace(/\s+/gu, ' '), 60)
  }
  const keys = Object.keys(record)
  if (keys.length === 0) return ''
  return takeColumns(keys.join(', '), 60)
}

/**
 * Pretty-print a JSON argument string for the expanded card.
 * @param args - The raw JSON.
 * @returns Indented JSON, or the input unchanged when it does not parse.
 */
export function prettyJson(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    /* c8 ignore next -- unparseable arguments are shown verbatim. */
    return args
  }
}

/**
 * Punctuation that must not begin a line (kinsoku shori, 禁则处理).
 *
 * Chinese typesetting treats these as bound to the text before them; a line
 * starting with a comma or a full stop reads as broken to anyone who reads
 * Chinese fluently, and CJK prose is most of what a DeepSeek transcript holds.
 */
const NO_LINE_START = new Set([...'，。、！？；：）］」』》〉·…—～％』'])

/** Brackets that must not be stranded at the end of a line. */
const NO_LINE_END = new Set([...'（［「『《〈‘“'])

/**
 * Cut `rest` to `width` columns without violating the kinsoku rules.
 *
 * A cut that would leave closing punctuation at the start of the next line, or
 * an opening bracket at the end of this one, is pulled back by whole glyphs —
 * the punctuation travels with its neighbour and the line simply ends a column
 * or two early. Width is never exceeded, so the frame cannot overflow.
 * @param rest - The text to cut.
 * @param width - The column budget.
 * @returns The longest prefix that may end a line.
 */
function cutRespectingKinsoku(rest: string, width: number): string {
  let head = takeColumns(rest, width)
  // Bounded by the head's glyph count: each pull shortens it by at least one
  // glyph, and at `''` there is nothing left to move.
  for (;;) {
    const nextStart = [...rest.slice(head.length)][0]
    if (nextStart !== undefined && NO_LINE_START.has(nextStart)) {
      head = dropLastGlyph(head)
      if (head === '') return takeColumns(rest, width)
      continue
    }
    const last = head.at(-1)
    if (last !== undefined && NO_LINE_END.has(last)) {
      head = dropLastGlyph(head)
      if (head === '') return takeColumns(rest, width)
      continue
    }
    return head
  }
}

/** The string minus its final glyph, by columns. */
function dropLastGlyph(text: string): string {
  if (text === '') return text
  const width = textWidth(text)
  const last = textWidth(text.at(-1) ?? '')
  return takeColumns(text, Math.max(0, width - Math.max(1, last)))
}

/**
 * Wrap text to a column budget, honouring explicit newlines and never splitting
 * a wide glyph.
 * @param text - The text.
 * @param width - The column budget; must be positive.
 * @returns The wrapped lines; always at least one.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/(\s+)/u)) {
      if (word === '') continue
      const wordWidth = textWidth(word)
      if (line !== '' && textWidth(line) + wordWidth > width) {
        // Drop the space that caused the break: it would otherwise be a visible
        // trailing blank on the wrapped line.
        out.push(line.replace(/\s+$/u, ''))
        line = ''
        if (/^\s+$/u.test(word)) continue
      }
      // A single word longer than the line has to be cut, or it would overflow
      // the window and corrupt the frame. This is also the path Chinese prose
      // takes: a run of CJK has no spaces, so a paragraph arrives as one word
      // and is cut at fixed columns — which, unchecked, leaves closing
      // punctuation at the start of the next line.
      if (wordWidth > width && line === '') {
        let rest = word
        while (textWidth(rest) > width) {
          out.push(cutRespectingKinsoku(rest, width))
          rest = rest.slice(out[out.length - 1]?.length ?? 0)
        }
        line = rest
        continue
      }
      line += word
    }
    out.push(line)
  }
  return out.length === 0 ? [''] : out
}
