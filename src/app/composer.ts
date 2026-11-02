/**
 * The composer: the growing multi-line input at the bottom of the desktop.
 *
 * It edits the way Claude Code's box does, because that is the interaction
 * people now know: a buffer that holds explicit newlines, soft-wrapped at the
 * window edge, with Enter submitting and `\`+Enter (or Alt+Enter, or a paste)
 * breaking the line. The area grows with the content up to a share of the pane
 * and then scrolls inside itself, so a long draft never shoves the transcript
 * off the screen — the pane enforces that floor, not the composer.
 *
 * Key semantics follow readline where readline has an opinion, which makes
 * them *line*-wise rather than buffer-wise: Home/End, Ctrl+A/E, and the
 * Ctrl+U/Ctrl+K kills all act on the logical line the caret is on. On a
 * single-line buffer every one of those coincides with the old whole-buffer
 * behaviour, so nothing anyone already types changes. Up/Down are the one
 * context-dependent pair: they move between display rows while the buffer
 * spans more than one, and walk the history while it does not — the history is
 * still exactly one Up away in the common case.
 *
 * The `dsh>` sigil is the one place the application names itself, and it
 * doubles as the running indicator: while a turn is in flight the sigil is
 * replaced in place by the elapsed time. Continuation rows are indented to the
 * sigil's width so every text column lines up under the first.
 * @module dsh-tvision/app/composer
 */

import type { Style } from '../kit/cell.ts'
import type { Painter } from '../kit/painter.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import { nextClusterEnd, prevClusterStart, splitUnits, takeColumns, takeColumnsEnd, textWidth } from '../kit/text.ts'

/** A completion the composer can cycle through with Tab. */
export interface Completion {
  /** The text to insert. */
  readonly insert: string
  /** What the completion list shows. */
  readonly label: string
  /** A one-line explanation. */
  readonly detail?: string
}

/**
 * Supplies completions for the token under the cursor.
 *
 * The cursor is passed because a source may want it — an `@` reference in the
 * middle of a sentence needs to know where the token ends — even though the
 * command and file sources here do not.
 */
export type CompletionSource = (token: string, cursor: number) => readonly Completion[]

/** Everything the composer needs from its host. */
export interface ComposerOptions {
  /** Called with the submitted text, which is never empty and never blank. */
  submit(text: string): void
  /** Called after every edit, e.g. to refresh a completion popup. */
  changed?(text: string): void
  /** History for Up/Down while the buffer is one display row; newest last. */
  history?(): readonly string[]
  /** Completions for Tab. */
  complete?: CompletionSource
  /** The sigil in front of the text. */
  prompt?: () => string
  /** Placeholder shown when the composer is empty; read per paint. */
  placeholder?: () => string
}

/** How the composer is drawn. */
export interface ComposerTheme {
  readonly body: Style
  readonly prompt: Style
  readonly hint: Style
  readonly completion: Style
  readonly completionSelected: Style
}

/**
 * Drop the `ctrl+`/`alt+`/`shift+` prefixes from a key name.
 * @param key - The normalised key name.
 * @returns The bare key.
 */
export function stripModifiers(key: string): string {
  return key.replace(/^(ctrl|alt|shift|super)\+/u, '')
}

/** One soft-wrapped display row: where it starts and what it shows. */
interface DisplayRow {
  /** Buffer index of the row's first displayable character. */
  readonly start: number
  /** The displayable characters, newlines excluded. */
  readonly text: string
  /** The row's width in columns. */
  readonly width: number
  /** Buffer index just past the last displayable character. */
  readonly end: number
  /** True when a newline terminated the logical line here. */
  readonly newline: boolean
}

/**
 * The input box.
 *
 * Holds a text buffer with embedded newlines, a caret, a history walk, and a
 * completion cycle. It is intentionally not a general text editor: there is no
 * selection, no kill ring, and no undo, because an agent prompt is one thought
 * long and the transcript is where the reading happens.
 */
export class Composer implements Widget {
  private text = ''
  private caretIndex = 0
  /** First display row shown, when the content outgrows the area. */
  private topRow = 0
  private historyIndex = -1
  private historyDraft = ''
  private completions: readonly Completion[] = []
  private completionIndex = -1
  private completionStart = 0
  private readonly options: ComposerOptions
  private theme: ComposerTheme
  /** Rows the completion popup needs above the input block. */
  private popupRows = 0
  /** The layout the last draw computed, and the inputs that produced it. */
  private lastRows: readonly DisplayRow[] = [{ start: 0, text: '', width: 0, end: 0, newline: false }]
  private lastLayoutWidth = -1
  /** The caret's position within the composer's own area, valid after a draw. */
  private lastCaretOffset = { x: 0, y: 0 }

  /**
   * @param options - Host callbacks.
   * @param theme - Styles.
   */
  constructor(options: ComposerOptions, theme: ComposerTheme) {
    this.options = options
    this.theme = theme
  }

  /** The current buffer. */
  get value(): string {
    return this.text
  }

  /** The caret position, in code units. */
  get caret(): number {
    return this.caretIndex
  }

  /**
   * The display rows the buffer occupies at a width.
   *
   * Pure — the pane calls it to size the composer's area *before* the composer
   * draws into it, so both must agree from the same inputs.
   * @param width - The area's width in columns.
   * @returns One row per soft-wrapped display line, at least one.
   */
  contentRows(width: number): number {
    return this.layout(width).length
  }

  /**
   * How many display rows the buffer spans, and whether Up/Down therefore
   * navigate the text rather than the history.
   * @param width - The area's width in columns.
   * @returns True when the buffer occupies more than one display row.
   */
  private spansRows(width: number): boolean {
    return this.contentRows(width) > 1
  }

  /**
   * The caret's position within the composer's own area.
   *
   * Valid after a draw — the pane adds its own origin to place the hardware
   * cursor, which blinks natively, so the composer paints no caret of its own.
   * @returns The column and row within the composer area.
   */
  caretOffset(): { x: number; y: number } {
    return this.lastCaretOffset
  }

  /** How many rows the completion popup wants above the input block. */
  get completionRows(): number {
    return this.popupRows
  }

  /** Replace the buffer, as a slash command or a resume does. */
  setValue(text: string, cursor = text.length): void {
    this.text = text
    this.caretIndex = Math.max(0, Math.min(text.length, cursor))
    this.topRow = 0
    this.dismissCompletions()
    this.options.changed?.(this.text)
  }

  /** Empty the buffer and reset the history walk. */
  clear(): void {
    this.text = ''
    this.caretIndex = 0
    this.topRow = 0
    this.historyIndex = -1
    this.dismissCompletions()
    this.options.changed?.('')
  }

  /**
   * Insert text at the caret, as a paste or a completion does.
   * @param text - The text to insert.
   */
  insert(text: string): void {
    this.text = this.text.slice(0, this.caretIndex) + text + this.text.slice(this.caretIndex)
    this.caretIndex += text.length
    this.options.changed?.(this.text)
  }

  /**
   * Paint the completion popup above, the input block below.
   * @param painter - The composer's area.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    this.theme = {
      body: palette.inputBody,
      prompt: palette.inputPrompt,
      hint: palette.inputHint,
      completion: palette.listNormal,
      completionSelected: palette.listFocused,
    }
    if (painter.height <= 0 || painter.width <= 0) return
    const sigil = this.options.prompt?.() ?? 'dsh> '
    const rows = this.layout(painter.width)
    // The popup occupies the top rows; the input block takes the rest.
    const popupRows = Math.min(this.popupRows, Math.max(0, painter.height - 1))
    if (popupRows > 0) this.drawCompletions(painter, context, popupRows)
    const areaTop = popupRows
    const areaHeight = painter.height - popupRows
    // Keep the caret's display row inside the window, moving the window as
    // little as the adjustment allows.
    const caretRow = this.caretRowColumn(rows).row
    if (caretRow < this.topRow) this.topRow = caretRow
    if (caretRow >= this.topRow + areaHeight) this.topRow = caretRow - areaHeight + 1
    this.topRow = Math.max(0, Math.min(this.topRow, rows.length - areaHeight))
    for (let row = 0; row < areaHeight; row++) painter.fillRow(areaTop + row, this.theme.body)
    const indent = textWidth(sigil)
    for (let row = 0; row < areaHeight; row++) {
      const display = rows[this.topRow + row]
      if (display === undefined) break
      painter.text(indent, areaTop + row, display.text, Math.max(0, painter.width - indent), this.theme.body)
    }
    // The sigil marks row 0 — and only row 0, because a continuation row is
    // the same prompt, continued. When the block is scrolled, the sigil's
    // place shows how much text is above instead.
    if (this.text === '') {
      if (context.focused && this.topRow === 0) {
        const hint = this.options.placeholder?.() ?? ''
        const room = Math.max(0, painter.width - indent)
        painter.text(indent, areaTop, takeColumns(hint, room), room, this.theme.hint)
      }
      painter.text(0, areaTop, sigil, indent, this.theme.prompt)
    } else if (this.topRow === 0) {
      painter.text(0, areaTop, sigil, indent, this.theme.prompt)
    } else {
      const label = `↑${this.topRow}`
      painter.text(0, areaTop, label, indent, this.theme.hint)
    }
    const below = rows.length - (this.topRow + areaHeight)
    if (below > 0) {
      const label = `↓${below} ↵`
      painter.text(Math.max(0, painter.width - textWidth(label) - 1), painter.height - 1,
        label, textWidth(label), this.theme.hint)
    }
    const position = this.caretRowColumn(rows)
    this.lastCaretOffset = {
      x: Math.min(indent + position.column, Math.max(0, painter.width - 1)),
      y: areaTop + (position.row - this.topRow),
    }
  }

  /**
   * Paint the completion popup.
   * @param painter - The composer's area.
   * @param context - Palette and focus.
   * @param rows - How many rows are available for the popup.
   */
  private drawCompletions(painter: Painter, context: WidgetContext, rows: number): void {
    const shown = this.completions.slice(0, rows)
    for (let index = 0; index < rows; index++) {
      const completion = shown[index]
      if (completion === undefined) {
        painter.fillRow(index, context.palette.inputBody)
        continue
      }
      const selected = index === this.completionIndex
      const style = selected ? this.theme.completionSelected : this.theme.completion
      const marker = selected ? '▸ ' : '  '
      const detail = completion.detail === undefined ? '' : `  ${completion.detail}`
      const label = `${marker}${completion.label}`
      painter.text(0, index, label, painter.width, style)
      if (detail !== '') {
        const room = Math.max(0, painter.width - textWidth(label))
        painter.text(textWidth(label), index, takeColumns(detail, room), room, style)
      }
    }
  }

  /**
   * Lay the buffer out as soft-wrapped display rows.
   *
   * Wrapping is by grapheme cluster at the exact column — the wrap a terminal
   * itself would do — which keeps the caret and mouse mapping exact and never
   * splits a wide glyph. Memoised on the buffer and width, because the pane
   * sizes the area from the same layout the draw then renders.
   * @param width - The area's width in columns.
   * @returns The display rows, at least one.
   */
  private layout(width: number): readonly DisplayRow[] {
    const budget = Math.max(1, width - textWidth(this.options.prompt?.() ?? 'dsh> '))
    if (this.text === '') {
      return [{ start: 0, text: '', width: 0, end: 0, newline: false }]
    }
    if (this.lastLayoutWidth === width && this.lastRowsKey === this.text) return this.lastRows
    const rows: DisplayRow[] = []
    let start = 0
    let rowText = ''
    let rowWidth = 0
    for (const unit of splitUnits(this.text)) {
      if (unit.text === '\n') {
        rows.push({ start, text: rowText, width: rowWidth, end: start + rowText.length, newline: true })
        start = start + rowText.length + 1
        rowText = ''
        rowWidth = 0
        continue
      }
      if (rowWidth + unit.width > budget) {
        rows.push({ start, text: rowText, width: rowWidth, end: start + rowText.length, newline: false })
        start = start + rowText.length
        rowText = unit.text
        rowWidth = unit.width
        continue
      }
      rowText += unit.text
      rowWidth += unit.width
    }
    rows.push({ start, text: rowText, width: rowWidth, end: start + rowText.length, newline: false })
    this.lastRows = rows
    this.lastLayoutWidth = width
    this.lastRowsKey = this.text
    return rows
  }

  /** The memo key for the layout: the buffer itself. */
  private lastRowsKey = ''

  /**
   * Which display row and column the caret sits at.
   * @param rows - The layout the caret is mapped against.
   * @returns The zero-based row and the column within it.
   */
  private caretRowColumn(rows: readonly DisplayRow[]): { row: number; column: number } {
    let index = 0
    for (const row of rows) {
      // A row owns [start, end], plus the newline that terminated it when there
      // is one: a caret at the line break belongs to the end of this line, not
      // the start of the next.
      const span = row.end + (row.newline ? 1 : 0)
      if (this.caretIndex <= span) {
        return { row: index, column: textWidth(row.text.slice(0, this.caretIndex - row.start)) }
      }
      index++
    }
    const last = rows[rows.length - 1]
    /* c8 ignore next -- the loop returns unless rows is empty, which layout forbids. */
    return { row: Math.max(0, rows.length - 1), column: last?.width ?? 0 }
  }

  /**
   * The buffer index at a column within a display row.
   * @param row - The display row.
   * @param column - The column within the row's text.
   * @returns The buffer index, clamped to the row's end.
   */
  private indexAtColumn(row: DisplayRow, column: number): number {
    let used = 0
    let index = row.start
    for (const unit of splitUnits(row.text)) {
      if (used + unit.width > column) return index
      used += unit.width
      index += unit.text.length
    }
    return row.end
  }

  /**
   * Handle a key press.
   * @param event - The key event.
   * @returns Whether the key was consumed.
   */
  onKey(event: KeyEvent): Consumed {
    // The decoder reports a modifier both as a bit and as a name prefix; the
    // name is the authority, because a caller may construct either form.
    const ctrl = event.ctrl === true || event.key.startsWith('ctrl+')
    const alt = event.alt === true || event.key.startsWith('alt+')
    const plain = stripModifiers(event.key)
    // The completion popup, while open, owns Up/Down/Tab/Escape.
    if (this.completions.length > 0) {
      if (plain === 'down') {
        this.completionIndex = (this.completionIndex + 1) % this.completions.length
        return Consumed.Yes
      }
      if (plain === 'up') {
        this.completionIndex = (this.completionIndex - 1 + this.completions.length) % this.completions.length
        return Consumed.Yes
      }
      if (plain === 'tab') {
        this.acceptCompletion()
        return Consumed.Yes
      }
      if (plain === 'escape') {
        this.dismissCompletions()
        return Consumed.Yes
      }
    }
    if (event.key === 'paste') {
      // The decoder delivers a paste as one event whose `text` is the payload;
      // normalising CRLF here keeps a pasted block from carrying stray returns.
      if (event.text !== undefined) {
        this.insert(event.text.replace(/\r\n?/gu, '\n'))
        return Consumed.Yes
      }
      return Consumed.No
    }
    if (plain === 'enter') {
      if (alt || event.shift === true) {
        this.insert('\n')
        return Consumed.Yes
      }
      // A backslash immediately before the caret is the shell's line
      // continuation, and Claude Code's newline: it becomes a break rather
      // than a character the model has to read through.
      if (this.caretIndex > 0 && this.text[this.caretIndex - 1] === '\\') {
        this.text = `${this.text.slice(0, this.caretIndex - 1)}\n${this.text.slice(this.caretIndex)}`
        this.options.changed?.(this.text)
        return Consumed.Yes
      }
      this.submit()
      return Consumed.Yes
    }
    if (ctrl || alt) {
      switch (plain) {
        // Readline's Ctrl+A/E are line-wise, and a line is what they stay:
        // on a single-line buffer these coincide with the buffer bounds, so
        // the behaviour nobody thinks about is unchanged.
        case 'a':
          this.caretIndex = this.lineBounds().start
          return Consumed.Yes
        case 'e':
          this.caretIndex = this.lineBounds().end
          return Consumed.Yes
        case 'u': {
          const { start } = this.lineBounds()
          this.text = this.text.slice(0, start) + this.text.slice(this.caretIndex)
          this.caretIndex = start
          this.options.changed?.(this.text)
          return Consumed.Yes
        }
        case 'k': {
          const { end } = this.lineBounds()
          this.text = this.text.slice(0, this.caretIndex) + this.text.slice(end)
          this.options.changed?.(this.text)
          return Consumed.Yes
        }
        case 'w': {
          // Delete the horizontal whitespace and the word before the caret —
          // what every readline does — stopping at the line break: a newline is
          // a structure the writer put there, not whitespace around a word.
          const before = this.text.slice(0, this.caretIndex)
          const cut = before.replace(/[^\S\n]*[^\n\S]*\S*$/u, '').replace(/[^\S\n]+$/u, '')
          this.text = cut + this.text.slice(this.caretIndex)
          this.caretIndex = cut.length
          this.options.changed?.(this.text)
          return Consumed.Yes
        }
        default:
          return Consumed.No
      }
    }
    switch (plain) {
      case 'backspace':
        if (this.caretIndex > 0) {
          // By cluster, not code unit: deleting half a surrogate pair leaves a
          // lone surrogate that renders as U+FFFD and is submitted verbatim.
          const start = prevClusterStart(this.text, this.caretIndex)
          this.text = this.text.slice(0, start) + this.text.slice(this.caretIndex)
          this.caretIndex = start
          this.options.changed?.(this.text)
        }
        return Consumed.Yes
      case 'delete':
        if (this.caretIndex < this.text.length) {
          const end = nextClusterEnd(this.text, this.caretIndex)
          this.text = this.text.slice(0, this.caretIndex) + this.text.slice(end)
          this.options.changed?.(this.text)
        }
        return Consumed.Yes
      case 'left':
        this.caretIndex = prevClusterStart(this.text, this.caretIndex)
        return Consumed.Yes
      case 'right':
        this.caretIndex = nextClusterEnd(this.text, this.caretIndex)
        return Consumed.Yes
      case 'home':
        this.caretIndex = this.lineBounds().start
        return Consumed.Yes
      case 'end':
        this.caretIndex = this.lineBounds().end
        return Consumed.Yes
      case 'tab':
        this.refreshCompletions()
        if (this.completions.length > 0) {
          this.acceptCompletion()
          return Consumed.Yes
        }
        return Consumed.No
      case 'up':
      case 'down': {
        // One display row means there is nothing above or below to move to,
        // and the key falls through to the history — the behaviour of every
        // shell prompt, kept for the common case.
        const width = this.lastLayoutWidth
        if (width > 0 && this.spansRows(width)) {
          this.moveDisplayRow(plain === 'up' ? -1 : 1)
          return Consumed.Yes
        }
        this.walkHistory(plain === 'up' ? 1 : -1)
        return Consumed.Yes
      }
      default:
        break
    }
    if (event.text !== undefined && event.text !== '') {
      this.insert(event.text)
      return Consumed.Yes
    }
    return Consumed.No
  }

  /**
   * The bounds of the logical line the caret is on.
   * @returns The line's start and end indices, the newline excluded.
   */
  private lineBounds(): { start: number; end: number } {
    const start = this.text.lastIndexOf('\n', this.caretIndex - 1) + 1
    const nextBreak = this.text.indexOf('\n', this.caretIndex)
    return { start, end: nextBreak < 0 ? this.text.length : nextBreak }
  }

  /**
   * Move the caret one display row up or down, keeping its column.
   *
   * The target row takes the caret's column clamped to its own width, which is
   * the movement every editor makes and what lets a wrapped line be walked
   * with the arrow keys at all.
   * @param step - `-1` for the row above, `1` for the row below.
   */
  private moveDisplayRow(step: -1 | 1): void {
    const rows = this.layout(Math.max(1, this.lastLayoutWidth))
    const position = this.caretRowColumn(rows)
    const target = rows[position.row + step]
    if (target === undefined) return
    const column = Math.min(position.column, target.width)
    this.caretIndex = Math.max(target.start, Math.min(target.end, this.indexAtColumn(target, column)))
  }

  /**
   * Handle a click, which places the caret at the clicked cell.
   * @param event - The mouse event, in the widget's own coordinate space.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent): Consumed {
    if (event.kind !== 'press' || event.button !== 'left') return Consumed.No
    const width = Math.max(1, this.lastLayoutWidth)
    const rows = this.layout(width)
    const indent = textWidth(this.options.prompt?.() ?? 'dsh> ')
    // The click lands inside the input block, below any popup rows.
    const row = this.topRow + (event.y - this.popupRows)
    const target = rows[row]
    if (target === undefined) return Consumed.Yes
    const column = Math.max(0, event.x - indent)
    this.caretIndex = Math.max(target.start, Math.min(target.end, this.indexAtColumn(target, column)))
    return Consumed.Yes
  }

  /**
   * Submit the buffer if it holds something other than whitespace.
   * @returns True when a submission happened.
   */
  submit(): boolean {
    const text = this.text
    if (text.trim() === '') return false
    this.clear()
    this.options.submit(text)
    return true
  }

  /**
   * Walk the history, remembering the draft so Up then Down restores it.
   * @param step - `1` for older, `-1` for newer.
   */
  private walkHistory(step: 1 | -1): void {
    const history = this.options.history?.() ?? []
    if (history.length === 0) return
    if (this.historyIndex === -1) {
      if (step === -1) return
      this.historyDraft = this.text
      this.historyIndex = history.length - 1
    } else {
      // Walking older (`step` 1) decreases the index; walking newer increases
      // it, and going past the newest restores the draft that was being typed.
      const next = this.historyIndex - step
      if (next >= history.length) {
        this.historyIndex = -1
        this.setValue(this.historyDraft)
        return
      }
      if (next < 0) return
      this.historyIndex = next
    }
    const entry = history[this.historyIndex]
    /* c8 ignore next -- the index was clamped above. */
    if (entry === undefined) return
    this.text = entry
    this.caretIndex = entry.length
    this.options.changed?.(this.text)
  }

  /** Recompute the completion list for the token under the caret. */
  private refreshCompletions(): void {
    const source = this.options.complete
    if (source === undefined) {
      this.dismissCompletions()
      return
    }
    // The token runs back to the last whitespace, which is what makes `/mode`
    // and `@src/a` complete as units; a newline is whitespace, so a token
    // never spans a line break.
    const before = this.text.slice(0, this.caretIndex)
    const start = Math.max(0, before.search(/\S*$/u) < 0 ? 0 : before.length - (before.match(/\S*$/u)?.[0].length ?? 0))
    const matches = source(before.slice(start), this.caretIndex)
    this.completions = matches
    this.completionStart = start
    this.completionIndex = matches.length > 0 ? 0 : -1
    this.popupRows = Math.min(matches.length, 8)
  }

  /** Replace the current token with the highlighted completion. */
  private acceptCompletion(): void {
    const completion = this.completions[this.completionIndex]
    if (completion === undefined) return
    const rest = this.text.slice(this.caretIndex)
    this.text = this.text.slice(0, this.completionStart) + completion.insert + rest
    this.caretIndex = this.completionStart + completion.insert.length
    this.dismissCompletions()
    this.options.changed?.(this.text)
  }

  /** Hide the completion popup. */
  private dismissCompletions(): void {
    this.completions = []
    this.completionIndex = -1
    this.popupRows = 0
  }

  /**
   * Recompute completions for the token under the caret.
   *
   * Called after every edit, which is what makes the popup appear as soon as a
   * `/` or `@` is typed; the source decides whether there is anything to offer.
   */
  refresh(): void {
    this.refreshCompletions()
  }

  /**
   * The visible tail of the buffer, for the terminal title and for tests.
   * @returns The last logical line of the buffer.
   */
  visibleLine(): string {
    return takeColumnsEnd(this.text.split('\n').at(-1) ?? '', 200)
  }
}
