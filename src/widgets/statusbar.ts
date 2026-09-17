/**
 * The bottom chrome: the function-key hint strip and the status line.
 *
 * Two rows, and together they are the whole always-visible interface. The upper
 * row is the status line — model route, token counters, context pressure, and a
 * transient message — and is where a running turn announces itself. The lower
 * row is the Borland function-key strip: ten `Fn` labels, each with a word, and
 * they are the primary way a newcomer learns what the thing can do without
 * opening a menu.
 *
 * The strip is generated from the keymap rather than hardcoded, so it cannot
 * drift out of step with the keys that actually work — a failure mode that
 * makes an application feel broken in a way that is hard to diagnose.
 * @module @dsh-tvision/dsh-tvision/widgets/statusbar
 */

import type { Style } from '../kit/cell.ts'
import type { Painter } from '../kit/painter.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import { padEnd, textWidth } from '../kit/text.ts'

/**
 * One function-key binding as the strip shows it.
 *
 * `key` is the F-key name (`'f1'`), `label` is the word printed after it, and
 * `action` is what the application runs. A binding with no action is drawn
 * dimmed, which is how a hint strip stays honest about what is available right
 * now without the labels jumping around as availability changes.
 */
export interface KeyHint {
  readonly key: string
  readonly label: string
  readonly action?: () => void
  /** A tooltip appended to the status line while the pointer is over the hint. */
  readonly hint?: string
}

/** One cell of the status line. */
export interface StatusCell {
  readonly text: string
  /** Higher priority cells survive a narrow terminal; ties drop from the left. */
  readonly priority?: number
  /** Paint this cell with the error role (a failed turn, a broken route). */
  readonly tone?: 'normal' | 'warning' | 'error' | 'success'
}

/** A transient message shown at the left of the status line. */
export interface StatusMessage {
  readonly text: string
  readonly tone: 'info' | 'warning' | 'error'
}

/** Options for {@link StatusBar}. */
export interface StatusBarOptions {
  /** Supplies the function-key strip for the current frame. */
  hints(): readonly KeyHint[]
  /** Supplies the right-hand status cells for the current frame. */
  status(): readonly StatusCell[]
  /** The transient message, if any. */
  message(): StatusMessage | undefined
  /** Invoke a hint by its key name, for a click on the strip. */
  invoke(key: string): void
  /** Called when the pointer moves over a hint, so the status line can explain it. */
  describe?(hint: KeyHint | undefined): void
}

/** The widest a single function-key slot may grow, so the strip stays a row of
 * buttons rather than a row of banners on an ultrawide terminal. */
const HINT_SLOT_MAX = 16

/** How the hint strip is drawn. */
export interface StatusBarTheme {
  readonly bar: Style
  readonly key: Style
  readonly label: Style
  readonly disabled: Style
  readonly statusLine: Style
  readonly info: Style
  readonly warning: Style
  readonly error: Style
  readonly success: Style
  readonly separator: string
}

/**
 * The two-row bottom chrome.
 *
 * It is a {@link Widget} so it can also be tested and embedded directly, and a
 * `ChromeWidget` (via `onKey`/`onMouse`) so the window manager can treat it as
 * part of the frame rather than as a window.
 */
export class StatusBar {
  private readonly options: StatusBarOptions
  /** The row rectangle of the strip within the band, for hit testing. */
  private hitBoxes: { key: string; start: number; end: number }[] = []

  /**
   * @param options - Data sources and the invocation callback.
   */
  constructor(options: StatusBarOptions) {
    this.options = options
  }

  /**
   * Draw the status line and the hint strip into the band.
   *
   * The strip is always the band's last row. The status line takes the row above
   * it exactly when the band has one — the band's height is the chrome plan, so
   * on a short terminal, where the plan allots the band a single row, the
   * transcript keeps the row a meter would have taken and the band is the strip
   * alone.
   * @param painter - The band.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    const theme: StatusBarTheme = {
      bar: palette.statusBar,
      key: palette.statusKey,
      label: palette.statusLabel,
      disabled: palette.menuDisabled,
      statusLine: palette.statusLine,
      info: palette.notice,
      warning: palette.warning,
      error: palette.error,
      success: palette.toolSuccess,
      separator: '│',
    }
    const stripRow = painter.height - 1
    if (painter.height >= 2) {
      painter.fillRow(0, theme.statusLine)
      this.drawStatusLine(painter, theme, 0)
    }
    painter.fillRow(stripRow, theme.bar)
    this.drawHints(painter, theme, stripRow)
  }

  /**
   * Draw the status line: the transient message on the left, the metric cells
   * right-aligned.
   * @param painter - The band.
   * @param theme - Styles.
   * @param row - The row to draw on.
   */
  private drawStatusLine(painter: Painter, theme: StatusBarTheme, row: number): void {
    const message = this.options.message()
    if (message !== undefined) {
      const style = message.tone === 'error'
        ? theme.error
        : message.tone === 'warning' ? theme.warning : theme.info
      painter.text(0, row, padEnd(message.text, painter.width), painter.width, style)
    }
    const cells = this.options.status()
    // Lay the cells out from the right, dropping the lowest priority first when
    // the terminal is too narrow. Absolute positions keep them from jittering.
    const ordered = [...cells].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    const keep: StatusCell[] = []
    let used = message === undefined ? 0 : textWidth(message.text) + 2
    for (let index = ordered.length - 1; index >= 0; index--) {
      const cell = ordered[index]
      /* c8 ignore next -- index is in range. */
      if (cell === undefined) continue
      const cost = textWidth(cell.text) + 3
      if (used + cost > painter.width) continue
      used += cost
      keep.unshift(cell)
    }
    let column = painter.width
    for (let index = keep.length - 1; index >= 0; index--) {
      const cell = keep[index]
      /* c8 ignore next -- index is in range. */
      if (cell === undefined) continue
      const style = cell.tone === 'error'
        ? theme.error
        : cell.tone === 'warning'
          ? theme.warning
          : cell.tone === 'success' ? theme.success : theme.statusLine
      const label = `${theme.separator} ${cell.text} `
      const width = textWidth(label)
      column -= width
      painter.text(column, row, label, width, style)
    }
  }

  /**
   * Draw the function-key strip and record each label's hit box.
   * @param painter - The band.
   * @param theme - Styles.
   * @param row - The row to draw on.
   */
  private drawHints(painter: Painter, theme: StatusBarTheme, row: number): void {
    const hints = this.options.hints()
    this.hitBoxes = []
    if (hints.length === 0) {
      painter.text(0, row, padEnd(' F10 Menu ', painter.width), painter.width, theme.bar)
      return
    }
    // Each hint gets a fixed slot bounded by the longest label, and any surplus
    // is shared out across the strip. Stretching a single hint to full width
    // would make the whole row a button, which is not what it looks like.
    const widest = Math.max(6, ...hints.map(hint => textWidth(hint.label) + 6))
    const slotWidth = Math.min(HINT_SLOT_MAX, widest)
    const slots = Math.min(hints.length, Math.max(1, Math.floor(painter.width / slotWidth)))
    // Leftover columns are distributed one each from the left, so the last
    // hint's box ends flush with the screen edge.
    // A lone hint keeps its natural width rather than becoming a full-width button.
    const surplus = slots > 1 ? Math.max(0, painter.width - slotWidth * slots) : 0
    for (let index = 0; index < slots; index++) {
      const hint = hints[index]
      /* c8 ignore next -- index is in range. */
      if (hint === undefined) continue
      const start = index * slotWidth + Math.min(index, surplus)
      const extra = index < surplus ? 1 : 0
      // Surplus beyond one column per slot belongs to the last slot, whose box
      // then ends flush with the screen edge. The old arithmetic added that
      // remainder on top of an `extra` it had already counted, painting one
      // column past the edge; stretching to the full remaining width instead
      // would turn a lone hint into a whole-row button, which the surplus=0
      // guard for single slots exists to prevent.
      const remainder = index === slots - 1 && surplus >= slots ? surplus - slots : 0
      const width = slotWidth + extra + remainder
      const enabled = hint.action !== undefined
      const number = hint.key.toUpperCase()
      const numberWidth = textWidth(number)
      painter.text(start, row, number, numberWidth, enabled ? theme.key : theme.disabled)
      const labelRoom = Math.max(0, width - numberWidth - 1)
      painter.text(start + numberWidth, row, ` ${hint.label}`, labelRoom + 1, enabled ? theme.label : theme.disabled)
      painter.text(start + width - 1, row, ' ', 1, theme.bar)
      this.hitBoxes.push({ key: hint.key, start, end: start + width })
    }
  }

  /**
   * A click or pointer motion on the strip.
   * @param event - The mouse event, in screen coordinates.
   * @param painterOrigin - The band's top-left, so a click can be localised.
   * @returns Whether the event was consumed.
   */
  handleMouse(event: MouseEvent, painterOrigin: { x: number; y: number; height: number }): Consumed {
    const localRow = event.y - painterOrigin.y
    if (localRow !== painterOrigin.height - 1) {
      this.options.describe?.(undefined)
      return Consumed.No
    }
    const localColumn = event.x - painterOrigin.x
    const box = this.hitBoxes.find(candidate => localColumn >= candidate.start && localColumn < candidate.end)
    if (box === undefined) return Consumed.No
    if (event.kind === 'press') {
      this.options.invoke(box.key)
      return Consumed.Yes
    }
    return Consumed.No
  }

  /**
   * The function keys are also keyboard shortcuts: F1–F12 invoke the matching
   * hint directly, which is what makes the strip a control surface rather than
   * a legend.
   * @param event - The key event.
   * @returns Whether the key was consumed.
   */
  handleKey(event: KeyEvent): Consumed {
    if (!/^f([1-9]|1[0-2])$/u.test(event.key)) return Consumed.No
    const hint = this.options.hints().find(candidate => candidate.key === event.key)
    if (hint === undefined) return Consumed.No
    hint.action?.()
    return hint.action === undefined ? Consumed.No : Consumed.Yes
  }

  /**
   * The hint boxes, in local columns, for tests.
   * @returns The recorded hit boxes.
   */
  get boxes(): readonly { key: string; start: number; end: number }[] {
    return this.hitBoxes
  }
}

/**
 * Format a token count the way the status line shows it: three significant
 * digits with a magnitude suffix, because the exact number is never the point.
 * @param value - The count.
 * @returns A short label such as `1.2k` or `847`.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value < 1000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/**
 * Format a duration as a compact elapsed label.
 * @param milliseconds - Elapsed time.
 * @returns `0.4s`, `12s`, `3m04s`, or `1h02m`.
 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—'
  const seconds = milliseconds / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m${String(remainder).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * A ten-cell pressure bar for context usage, drawn with block glyphs.
 * @param ratio - Fraction used, 0–1.
 * @param width - Bar width in cells (default 10).
 * @returns The bar, with no colour applied.
 */
export function pressureBar(ratio: number, width = 10): string {
  // A non-finite ratio (a usage total that never arrived) clamps to empty
  // rather than propagating NaN into repeat(), which renders nothing at all.
  const clamped = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
  const filled = Math.round(clamped * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}
