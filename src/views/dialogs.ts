/**
 * Modal dialogs: the approval prompt, the structured question, and the
 * confirmations the menus use.
 *
 * A dialog here is a *window*, not an overlay: it gets a title bar, a frame,
 * and a shadow like everything else, and it locks the desktop while it is up.
 * That is what makes an approval prompt feel like part of the application rather
 * than something painted on top of it — and it is why the buttons can be
 * reached with Tab, the arrows, a letter, or the mouse, all through the same
 * code path everything else uses.
 *
 * Two rules are enforced by construction:
 *
 * - **A dialog always resolves.** Dismissing with Escape, closing with the
 *   system box, or the signal aborting all settle the same promise exactly once,
 *   because a leaked promise is a wedged agent turn.
 * - **The default is the safe choice.** Where a decision has a dangerous and a
 *   safe answer, Enter picks the safe one; the mouse may pick either.
 * @module dsh-tvision/views/dialogs
 */

import type { Style } from '../kit/cell.ts'
import type { Painter } from '../kit/painter.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import { prevClusterStart, takeColumns, textWidth } from '../kit/text.ts'
import { wrapText } from './transcript.ts'

/** One choice in a dialog. */
export interface DialogChoice {
  /** What {@link Dialog.result} resolves to when this is chosen. */
  readonly value: string
  /** The button's label. */
  readonly label: string
  /** One line explaining the consequence, shown under the buttons. */
  readonly detail?: string
  /** Whether this is the default choice, taken by Enter. */
  readonly isDefault?: boolean
  /** Whether this choice is dangerous, and so painted as a warning. */
  readonly dangerous?: boolean
  /**
   * The bare letter that picks this choice while `letterKeys` is on — for a
   * vocabulary wider than the built-in y/n (an "always", say). Searched after
   * the built-ins, so y and n keep their meaning unless a choice claims them.
   */
  readonly letter?: string
}

/** What a dialog needs to draw and resolve. */
export interface DialogSpec {
  /** The window title. */
  readonly title: string
  /** The question, wrapped to the window width. */
  readonly question: string
  /** Longer text shown below the question and scrolled with PageUp/PageDown. */
  readonly detail?: string
  /** The choices, in order. */
  readonly choices: readonly DialogChoice[]
  /** Whether the choices may be picked with a bare letter. */
  readonly letterKeys?: boolean
  /**
   * An optional one-line text field, for dialogs that collect a value rather
   * than a choice (an API key, a name). While present, bare letters type into
   * the field instead of invoking choices.
   */
  readonly input?: { readonly placeholder?: string; readonly initial?: string }
}

/**
 * The result of a dialog.
 *
 * `value` is the chosen choice, or undefined when the dialog was dismissed; the
 * caller decides what dismissal means, because for an approval it is a "no" and
 * for a confirmation it is a "not now".
 */
export interface DialogResult {
  readonly value?: string
  /** The text field's contents at settle time, when the spec had one. */
  readonly input?: string
  readonly dismissed: boolean
}

/**
 * A modal dialog widget.
 *
 * Owns the selection, the detail scroll, and the settle-once promise. The
 * application creates one, opens it as a floating modal window, and awaits
 * {@link result}.
 */
export class Dialog implements Widget {
  private readonly spec: DialogSpec
  private selected: number
  private detailOffset = 0
  private settled = false
  private resolve: ((result: DialogResult) => void) | undefined
  private readonly promise: Promise<DialogResult>
  private abortListener: (() => void) | undefined
  /** The lifetime signal, kept so {@link settle} can detach from it. */
  private readonly signal: AbortSignal | undefined
  /** The button rectangles recorded while drawing, for the mouse. */
  private buttonBoxes: { index: number; start: number; end: number; row: number }[] = []
  /** The row the buttons are drawn on, in the window interior's coordinates. */
  private buttonRow = 0
  /** The text field's buffer, when the spec has one. */
  private inputText = ''
  /** The text field's caret, in code units. */
  private inputCaret = 0

  /**
   * @param spec - Title, question, detail, and choices.
   * @param signal - Optional lifetime; aborting settles the dialog as dismissed.
   */
  constructor(spec: DialogSpec, signal?: AbortSignal) {
    this.spec = spec
    this.signal = signal
    this.inputText = spec.input?.initial ?? ''
    this.inputCaret = this.inputText.length
    const fallback = spec.choices.findIndex(choice => choice.isDefault === true)
    this.selected = fallback >= 0 ? fallback : 0
    this.promise = new Promise<DialogResult>((resolve) => {
      this.resolve = resolve
    })
    if (signal !== undefined) {
      this.abortListener = () => this.settle({ dismissed: true })
      if (signal.aborted) this.abortListener()
      else signal.addEventListener('abort', this.abortListener, { once: true })
    }
  }

  /** Resolves exactly once, when the dialog is answered or dismissed. */
  get result(): Promise<DialogResult> {
    return this.promise
  }

  /** Whether the dialog has already been settled. */
  get done(): boolean {
    return this.settled
  }

  /**
   * Settle the dialog, ignoring any later attempt.
   * @param result - The outcome.
   */
  settle(result: DialogResult): void {
    if (this.settled) return
    this.settled = true
    // Detach from the lifetime signal: a dialog that answered normally must not
    // stay subscribed until the (possibly hours-long) turn signal is collected.
    if (this.signal !== undefined && this.abortListener !== undefined) {
      this.signal.removeEventListener('abort', this.abortListener)
    }
    this.abortListener = undefined
    this.resolve?.(result)
    this.resolve = undefined
  }

  /**
   * Paint the dialog.
   * @param painter - The window interior.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    let row = 0
    // The question, wrapped. It is the reason the window exists, so it gets the
    // bright dialog text and the top of the window.
    for (const line of wrapText(this.spec.question, painter.width)) {
      if (row >= painter.height) return
      painter.text(0, row, line, painter.width, palette.dialogStatic)
      row++
    }
    // The text field, when the spec has one, sits right under the question —
    // above any detail region, so it is never scrolled away. The block caret
    // keeps the editing position visible without a hardware cursor.
    if (this.spec.input !== undefined) {
      if (this.inputText === '' && this.spec.input.placeholder !== undefined) {
        painter.text(0, row, ` ${this.spec.input.placeholder}`, painter.width, palette.inputHint)
      } else {
        painter.text(0, row, ` ${this.inputText}\u258C`, painter.width, palette.inputBody)
      }
      row++
    }
    row++
    // The detail, in a bordered region the reader can scroll.
    if (this.spec.detail !== undefined && this.spec.detail !== '') {
      const buttonRows = this.spec.choices.length > 0 ? 4 : 2
      const detailHeight = Math.max(0, painter.height - row - buttonRows)
      if (detailHeight > 2) {
        const inner = painter.sub(0, row, painter.width, detailHeight)
        const lines = this.spec.detail.split('\n').flatMap(line => wrapText(line, Math.max(1, inner.width - 2)))
        const max = Math.max(0, lines.length - (inner.height - 2))
        this.detailOffset = Math.min(this.detailOffset, max)
        for (let column = 0; column < inner.width; column++) {
          inner.set(column, 0, '─', palette.dialogStatic)
          inner.set(column, inner.height - 1, '─', palette.dialogStatic)
        }
        for (let index = 0; index < inner.height - 2; index++) {
          const line = lines[this.detailOffset + index]
          if (line === undefined) break
          inner.text(1, index + 1, line, Math.max(0, inner.width - 2), palette.dialogStatic)
        }
        if (lines.length > inner.height - 2) {
          const more = this.detailOffset + inner.height - 2 < lines.length ? ' ↓ more' : ' ↑ top'
          inner.text(1, inner.height - 1, more, Math.min(8, inner.width - 2), palette.diffMeta)
        }
        row += detailHeight
      }
    }
    // The buttons, centred on their own row near the bottom.
    this.buttonRow = Math.max(row + 1, painter.height - 2)
    const labels = this.spec.choices.map(choice => `  ${choice.label}  `)
    const total = labels.reduce((sum, label) => sum + textWidth(label) + 2, -2)
    let column = Math.max(0, Math.floor((painter.width - total) / 2))
    this.buttonBoxes = []
    for (let index = 0; index < labels.length; index++) {
      const label = labels[index]
      /* c8 ignore next -- index is in range. */
      if (label === undefined) continue
      const choice = this.spec.choices[index]
      /* c8 ignore next -- index is in range. */
      if (choice === undefined) continue
      const width = textWidth(label)
      const style = index === this.selected
        ? palette.dialogDefault
        : choice.dangerous === true ? palette.error : palette.dialogStatic
      painter.text(column, this.buttonRow, label, width, style)
      this.buttonBoxes.push({ index, start: column, end: column + width, row: this.buttonRow })
      column += width + 2
    }
    // The highlighted choice's explanation, under the buttons.
    const detail = this.spec.choices[this.selected]?.detail
    if (detail !== undefined && this.buttonRow + 1 < painter.height) {
      painter.text(0, this.buttonRow + 1, takeColumns(detail, painter.width), painter.width, palette.reasoning)
    }
  }

  /**
   * Handle a key.
   * @param event - The key event.
   * @returns Whether the key was consumed; a dialog consumes everything.
   */
  onKey(event: KeyEvent): Consumed {
    const plain = event.key.replace(/^(ctrl|alt|shift|super)\+/u, '')
    // The text field eats printable keys first: with an input present, letters
    // type rather than invoke, and left/right/home/end/edit the field rather
    // than the button row.
    if (this.spec.input !== undefined) {
      const ctrl = event.ctrl === true || event.key.startsWith('ctrl+')
      const alt = event.alt === true || event.key.startsWith('alt+')
      if (!ctrl && !alt && event.text !== undefined && event.text !== '' && event.text !== '\r' && event.text !== '\n') {
        this.inputText = this.inputText.slice(0, this.inputCaret) + event.text + this.inputText.slice(this.inputCaret)
        this.inputCaret += event.text.length
        return Consumed.Yes
      }
      if (plain === 'backspace') {
        if (this.inputCaret > 0) {
          // By cluster: half a surrogate pair must never become a lone
          // surrogate in a value the caller will store.
          const start = prevClusterStart(this.inputText, this.inputCaret)
          this.inputText = this.inputText.slice(0, start) + this.inputText.slice(this.inputCaret)
          this.inputCaret = start
        }
        return Consumed.Yes
      }
      if (plain === 'home') { this.inputCaret = 0; return Consumed.Yes }
      if (plain === 'end') { this.inputCaret = this.inputText.length; return Consumed.Yes }
    }
    switch (plain) {
      case 'left':
        this.selected = (this.selected - 1 + this.spec.choices.length) % this.spec.choices.length
        return Consumed.Yes
      case 'right':
      case 'tab':
        this.selected = (this.selected + 1) % this.spec.choices.length
        return Consumed.Yes
      case 'up':
        this.detailOffset = Math.max(0, this.detailOffset - 1)
        return Consumed.Yes
      case 'down':
        this.detailOffset += 1
        return Consumed.Yes
      case 'pageup':
        this.detailOffset = Math.max(0, this.detailOffset - 10)
        return Consumed.Yes
      case 'pagedown':
        this.detailOffset += 10
        return Consumed.Yes
      case 'enter':
      case 'space':
        this.choose(this.selected)
        return Consumed.Yes
      case 'escape':
        // Dismissal carries the field's contents too: a cancelled dialog that
        // ate a half-typed value is a small, pointless loss.
        this.settle({ dismissed: true, ...(this.spec.input === undefined ? {} : { input: this.inputText }) })
        return Consumed.Yes
      case 'y':
      case 'n':
        if (this.spec.letterKeys === true && this.spec.input === undefined) {
          // The built-ins: y allows and n denies, by value, though a choice
          // carrying this key as its explicit letter outranks them. When
          // neither matches the key is simply swallowed — choosing nothing
          // beats dismissing a dialog the key never named.
          const value = event.key === 'y' ? 'allow' : 'deny'
          const byValue = this.spec.choices.findIndex(choice => choice.value === value)
          const byLetter = this.spec.choices.findIndex(choice => choice.letter === event.key)
          if (byLetter >= 0) this.choose(byLetter)
          else if (byValue >= 0) this.choose(byValue)
          return Consumed.Yes
        }
        return Consumed.Yes
      default: {
        // Any other key with a letter bound to it picks that choice; the rest
        // are swallowed — a dialog owns the keyboard, and a stray key leaking
        // into the composer behind it would be worse than a no-op.
        if (this.spec.letterKeys === true && this.spec.input === undefined) {
          const index = this.spec.choices.findIndex(choice => choice.letter === event.key)
          if (index >= 0) this.choose(index)
        }
        return Consumed.Yes
      }
    }
  }

  /**
   * Handle a click on a button.
   * @param event - The mouse event, in screen coordinates.
   * @param context - Palette, focus, and the widget's screen origin.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent, context: WidgetContext): Consumed {
    const origin = context.origin ?? { x: 0, y: 0 }
    if (event.kind === 'wheel') {
      this.detailOffset = Math.max(0, this.detailOffset + (event.delta ?? 1))
      return Consumed.Yes
    }
    if (event.kind !== 'press' || event.button !== 'left') return Consumed.Yes
    const localRow = event.y - origin.y
    const localColumn = event.x - origin.x
    const box = this.buttonBoxes.find(candidate => (
      candidate.row === localRow && localColumn >= candidate.start && localColumn < candidate.end
    ))
    if (box !== undefined) {
      this.choose(box.index)
      return Consumed.Yes
    }
    // A click that misses every button is swallowed: a dialog is modal, so
    // nothing behind it may act on the click.
    return Consumed.Yes
  }

  /**
   * Choose a choice by index, settling the dialog.
   * @param index - The choice index; out of range settles as a dismissal.
   */
  private choose(index: number): void {
    const choice = this.spec.choices[index]
    const input = this.spec.input === undefined ? undefined : this.inputText
    if (choice === undefined) {
      this.settle({ dismissed: true, ...(input === undefined ? {} : { input }) })
      return
    }
    this.settle({ value: choice.value, dismissed: false, ...(input === undefined ? {} : { input }) })
  }
}

/**
 * The standard two-button confirmation.
 * @param question - What is being confirmed.
 * @param options - Titles, labels, and whether the confirmation is dangerous.
 * @returns A dialog specification.
 */
export function confirmSpec(
  question: string,
  options: {
    title?: string
    confirmLabel?: string
    cancelLabel?: string
    dangerous?: boolean
    detail?: string
  } = {},
): DialogSpec {
  const confirmLabel = options.confirmLabel ?? 'Yes'
  const cancelLabel = options.cancelLabel ?? 'No'
  return {
    title: options.title ?? 'Confirm',
    question,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    letterKeys: true,
    choices: [
      {
        value: 'confirm',
        label: confirmLabel,
        dangerous: options.dangerous ?? false,
        // The safe answer is the default: Enter on a destructive prompt should
        // not be the same keystroke as Enter on a harmless one.
        isDefault: !(options.dangerous ?? false),
      },
      { value: 'cancel', label: cancelLabel, isDefault: options.dangerous ?? false },
    ],
  }
}

/**
 * The style a dialog's title bar uses, so an approval reads as urgent without
 * needing a different window class.
 * @param dangerous - Whether the dialog is about something destructive.
 * @param palette - The resolved palette.
 * @returns The title style.
 */
export function dialogTitleStyle(dangerous: boolean, palette: { error: Style; windowTitleActive: Style }): Style {
  return dangerous ? palette.error : palette.windowTitleActive
}
