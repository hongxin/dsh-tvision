/**
 * The composer: the one-line input window at the bottom of the desktop.
 *
 * Deliberately *one line*, like a shell prompt or an mc command line, rather
 * than the growing multi-line box every chat interface uses. A window that
 * changes height as you type pushes the transcript around; a fixed single line
 * keeps the desktop still. Multi-line input is still available — pasted text and
 * explicit newlines keep their breaks and the composer scrolls horizontally
 * within its line — so nothing is lost but the layout churn.
 *
 * The `dsh>` sigil is the one place the application names itself, and it doubles
 * as the running indicator: while a turn is in flight the sigil is replaced in
 * place by the elapsed time, so the user can see that the agent is working
 * without the cursor moving.
 * @module @dsh-tvision/dsh-tvision/app/composer
 */

import type { Style } from '../kit/cell.ts'
import type { Painter } from '../kit/painter.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import { charWidth, takeColumns, takeColumnsEnd, textWidth } from '../kit/text.ts'

/** A completion the composer can cycle through with Tab. */
export interface Completion {
  /** The text to insert. */
  readonly insert: string
  /** What the completion list shows. */
  readonly label: string
  /** A one-line explanation. */
  readonly detail?: string
}

/** Supplies completions for the token under the cursor. */
export type CompletionSource = (input: string, cursor: number) => readonly Completion[]

/** Everything the composer needs from its host. */
export interface ComposerOptions {
  /** Called with the submitted text, which is never empty and never blank. */
  submit(text: string): void
  /** Called after every edit, e.g. to refresh a completion popup. */
  changed?(text: string): void
  /** History for Up/Down; newest last. */
  history?(): readonly string[]
  /** Completions for Tab. */
  complete?: CompletionSource
  /** The sigil in front of the text. */
  prompt?: () => string
  /** Placeholder shown when the composer is empty. */
  placeholder?: string
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

/**
 * The input line.
 *
 * Holds a text buffer, a cursor, a history walk, and a completion cycle. It is
 * intentionally not a general text editor: there is no selection, no kill ring,
 * and no undo, because an agent prompt is one thought long and the transcript is
 * where the reading happens.
 */
export class Composer implements Widget {
  private text = ''
  private cursor = 0
  /** Horizontal scroll, in columns, when the text is wider than the window. */
  private scroll = 0
  private historyIndex = -1
  private historyDraft = ''
  private completions: readonly Completion[] = []
  private completionIndex = -1
  private completionStart = 0
  private readonly options: ComposerOptions
  private theme: ComposerTheme
  /** Rows the completion popup needs above the input line. */
  private popupRows = 0

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
    return this.cursor
  }

  /** How many rows the completion popup wants above the input. */
  get completionRows(): number {
    return this.popupRows
  }

  /** Replace the buffer, as a slash command or a resume does. */
  setValue(text: string, cursor = text.length): void {
    this.text = text
    this.cursor = Math.max(0, Math.min(text.length, cursor))
    this.dismissCompletions()
    this.options.changed?.(this.text)
  }

  /** Empty the buffer and reset the history walk. */
  clear(): void {
    this.text = ''
    this.cursor = 0
    this.scroll = 0
    this.historyIndex = -1
    this.dismissCompletions()
    this.options.changed?.('')
  }

  /**
   * Insert text at the caret, as a paste or a completion does.
   * @param text - The text to insert.
   */
  insert(text: string): void {
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor)
    this.cursor += text.length
    this.options.changed?.(this.text)
  }

  /**
   * Paint the input line and the completion popup.
   * @param painter - The window interior.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    const theme: ComposerTheme = {
      body: palette.inputBody,
      prompt: palette.inputPrompt,
      hint: palette.inputHint,
      completion: palette.listNormal,
      completionSelected: palette.listFocused,
    }
    this.theme = theme
    const sigil = this.options.prompt?.() ?? 'dsh> '
    // The popup occupies the top rows; the input line is always the last one.
    const inputRow = painter.height - 1
    if (inputRow < 0) return
    const popupRows = Math.min(this.popupRows, Math.max(0, painter.height - 1))
    if (popupRows > 0) this.drawCompletions(painter, context, popupRows)
    for (let row = 0; row < inputRow; row++) {
      if (row >= popupRows) painter.fillRow(row, theme.body)
    }
    painter.text(0, inputRow, sigil, textWidth(sigil), theme.prompt)
    const room = Math.max(0, painter.width - textWidth(sigil))
    if (this.text === '') {
      if (!context.focused) return
      const hint = this.options.placeholder ?? ''
      painter.text(textWidth(sigil), inputRow, takeColumns(hint, room), room, theme.hint)
      return
    }
    // Keep the caret in view by scrolling the window over the text rather than
    // the text over the window.
    const caretColumn = textWidth(this.text.slice(0, this.cursor))
    if (caretColumn - this.scroll >= room) this.scroll = caretColumn - room + 1
    if (caretColumn < this.scroll) this.scroll = caretColumn
    const visibleStart = this.indexOfColumn(this.scroll)
    const visible = takeColumns(this.text.slice(visibleStart), room)
    painter.text(textWidth(sigil), inputRow, visible, room, theme.body)
  }

  /**
   * Paint the completion popup.
   * @param painter - The window interior.
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
    void painter
  }

  /**
   * Translate a column offset into a string index, so horizontal scrolling
   * never lands inside a wide glyph.
   * @param column - The column offset.
   * @returns The string index at or before that column.
   */
  private indexOfColumn(column: number): number {
    let used = 0
    let index = 0
    for (const char of this.text) {
      if (used >= column) return index
      used += charWidth(char)
      index += char.length
    }
    return this.text.length
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
        // An explicit newline, for a prompt that needs one.
        this.insert('\n')
        return Consumed.Yes
      }
      this.submit()
      return Consumed.Yes
    }
    if (ctrl || alt) {
      switch (plain) {
        case 'a':
          this.cursor = 0
          return Consumed.Yes
        case 'e':
          this.cursor = this.text.length
          return Consumed.Yes
        case 'u':
          this.text = this.text.slice(this.cursor)
          this.cursor = 0
          this.options.changed?.(this.text)
          return Consumed.Yes
        case 'k':
          this.text = this.text.slice(0, this.cursor)
          this.options.changed?.(this.text)
          return Consumed.Yes
        case 'w': {
          // Delete the whitespace and the word before the caret, which is what
          // every readline does and what makes the next word you type land
          // where the deleted one was.
          const before = this.text.slice(0, this.cursor)
          const cut = before.replace(/\s*\S*$/u, '')
          this.text = cut + this.text.slice(this.cursor)
          this.cursor = cut.length
          this.options.changed?.(this.text)
          return Consumed.Yes
        }
        default:
          return Consumed.No
      }
    }
    switch (plain) {
      case 'backspace':
        if (this.cursor > 0) {
          this.text = this.text.slice(0, this.cursor - 1) + this.text.slice(this.cursor)
          this.cursor--
          this.options.changed?.(this.text)
        }
        return Consumed.Yes
      case 'delete':
        if (this.cursor < this.text.length) {
          this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + 1)
          this.options.changed?.(this.text)
        }
        return Consumed.Yes
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1)
        return Consumed.Yes
      case 'right':
        this.cursor = Math.min(this.text.length, this.cursor + 1)
        return Consumed.Yes
      case 'home':
        this.cursor = 0
        return Consumed.Yes
      case 'end':
        this.cursor = this.text.length
        return Consumed.Yes
      case 'tab':
        this.refreshCompletions()
        if (this.completions.length > 0) {
          this.acceptCompletion()
          return Consumed.Yes
        }
        return Consumed.No
      case 'up':
        this.walkHistory(1)
        return Consumed.Yes
      case 'down':
        this.walkHistory(-1)
        return Consumed.Yes
      case 'paste':
        // A paste arrives as one event; its newlines are kept so a pasted block
        // stays a block, normalised so a terminal's CRLF does not become a
        // stray carriage return in the buffer.
        if (event.text !== undefined) {
          this.insert(event.text.replace(/\r\n?/gu, '\n'))
          return Consumed.Yes
        }
        return Consumed.No
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
   * Handle a click, which places the caret at the clicked column.
   * @param event - The mouse event, in the widget's own coordinate space.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent): Consumed {
    if (event.kind !== 'press' || event.button !== 'left') return Consumed.No
    const sigilWidth = textWidth(this.options.prompt?.() ?? 'dsh> ')
    const column = Math.max(0, event.x - sigilWidth)
    const target = this.indexOfColumn(column + this.scroll)
    // Snap the caret to the nearest character boundary rather than a code unit.
    this.cursor = Math.min(this.text.length, target)
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
    this.cursor = entry.length
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
    // and `@src/a` complete as units.
    const before = this.text.slice(0, this.cursor)
    const start = Math.max(0, before.search(/\S*$/u) < 0 ? 0 : before.length - (before.match(/\S*$/u)?.[0].length ?? 0))
    const matches = source(before.slice(start), this.cursor)
    this.completions = matches
    this.completionStart = start
    this.completionIndex = matches.length > 0 ? 0 : -1
    this.popupRows = Math.min(matches.length, 8)
  }

  /** Replace the current token with the highlighted completion. */
  private acceptCompletion(): void {
    const completion = this.completions[this.completionIndex]
    if (completion === undefined) return
    const rest = this.text.slice(this.cursor)
    this.text = this.text.slice(0, this.completionStart) + completion.insert + rest
    this.cursor = this.completionStart + completion.insert.length
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
   * @returns The last line of the buffer.
   */
  visibleLine(): string {
    return takeColumnsEnd(this.text.split('\n').at(-1) ?? '', 200)
  }
}
