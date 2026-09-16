/**
 * The application: wires the desktop, the chrome, the windows, and the composer
 * into one runnable IDE.
 *
 * The design rule this file follows is that the app owns *presentation and
 * input* and nothing else. Everything it needs from the agent — sending a turn,
 * running a command, answering a question, switching the model — goes through
 * {@link AppHost}, a small interface. That is what lets the whole application be
 * driven in a test by a fake host, and what keeps the DSH-specific code
 * confined to one file.
 *
 * The window layout is the classic one: a full-width transcript on the left and
 * a narrower working column on the right holding the project, tasks, and
 * sessions, with the composer pinned to the bottom of the transcript. Every one
 * of those is an ordinary window, so any of them can be moved, resized, zoomed,
 * or closed, and the menu can bring it back.
 * @module @dsh-tvision/dsh-tvision/app/app
 */

import type { Rect } from '../kit/cell.ts'
import type { Skin } from '../kit/skin.ts'
import type { KeyEvent, MouseEvent, Widget, WidgetContext } from '../kit/widget.ts'
import { Consumed } from '../kit/widget.ts'
import type { Painter } from '../kit/painter.ts'
import { WindowManager, DEFAULT_MINIMUM_TERMINMINAL } from '../kit/wm.ts'
import { InputDecoder } from '../kit/input.ts'
import type { InputEvent } from '../kit/input.ts'
import { ScreenRenderer, detectTruecolor } from '../kit/screen.ts'
import { MenuBarBase, type Menu } from '../widgets/menubar.ts'
import { StatusBar, formatDuration, formatTokens, pressureBar } from '../widgets/statusbar.ts'
import { SessionDocument } from '../session/model.ts'
import { TranscriptView } from '../views/transcript.ts'
import { textWidth } from '../kit/text.ts'
import { Composer, type Completion, type ComposerTheme } from './composer.ts'
import { Dialog, type DialogSpec } from '../views/dialogs.ts'
import { askApproval as askApprovalDialog, askQuestions as askQuestionsDialog } from './questions.ts'
import { buildSessionRows, describeSessionRow, type SessionRow } from './sessions.ts'

/** The terminal surface the app writes to. */
export interface AppTerminal {
  columns: number
  rows: number
  write(data: string): void
}

/** What the application needs from the agent behind it. */
export interface AppHost {
  /** Send a user turn. */
  send(text: string): void
  /** Run a slash command line; returns the text to show, or undefined when unknown. */
  runCommand?(line: string): Promise<{ text?: string; kind: 'success' | 'error' } | undefined>
  /** Ask the agent to stop. */
  cancel?(): void
  /** The commands available for completion, as `name` and description pairs. */
  commands?(): readonly { name: string; description: string }[]
  /** Complete a file reference written as `@prefix`. */
  files?(prefix: string): readonly string[]
  /** A one-line label for the current model route. */
  modelLabel?(): string | undefined
  /**
   * Resume a persisted session, replacing this process. Rejects when the
   * handoff could not be committed, in which case the desktop is still alive.
   */
  resume?(sessionId: string, cwd?: string): Promise<never>
  /**
   * Index the workspace for the Project window. Rejects on an unreadable root.
   * @returns Rows for the window, the paths behind them, and a one-line summary.
   */
  indexFiles?(): Promise<{
    rows: { label: string; detail?: string }[]
    paths: readonly string[]
    summary: string
  }>
  /** Context-window pressure in tokens, or 0 when unknown. */
  contextWindow?(): number
  /** Leave the application. */
  quit(): void
  /** Called after the app has released the terminal. */
  dispose?(): void
}

/** Static description of the application, for the About box and the title bar. */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly sessionId: string
  readonly cwd: string
}

/** Options for {@link TvisionApp}. */
export interface AppOptions {
  readonly terminal: AppTerminal
  readonly host: AppHost
  readonly info: AppInfo
  readonly skin: Skin
  /** Global keys the host wants before the app's own handling. */
  readonly extraKeys?: (event: KeyEvent) => boolean
  /** Whether to enable mouse reporting when the screen modes are taken (default true). */
  readonly mouse?: boolean
}

/** How the desktop is divided on first run. */
export interface LayoutPlan {
  readonly transcript: Rect
  readonly side: Rect
  readonly composerHeight: number
  readonly sideWidth: number
}

/**
 * Compute the initial window rectangles for a terminal size.
 *
 * Proportions rather than fixed sizes, because the first impression of the
 * application is a terminal at whatever size the user happens to have, and a
 * desktop that looks composed at 100×30 and at 200×50 is worth the arithmetic.
 * @param columns - Screen width.
 * @param rows - Screen height.
 * @param desktop - The usable desktop rectangle.
 * @returns The planned rectangles.
 */
export function planLayout(columns: number, _rows: number, desktop: Rect): LayoutPlan {
  // The side column collapses on a narrow terminal rather than squeezing the
  // transcript into an unreadable strip. It takes a real width to be worth
  // having: two 25-column windows are worse than one 50-column one.
  const sideWidth = columns >= 96 ? Math.max(28, Math.min(48, Math.floor(columns * 0.28))) : 0
  const transcriptWidth = sideWidth === 0 ? desktop.width : desktop.width - sideWidth
  // The composer is a separator row and the input line, and it grows when the
  // completion popup opens. Two rows is therefore the size it always uses and
  // three the most it can without leaving a blank row above the sigil. It is also
  // the part that gives way on a short terminal: an input line with no transcript
  // is as useless as a transcript with no input line, so the transcript gets the
  // floor and the composer takes what is left.
  const available = Math.max(1, desktop.height)
  const composerHeight = available <= MIN_TRANSCRIPT_HEIGHT + 1
    ? 1
    : Math.max(2, Math.min(COMPOSER_MAX_ROWS, available - MIN_TRANSCRIPT_HEIGHT))
  // The pane always draws its separator, so a height of one would put the rule on
  // the input line. Below that the transcript simply gets the whole desktop.
  return {
    transcript: { x: desktop.x, y: desktop.y, width: transcriptWidth, height: desktop.height },
    side: {
      x: desktop.x + transcriptWidth,
      y: desktop.y,
      width: sideWidth,
      height: desktop.height,
    },
    composerHeight,
    sideWidth,
  }
}

/** The fewest rows the transcript may be left with before the composer yields. */
const MIN_TRANSCRIPT_HEIGHT = 4

/**
 * The input rows the composer pane would like.
 *
 * Two: the input line and one row above it for a completion popup to open into.
 * The pane adds its own separator row on top, so the whole composer is three
 * rows on an ordinary terminal and two when the transcript needs the row more.
 */
const COMPOSER_INPUT_ROWS = 2

/** What {@link planLayout} reports for the composer pane: its input rows plus the separator. */
const COMPOSER_MAX_ROWS = COMPOSER_INPUT_ROWS + 1

/**
 * The smallest terminal this desktop is worth drawing in.
 *
 * Chosen from what the chrome alone needs — a menu bar, a window frame, and a
 * hint strip — plus enough transcript to read a line of prose. Below it the
 * window manager paints a notice instead, because a desktop crammed into 30
 * columns is a screen of overlapping fragments rather than a smaller desktop.
 */
export const MINIMUM_TERMINAL = DEFAULT_MINIMUM_TERMINMINAL

/** The fewest rows at which the status line earns its own row. */
const STATUS_LINE_MIN_ROWS = 20

/** How many rows each chrome band gets. */
export interface ChromePlan {
  /** Rows for the menu bar. */
  readonly top: number
  /** Rows for the status line and the hint strip. */
  readonly bottom: number
}

/**
 * Decide what the chrome gets for a given screen height.
 *
 * The hint strip survives down to the floor, because it is the legend for every
 * key and the only place the function keys are named. The status line is a
 * meter, so it is the first thing to go; below that the transcript and the
 * composer share what is left, and the window manager takes over once even that
 * is impossible.
 * @param rows - The screen height.
 * @returns The band sizes.
 */
export function planChrome(rows: number): ChromePlan {
  // The status line costs a row, and it is worth that row on any ordinary
  // terminal; below twenty rows four rows of transcript matter more.
  if (rows < STATUS_LINE_MIN_ROWS) return { top: 1, bottom: 1 }
  return { top: 1, bottom: 2 }
}

/** Window ids this application creates. */
export const WINDOW_IDS = {
  transcript: 'transcript',
  project: 'project',
  tasks: 'tasks',
  sessions: 'sessions',
  jobs: 'jobs',
  help: 'help',
  about: 'about',
} as const

/**
 * A read-only text window, for Help and About.
 *
 * Scrolls with the usual pager keys and nothing else, which is the correct
 * amount of functionality for a window whose entire job is to be read.
 */
class TextWindow implements Widget {
  private offset = 0
  private readonly lines: readonly string[]
  private readonly titleLine: string

  /**
   * @param titleLine - The heading printed above the body.
   * @param lines - The body, one screen row per entry.
   */
  constructor(titleLine: string, lines: readonly string[]) {
    this.titleLine = titleLine
    this.lines = lines
  }

  /**
   * Paint the body.
   * @param painter - The window interior.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    painter.text(0, 0, this.titleLine, painter.width, palette.dialogDefault)
    const body = painter.sub(0, 2, painter.width, Math.max(0, painter.height - 2))
    for (let row = 0; row < body.height; row++) {
      const line = this.lines[this.offset + row]
      if (line === undefined) break
      body.text(0, row, line, body.width, palette.dialogStatic)
    }
    if (this.lines.length > body.height) {
      const more = ` ↓ ${this.lines.length - this.offset - body.height} more · ↑↓ scroll `
      body.text(Math.max(0, body.width - more.length), body.height - 1, more, more.length, palette.diffMeta)
    }
  }

  /**
   * Scroll the body.
   * @param event - The key event.
   * @returns Whether the key was consumed.
   */
  onKey(event: KeyEvent): Consumed {
    switch (event.key) {
      case 'down':
        this.offset = Math.min(Math.max(0, this.lines.length - 1), this.offset + 1)
        return Consumed.Yes
      case 'up':
        this.offset = Math.max(0, this.offset - 1)
        return Consumed.Yes
      case 'pagedown':
        this.offset = Math.min(Math.max(0, this.lines.length - 1), this.offset + 10)
        return Consumed.Yes
      case 'pageup':
        this.offset = Math.max(0, this.offset - 10)
        return Consumed.Yes
      case 'home':
        this.offset = 0
        return Consumed.Yes
      case 'end':
        this.offset = Math.max(0, this.lines.length - 1)
        return Consumed.Yes
      default:
        return Consumed.No
    }
  }

  /**
   * Scroll with the wheel.
   * @param event - The mouse event.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent): Consumed {
    if (event.kind !== 'wheel') return Consumed.No
    this.offset = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), this.offset + (event.delta ?? 1) * 3))
    return Consumed.Yes
  }
}

/**
 * The transcript window's content: the transcript view above, the composer
 * below, separated by a rule.
 *
 * They share one window rather than living in two because the composer belongs
 * to the conversation — moving the chat moves its input — and because a
 * one-line window is fiddly to grab with the mouse.
 */
class TranscriptPane implements Widget {
  private readonly view: TranscriptView
  private readonly composer: Composer
  /** The inner rectangle of the composer region, recorded while drawing. */
  private composerRect: Rect = { x: 0, y: 0, width: 0, height: 0 }

  /**
   * @param view - The transcript view.
   * @param composer - The composer.
   */
  constructor(view: TranscriptView, composer: Composer) {
    this.view = view
    this.composer = composer
  }

  /** The transcript view, for the menu's view commands. */
  get transcript(): TranscriptView {
    return this.view
  }

  /** The composer. */
  get input(): Composer {
    return this.composer
  }

  /**
   * The row the composer is drawn on, in screen coordinates.
   * @returns The row index.
   */
  caretRow(): number {
    return this.composerRect.y + this.composerRect.height - 1
  }

  /**
   * Paint the transcript, the rule, and the composer.
   * @param painter - The window interior.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    // The pane owns its own arithmetic, because it is the only thing that knows
    // what it has to draw: a separator, the popup if one is open, and the input
    // line. `composerHeight()` is the size it *wants*; what it *gets* is bounded
    // by the room left after the transcript's floor, and a pane that keeps a
    // popup row it has no room for shows a blank line above the sigil.
    const wanted = COMPOSER_INPUT_ROWS + this.composer.completionRows
    const inputHeight = Math.max(
      1,
      Math.min(wanted, Math.max(1, painter.height - MIN_TRANSCRIPT_HEIGHT - 1)),
    )
    const transcriptHeight = Math.max(0, painter.height - inputHeight - 1)
    if (transcriptHeight > 0) {
      this.view.draw(painter.sub(0, 0, painter.width, transcriptHeight), context)
    }
    const ruleRow = transcriptHeight
    for (let column = 0; column < painter.width; column++) {
      painter.set(column, ruleRow, '─', palette.windowFrame)
    }
    this.composerRect = { x: 0, y: ruleRow + 1, width: painter.width, height: inputHeight }
    this.composer.draw(painter.sub(0, ruleRow + 1, painter.width, inputHeight), context)
  }

  /**
   * Route a key to the composer, letting the transcript take the pager keys it
   * owns first so `PageUp` reads history rather than inserting anything.
   * @param event - The key event.
   * @param context - Palette and focus.
   * @returns Whether the key was consumed.
   */
  onKey(event: KeyEvent, _context: WidgetContext): Consumed {
    // The transcript owns the pager keys and the composer owns everything else,
    // so the order here is the whole policy.
    if (this.view.onKey(event) === Consumed.Yes) return Consumed.Yes
    return this.composer.onKey(event)
  }

  /**
   * Route a click to whichever half was hit.
   * @param event - The mouse event, in screen coordinates.
   * @param context - Palette and focus.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent, context: WidgetContext): Consumed {
    const origin = context.origin ?? { x: 0, y: 0 }
    const rect = {
      x: origin.x + this.composerRect.x,
      y: origin.y + this.composerRect.y,
      width: this.composerRect.width,
      height: this.composerRect.height,
    }
    const inside = event.x >= rect.x && event.x < rect.x + rect.width
      && event.y >= rect.y && event.y < rect.y + rect.height
    // The composer works in its own columns, so translate before handing over.
    if (inside) return this.composer.onMouse({ ...event, x: event.x - origin.x })
    return this.view.onMouse(event)
  }
}

/**
 * A list window: the project tree, the task list, or the session list.
 *
 * One widget for three windows because they differ only in their contents and
 * what choosing a row does; giving each its own class would triple the code for
 * no behaviour.
 */
class ListWindow implements Widget {
  private offset = 0
  private selected = 0
  private items: () => readonly { label: string; detail?: string; marker?: string }[]
  private readonly choose: (index: number) => void
  private readonly empty: string

  /**
   * @param items - Supplies the rows for the current frame.
   * @param choose - Called when a row is activated.
   * @param empty - Shown when there are no rows.
   */
  constructor(
    items: () => readonly { label: string; detail?: string; marker?: string }[],
    choose: (index: number) => void,
    empty: string,
  ) {
    this.items = items
    this.choose = choose
    this.empty = empty
  }

  /**
   * Swap the row source, for contents that are replaced rather than derived.
   *
   * The selection is clamped rather than reset: a list that refreshes while the
   * agent works — a file index, a job list — must not throw the reader back to
   * the top every few seconds.
   * @param items - The new source.
   */
  setSource(items: () => readonly { label: string; detail?: string; marker?: string }[]): void {
    this.items = items
    this.selected = Math.max(0, Math.min(this.items().length - 1, this.selected))
    this.offset = Math.max(0, Math.min(this.offset, this.selected))
  }

  /**
   * The rows this window would show right now.
   * @returns The rows, resolved from whatever source it has.
   */
  visibleRows(): readonly { label: string; detail?: string; marker?: string }[] {
    return this.items()
  }

  /**
   * Paint the list.
   * @param painter - The window interior.
   * @param context - Palette and focus.
   */
  draw(painter: Painter, context: WidgetContext): void {
    const palette = context.palette
    const rows = this.items()
    if (rows.length === 0) {
      painter.text(0, 0, this.empty, painter.width, palette.reasoning)
      return
    }
    this.selected = Math.max(0, Math.min(rows.length - 1, this.selected))
    if (this.selected < this.offset) this.offset = this.selected
    if (this.selected >= this.offset + painter.height) this.offset = this.selected - painter.height + 1
    // The detail column is measured from the right and the label takes what is
    // left of it, so the two can never overlap: a label drawn to the window's
    // full width would run straight through the detail text beside it.
    const detailWidth = this.detailColumnWidth(painter.width, rows)
    const labelWidth = Math.max(0, painter.width - MARKER_WIDTH - detailWidth)
    for (let row = 0; row < painter.height; row++) {
      const item = rows[this.offset + row]
      if (item === undefined) break
      const index = this.offset + row
      const style = index === this.selected
        ? (context.focused ? palette.listFocused : palette.listSelected)
        : palette.listNormal
      painter.text(0, row, ` ${item.marker ?? ' '} `, MARKER_WIDTH, style)
      painter.text(MARKER_WIDTH, row, item.label, labelWidth, style)
      if (detailWidth > 0 && item.detail !== undefined) {
        painter.text(painter.width - detailWidth, row, item.detail, detailWidth, style)
      }
    }
  }

  /**
   * How wide the right-hand detail column should be.
   *
   * Sized to the widest detail actually present rather than to a fixed fraction,
   * and capped so the label always keeps the majority of the window. A column of
   * workspace paths can be long, and stealing half the window for it would make
   * the labels — which is what the reader is scanning — unreadable.
   * @param width - The window interior's width.
   * @param rows - The rows being drawn.
   * @returns The detail column width, or 0 when nothing has a detail.
   */
  private detailColumnWidth(
    width: number,
    rows: readonly { label: string; detail?: string }[],
  ): number {
    if (width < MIN_DETAIL_WINDOW_WIDTH) return 0
    let widest = 0
    for (const row of rows) {
      if (row.detail === undefined) continue
      widest = Math.max(widest, textWidth(row.detail))
    }
    if (widest === 0) return 0
    const cap = Math.max(0, Math.floor(width * MAX_DETAIL_SHARE))
    // One column of gutter so the two columns do not touch.
    return Math.min(widest + 1, cap, Math.max(0, width - MARKER_WIDTH - MIN_LABEL_WIDTH))
  }

  /**
   * Move the selection and activate it.
   * @param event - The key event.
   * @returns Whether the key was consumed.
   */
  onKey(event: KeyEvent): Consumed {
    const count = this.items().length
    switch (event.key) {
      case 'down':
        this.selected = Math.min(Math.max(0, count - 1), this.selected + 1)
        return Consumed.Yes
      case 'up':
        this.selected = Math.max(0, this.selected - 1)
        return Consumed.Yes
      case 'home':
        this.selected = 0
        return Consumed.Yes
      case 'end':
        this.selected = Math.max(0, count - 1)
        return Consumed.Yes
      case 'enter':
        if (count > 0) this.choose(this.selected)
        return Consumed.Yes
      default:
        return Consumed.No
    }
  }

  /**
   * Select and activate a clicked row.
   * @param event - The mouse event, in screen coordinates.
   * @param context - Palette, focus, and this widget's screen origin.
   * @returns Whether the event was consumed.
   */
  onMouse(event: MouseEvent, context: WidgetContext): Consumed {
    const count = this.items().length
    if (event.kind === 'wheel') {
      this.selected = Math.max(0, Math.min(Math.max(0, count - 1), this.selected + (event.delta ?? 1)))
      return Consumed.Yes
    }
    if (event.kind !== 'press' || event.button !== 'left') return Consumed.No
    const origin = context.origin ?? { x: 0, y: 0 }
    const row = event.y - origin.y + this.offset
    if (row < 0 || row >= count) return Consumed.No
    this.selected = row
    this.choose(row)
    return Consumed.Yes
  }
}

/** Columns reserved for the marker gutter at the left of a list row. */
const MARKER_WIDTH = 3

/** Below this interior width a list shows labels only, with no detail column. */
const MIN_DETAIL_WINDOW_WIDTH = 30

/** The most of a list window the detail column may take. */
const MAX_DETAIL_SHARE = 0.45

/** The least a label may be squeezed to before the detail column is dropped. */
const MIN_LABEL_WIDTH = 16

/**
 * Describe any thrown value as a one-line message.
 * @param error - Whatever was thrown.
 * @returns A readable string.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The application.
 *
 * Owns the frame loop, the input decoder, and the keymap. `run()` is the only
 * entry point that touches the terminal; everything else can be driven directly,
 * which is how the tests exercise the whole desktop without a tty.
 */
export class TvisionApp {
  /** The window manager. */
  readonly windows: WindowManager
  /** The session document every view reads. */
  readonly document = new SessionDocument()
  /** The transcript view. */
  readonly transcript: TranscriptView
  /** The composer. */
  readonly composer: Composer
  private readonly options: AppOptions
  private readonly menu: MenuBarBase
  private readonly status: StatusBar
  private readonly pane: TranscriptPane
  private readonly decoder = new InputDecoder()
  private readonly renderer: ScreenRenderer
  private readonly lists = new Map<string, ListWindow>()
  private readonly listRows = new Map<string, readonly { label: string; detail?: string; marker?: string }[]>()
  private skin: Skin
  private transient: { text: string; tone: 'info' | 'warning' | 'error'; until: number } | undefined
  private running = false
  private readonly history: string[] = []
  /** How many rows each chrome band got, fixed at mount and on every resize. */
  private chrome: ChromePlan
  /** Counter for dialog window ids, so two dialogs never collide. */
  private dialogSeq = 0
  /** The session rows last set, so a row's identity survives the list widget. */
  private sessionRows: readonly SessionRow[] = []
  /** The workspace each listed session ran in, for the resume handoff. */
  private readonly sessionCwd = new Map<string, string>()
  /** The file paths behind the Project window's rows. */
  private projectRows: readonly { path: string }[] = []

  /**
   * @param options - Terminal, host, identity, and skin.
   */
  constructor(options: AppOptions) {
    this.options = options
    this.skin = options.skin
    const desktopSize = { columns: options.terminal.columns, rows: options.terminal.rows }
    // A short terminal keeps the hint strip — it is the legend for every key —
    // and gives up the status line, which is a meter and not a control.
    const chrome = planChrome(desktopSize.rows)
    this.windows = new WindowManager({
      columns: desktopSize.columns,
      rows: desktopSize.rows,
      skin: options.skin,
      topInset: chrome.top,
      bottomInset: chrome.bottom,
      minimum: MINIMUM_TERMINAL,
    })
    this.chrome = chrome
    this.renderer = new ScreenRenderer(detectTruecolor())
    this.windows.attachRenderer(this.renderer)
    const plan = planLayout(desktopSize.columns, desktopSize.rows, this.windows.desktop)
    this.transcript = new TranscriptView(this.document, {
      gutterWidth: 2,
      collapsed: true,
      showReasoning: true,
    })
    this.composer = new Composer(
      {
        submit: (text) => { void this.submit(text) },
        history: () => this.history,
        complete: token => this.complete(token),
        prompt: () => this.sigil(),
        placeholder: 'Type a message · / for commands · F1 help · F10 menu',
        changed: () => {
          this.composer.refresh()
          this.windows.requestRender()
        },
      },
      this.composerTheme(),
    )
    this.pane = new TranscriptPane(this.transcript, this.composer)
    this.menu = new MenuBarBase({
      menus: () => this.buildMenus(),
      describe: () => { this.windows.requestRender() },
      describeItem: (item) => {
        if (item?.hint !== undefined) this.notify(item.hint)
      },
    })
    this.status = new StatusBar({
      hints: () => this.buildHints(),
      status: () => this.buildStatus(),
      message: () => this.transient === undefined ? undefined : { text: this.transient.text, tone: this.transient.tone },
      invoke: (key) => { void this.invokeHint(key) },
      describe: () => {},
    })
    this.installChrome()
    this.openDefaultWindows(plan)
  }

  /** The active skin. */
  get activeSkin(): Skin {
    return this.skin
  }

  /** Apply a new skin to the whole desktop. */
  setSkin(skin: Skin): void {
    this.skin = skin
    this.windows.setSkin(skin)
    this.windows.requestRender()
  }

  /** The line the composer prints as its sigil, including the running timer. */
  private sigil(): string {
    const phase = this.document.agentPhase
    if (phase === 'running') {
      const elapsed = formatDuration(Date.now() - this.document.phaseSince)
      return `dsh ${elapsed}> `
    }
    if (phase === 'compacting') return 'dsh compacting> '
    return 'dsh> '
  }

  /** The composer's styles, resolved from the active palette. */
  private composerTheme(): ComposerTheme {
    const palette = this.windows.palette
    return {
      body: palette.inputBody,
      prompt: palette.inputPrompt,
      hint: palette.inputHint,
      completion: palette.listNormal,
      completionSelected: palette.listFocused,
    }
  }

  /**
   * Install the menu bar and the status strip as desktop chrome.
   */
  private installChrome(): void {
    this.windows.topChrome = {
      draw: (painter, _palette, manager) => {
        this.menu.draw(painter, { palette: manager.palette, focused: false, requestRender: () => manager.requestRender() })
      },
      onKey: (event) => this.menu.handleKey(event) === Consumed.Yes,
      onMouse: (event) => this.menu.handleMouse(event, { x: 0, y: 0 }) === Consumed.Yes,
    }
    this.windows.bottomChrome = {
      draw: (painter, _palette, manager) => {
        // On a short terminal the band is the hint strip alone; the bar itself
        // decides from its own height whether the status line has a row.
        this.status.draw(painter, {
          palette: manager.palette,
          focused: true,
          requestRender: () => manager.requestRender(),
        })
      },
      onKey: (event) => this.status.handleKey(event) === Consumed.Yes,
      onMouse: (event, manager) => {
        const band = manager.bottomBand
        return this.status.handleMouse(event, { x: band.x, y: band.y, height: band.height }) === Consumed.Yes
      },
    }
    this.windows.overlayProvider = palette => this.menu.overlay(palette)
    // A click inside an open menu must not reach the window under it.
    this.windows.overlayInput = (event) => this.menu.handleMouse(event, { x: 0, y: 0 }) === Consumed.Yes
  }

  /**
   * Open the windows the desktop starts with.
   * @param plan - The layout plan.
   */
  private openDefaultWindows(plan: LayoutPlan): void {
    this.windows.open({
      id: WINDOW_IDS.transcript,
      title: 'Conversation',
      rect: plan.transcript,
      widget: this.pane,
      resizable: true,
      scrollable: false,
    })
    if (plan.sideWidth > 0) {
      // The two side windows overlap by a row so the dividing frame is shared
      // rather than doubled, which is how a tiled text-mode desktop looked.
      // Half each, minus the one row the two frames share. Sharing it means a
      // single dividing line rather than two stacked borders, and it leaves both
      // windows' grips one row clear of the status bands — a grip the chrome
      // covers is a grip the pointer can never reach.
      const half = Math.floor(plan.side.height / 2)
      const projectHeight = half
      const tasksHeight = plan.side.height - half - 1
      this.windows.open({
        id: WINDOW_IDS.project,
        title: 'Project',
        rect: { x: plan.side.x, y: plan.side.y, width: plan.side.width, height: projectHeight },
        widget: this.listWindow(WINDOW_IDS.project, () => [], 'No project files indexed yet.'),
        resizable: true,
      })
      this.windows.open({
        id: WINDOW_IDS.tasks,
        title: 'Tasks',
        rect: {
          x: plan.side.x,
          y: plan.side.y + projectHeight - 1,
          width: plan.side.width,
          height: tasksHeight,
        },
        widget: this.listWindow(
          WINDOW_IDS.tasks,
          () => this.document.todoList.map(todo => ({
            label: todo.text,
            marker: todo.status === 'completed'
              ? '✓'
              : todo.status === 'in_progress' ? '▸' : todo.status === 'cancelled' ? '✗' : '·',
          })),
          'No tasks yet.',
        ),
        resizable: true,
      })
    }
    this.windows.open({
      id: WINDOW_IDS.sessions,
      title: 'Sessions',
      rect: { x: Math.max(2, plan.transcript.width - 50), y: 3, width: 46, height: 12 },
      widget: this.listWindow(WINDOW_IDS.sessions, () => [], 'Press F3 to list resumable sessions.'),
      listed: true,
    })
    this.windows.close(WINDOW_IDS.sessions)
    this.windows.open({
      id: WINDOW_IDS.jobs,
      title: 'Jobs',
      rect: { x: 4, y: 4, width: 44, height: 10 },
      widget: this.listWindow(WINDOW_IDS.jobs, () => [], 'No background jobs.'),
      listed: true,
    })
    this.windows.close(WINDOW_IDS.jobs)
    this.windows.focus(WINDOW_IDS.transcript)
  }

  /**
   * Create (or reuse) a list window.
   * @param id - The window id.
   * @param items - The row source.
   * @param empty - The empty-state message.
   * @returns The widget.
   */
  private listWindow(
    id: string,
    items: () => readonly { label: string; detail?: string; marker?: string }[],
    empty: string,
  ): ListWindow {
    const widget = new ListWindow(items, index => this.activateListRow(id, index), empty)
    this.lists.set(id, widget)
    return widget
  }

  /**
   * Replace a list window's rows, for a source that changes wholesale — a file
   * index that finished, a session list that was re-read. The Project, Sessions
   * and Jobs windows take their contents this way; Tasks and Conversation read
   * the session document directly.
   * @param id - The window id.
   * @param rows - The new rows.
   */
  setListRows(id: string, rows: readonly { label: string; detail?: string; marker?: string }[]): void {
    const widget = this.lists.get(id)
    if (widget === undefined) {
      this.notify(`No list window named ${id}.`, 'warning')
      return
    }
    this.listRows.set(id, rows)
    widget.setSource(() => this.listRows.get(id) ?? [])
    this.windows.requestRender()
  }

  /**
   * Activate a list row.
   * @param id - The window id.
   * @param index - The row index.
   */
  private activateListRow(id: string, index: number): void {
    if (id === WINDOW_IDS.tasks) {
      const todo = this.document.todoList[index]
      if (todo !== undefined) this.notify(`Task ${todo.status}: ${todo.text}`)
      return
    }
    if (id === WINDOW_IDS.sessions) {
      void this.resumeSession(this.sessionRows[index])
      return
    }
    if (id === WINDOW_IDS.project) {
      // Choosing a file references it, so the next prompt can point at it without
      // retyping the path.
      const row = this.projectRows[index]
      if (row?.path !== undefined) {
        this.composer.insert(`@${row.path} `)
        this.windows.focus(WINDOW_IDS.transcript)
      }
      return
    }
    this.notify(`Selected row ${index + 1}.`)
  }

  /**
   * Resume a session, handing the process over.
   *
   * The handoff replaces this process, so everything here is best-effort: if the
   * host rejects, the desktop is still alive and must be restored to a usable
   * state with an explanation rather than left half-torn-down.
   * @param row - The chosen session row.
   */
  async resumeSession(row: SessionRow | undefined): Promise<void> {
    if (row === undefined) return
    const resume = this.options.host.resume
    if (resume === undefined) {
      this.notify('This host cannot resume in place; restart with --resume.', 'warning')
      return
    }
    if (!row.resumable) {
      this.notify(describeSessionRow(row), 'warning')
      return
    }
    const cwd = this.sessionCwd.get(row.id)
    this.notify(`Resuming ${row.id}…`, 'info', 2000)
    this.frame()
    try {
      // A handoff that commits never returns; one that rejects leaves this
      // process alive, which is what the catch below is for.
      await resume(row.id, cwd)
    } catch (error) {
      /* c8 ignore next 3 -- a committed handoff never returns. */
      this.renderer.invalidate()
      this.windows.requestRender()
      this.notify(`Could not resume ${row.id}: ${describeError(error)}`, 'error')
    }
  }


  /** Show a transient message in the status line. */
  notify(text: string, tone: 'info' | 'warning' | 'error' = 'info', milliseconds = 6000): void {
    this.transient = { text, tone, until: Date.now() + milliseconds }
    this.windows.requestRender()
  }

  /** The function-key strip. */
  private buildHints(): readonly { key: string; label: string; action?: () => void }[] {
    return [
      { key: 'f1', label: 'Help', action: () => this.showHelp() },
      { key: 'f2', label: 'New', action: () => this.newSession() },
      { key: 'f3', label: 'Open', action: () => this.openWindow(WINDOW_IDS.sessions) },
      { key: 'f4', label: 'Tools', action: () => this.toggleTools() },
      { key: 'f5', label: 'Focus', action: () => { this.windows.focus(WINDOW_IDS.transcript) } },
      { key: 'f6', label: 'Next', action: () => { this.windows.cycle(1) } },
      { key: 'f7', label: 'Project', action: () => this.toggleWindow(WINDOW_IDS.project) },
      { key: 'f8', label: 'Tasks', action: () => this.toggleWindow(WINDOW_IDS.tasks) },
      { key: 'f9', label: 'Skin', action: () => this.cycleSkin() },
      { key: 'f10', label: 'Menu', action: () => { this.menu.enterBarMode(0); this.windows.requestRender() } },
    ]
  }

  /** The right-hand status cells. */
  private buildStatus(): readonly { text: string; priority?: number; tone?: 'normal' | 'warning' | 'error' | 'success' }[] {
    const tokens = this.document.tokens
    const window = this.options.host.contextWindow?.() ?? 0
    const pressure = window > 0 ? this.document.contextTokens / window : 0
    // Priorities decide what survives a narrow terminal, and the ordering is the
    // reverse of how interesting each thing is: the model route is the one fact
    // that must never be lost, the context meter is the one that matters most
    // while a turn runs, and the window count is trivia that goes first.
    const cells: { text: string; priority?: number; tone?: 'normal' | 'warning' | 'error' | 'success' }[] = []
    const model = this.options.host.modelLabel?.() ?? this.document.model
    if (model !== undefined) cells.push({ text: model, priority: 4 })
    if (window > 0) {
      cells.push({
        text: `${pressureBar(pressure, 6)} ${Math.round(pressure * 100)}%`,
        priority: 3,
        tone: pressure > 0.9 ? 'error' : pressure > 0.7 ? 'warning' : 'normal',
      })
    }
    cells.push({ text: `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`, priority: 2 })
    cells.push({ text: `${this.windows.all().filter(entry => !entry.closed && entry.listed).length} win`, priority: 1 })
    cells.push({ text: 'F10 menu', priority: 0 })
    return cells
  }

  /** The menus. */
  private buildMenus(): Menu[] {
    const run = (fn: () => void): (() => void) => fn
    return [
      {
        id: 'file',
        label: '&File',
        items: () => [
          { id: 'new', label: '&New session', shortcut: 'F2', action: run(() => this.newSession()), hint: 'Start a fresh session' },
          { id: 'open', label: '&Open session…', shortcut: 'F3', action: run(() => this.toggleWindow(WINDOW_IDS.sessions)), hint: 'List resumable sessions' },
          { id: 'sep1', label: '', separator: true },
          { id: 'send', label: '&Send message', shortcut: 'Enter', action: run(() => { void this.composer.submit() }), hint: 'Send the composer contents' },
          { id: 'cancel', label: '&Cancel turn', shortcut: 'Ctrl+C', action: run(() => this.cancel()), hint: 'Ask the agent to stop' },
          { id: 'sep2', label: '', separator: true },
          { id: 'quit', label: 'E&xit', shortcut: 'Ctrl+Q', action: run(() => this.options.host.quit()), hint: 'Leave tvision' },
        ],
      },
      {
        id: 'view',
        label: '&View',
        items: () => [
          { id: 'conversation', label: '&Conversation', action: run(() => this.toggleWindow(WINDOW_IDS.transcript)) },
          { id: 'project', label: '&Project', shortcut: 'F7', action: run(() => this.toggleWindow(WINDOW_IDS.project)) },
          { id: 'tasks', label: '&Tasks', shortcut: 'F8', action: run(() => this.toggleWindow(WINDOW_IDS.tasks)) },
          { id: 'jobs', label: '&Jobs', action: run(() => this.toggleWindow(WINDOW_IDS.jobs)) },
          { id: 'sessions', label: '&Sessions', shortcut: 'F3', action: run(() => this.toggleWindow(WINDOW_IDS.sessions)) },
          { id: 'sep', label: '', separator: true },
          {
            id: 'layout',
            label: '&Layout',
            submenu: [
              { id: 'tile', label: '&Tile', action: run(() => { this.windows.tile() }) },
              { id: 'cascade', label: '&Cascade', action: run(() => { this.windows.cascade() }) },
              { id: 'zoom', label: '&Zoom', shortcut: 'Ctrl+Z', action: run(() => { this.windows.toggleZoom() }) },
              { id: 'arrange', label: '&Arrange', action: run(() => this.arrange()) },
            ],
          },
        ],
      },
      {
        id: 'agent',
        label: '&Agent',
        items: () => [
          { id: 'send', label: '&Send message', action: run(() => { void this.composer.submit() }) },
          { id: 'cancel', label: '&Cancel', action: run(() => this.cancel()) },
          { id: 'sep', label: '', separator: true },
          { id: 'reasoning', label: 'Show &reasoning', action: run(() => this.toggleReasoning()) },
          { id: 'expand', label: '&Expand all tools', action: run(() => { this.transcript.expandAll(); this.windows.requestRender() }) },
          { id: 'collapse', label: '&Collapse all tools', action: run(() => { this.transcript.collapseAll(); this.windows.requestRender() }) },
        ],
      },
      {
        id: 'tools',
        label: '&Tools',
        items: () => [
          ...(this.options.host.commands?.() ?? []).map(command => ({
            id: `cmd-${command.name}`,
            label: `&/${command.name}`,
            action: run(() => { void this.submit(`/${command.name}`) }),
            hint: command.description,
          })),
          { id: 'sep', label: '', separator: true },
          { id: 'skin', label: 'Cycle &skin', shortcut: 'F9', action: run(() => this.cycleSkin()) },
        ],
      },
      {
        id: 'window',
        label: '&Window',
        items: () => [
          ...this.windows.listWindows().map(item => ({
            id: `win-${item.id}`,
            label: `${item.open ? '&' : '·'}${item.title}`,
            action: run(() => { this.toggleWindow(item.id) }),
            hint: item.active ? 'This window has focus' : undefined,
          })),
          { id: 'sep', label: '', separator: true },
          { id: 'next', label: '&Next window', shortcut: 'F6', action: run(() => { this.windows.cycle(1) }) },
          { id: 'prev', label: '&Previous window', shortcut: 'Shift+F6', action: run(() => { this.windows.cycle(-1) }) },
        ],
      },
      {
        id: 'help',
        label: '&Help',
        items: () => [
          { id: 'keys', label: '&Keyboard', shortcut: 'F1', action: run(() => this.showHelp()) },
          { id: 'about', label: '&About tvision', action: run(() => this.showAbout()) },
        ],
      },
    ]
  }

  /** Wire the desktop's overlay input and render hook. */
  private installRenderHook(): void {
    this.windows.setRenderRequestHook(() => { /* the loop polls `dirty` */ })
  }

  /**
   * Handle one decoded input event.
   * @param event - The event.
   */
  handle(event: InputEvent): void {
    // A resize re-plans the chrome before the manager reflows, because the bands
    // it will lay out against are the ones this decides.
    if (event.type === 'resize') this.applyChrome(event.rows)
    if (event.type === 'paste') {
      this.composer.insert(event.text.replace(/\r\n?/gu, '\n'))
      this.windows.requestRender()
      return
    }
    if (event.type === 'key' && this.options.extraKeys?.(event) === true) return
    if (event.type === 'key' && this.handleGlobalKey(event)) return
    this.windows.handle(event)
  }

  /**
   * Keys the application owns regardless of focus.
   * @param event - The key event.
   * @returns True when the key was consumed.
   */
  private handleGlobalKey(event: KeyEvent): boolean {
    // The decoder reports a modifier as a name prefix (`ctrl+q`) and may or may
    // not also set the bit, so both forms are normalised here rather than at
    // every call site.
    const ctrl = event.ctrl === true || event.key.startsWith('ctrl+')
    const alt = event.alt === true || event.key.startsWith('alt+')
    const key = event.key.replace(/^(ctrl|alt|shift|super)\+/u, '')
    // The function keys are the app's, and they must all work whether or not the
    // strip had room to advertise them: the strip is a legend, not the keymap.
    if (/^f([1-9]|1[0-2])$/u.test(event.key)) {
      if (event.key === 'f10') return this.menu.handleKey(event) === Consumed.Yes
      const hint = this.buildHints().find(candidate => candidate.key === event.key)
      if (hint?.action !== undefined) {
        hint.action()
        return true
      }
      return false
    }
    if (alt && key.length === 1) {
      return this.menu.handleKey({ ...event, key, alt: true }) === Consumed.Yes
    }
    if (ctrl) {
      switch (key) {
        case 'q':
          this.options.host.quit()
          return true
        case 'c':
          this.cancel()
          return true
        case 'l':
          this.renderer.invalidate()
          this.windows.requestRender()
          return true
        case 'o':
          this.toggleTools()
          return true
        case 'z':
          this.windows.toggleZoom()
          return true
        case 'r':
          this.toggleReasoning()
          return true
        default:
          return false
      }
    }
    return false
  }

  /**
   * Set a window's title, so a view can report state that belongs in the chrome
   * rather than in its rows — an index that truncated, a count that changed.
   * @param id - The window id.
   * @param title - The new title.
   */
  setWindowTitle(id: string, title: string): void {
    const window = this.windows.get(id)
    if (window === undefined || window.title === title) return
    window.title = title
    this.windows.requestRender()
  }

  /**
   * Bring a window to the front, opening it if it is closed.
   * @param id - The window id.
   */
  openWindow(id: string): void {
    if (this.windows.isOpen(id)) this.windows.focus(id)
    else this.windows.setOpen(id, true)
    this.windows.requestRender()
  }

  /** Ask the host to stop the current turn. */
  private cancel(): void {
    this.options.host.cancel?.()
    this.notify('Cancellation requested.', 'warning', 3000)
  }

  /** Flip tool-card expansion. */
  private toggleTools(): void {
    const collapsed = !(this.transcript as unknown as { expandedCount?: number }).expandedCount
    if (collapsed) this.transcript.expandAll()
    else this.transcript.collapseAll()
    this.notify(collapsed ? 'Tool cards expanded.' : 'Tool cards collapsed.', 'info', 2500)
    this.windows.requestRender()
  }

  /** Flip reasoning visibility. */
  private toggleReasoning(): void {
    const view = this.transcript as unknown as { theme?: { showReasoning: boolean } }
    const current = view.theme?.showReasoning ?? true
    this.transcript.setTheme({
      gutterWidth: 2,
      collapsed: true,
      showReasoning: !current,
    })
    this.notify(`Reasoning ${!current ? 'shown' : 'hidden'}.`, 'info', 2500)
    this.windows.requestRender()
  }

  /** Switch to the next skin in the catalogue. */
  private cycleSkin(): void {
    // Imported lazily so the app module does not depend on the catalogue's shape.
    void import('../kit/skin.ts').then((module) => {
      const index = module.SKINS.findIndex(candidate => candidate.id === this.skin.id)
      const next = module.SKINS[(index + 1) % module.SKINS.length]
      /* c8 ignore next -- the active skin is always in the catalogue. */
      if (next === undefined) return
      this.setSkin(next)
      this.notify(`Skin: ${next.name}`, 'info', 2500)
    })
  }

  /**
   * Show or hide a window by id.
   * @param id - The window id.
   */
  toggleWindow(id: string): void {
    const window = this.windows.get(id)
    if (window === undefined) {
      this.notify(`No window named ${id}.`, 'warning')
      return
    }
    if (this.windows.isOpen(id)) {
      if (this.windows.activeWindowId === id) this.windows.close(id)
      else this.windows.focus(id)
    } else {
      this.windows.setOpen(id, true)
    }
    this.windows.requestRender()
  }

  /** Restore the default window arrangement. */
  private arrange(): void {
    const plan = planLayout(this.windows.width, this.windows.height, this.windows.desktop)
    this.windows.get(WINDOW_IDS.transcript)?.setRect(plan.transcript)
    if (plan.sideWidth > 0) {
      const half = Math.floor(plan.side.height / 2)
      this.windows.get(WINDOW_IDS.project)?.setRect({ x: plan.side.x, y: plan.side.y, width: plan.side.width, height: half })
      this.windows.get(WINDOW_IDS.tasks)?.setRect({
        x: plan.side.x, y: plan.side.y + half, width: plan.side.width, height: plan.side.height - half,
      })
    }
    this.windows.requestRender()
  }

  /**
   * Run a function-key hint by its key name.
   * @param key - The key name, e.g. `f1`.
   */
  private async invokeHint(key: string): Promise<void> {
    const hint = this.buildHints().find(candidate => candidate.key === key)
    hint?.action?.()
  }

  /**
   * Submit the composer's contents, routing slash commands through the host.
   * @param text - The submitted text.
   */
  private async submit(text: string): Promise<void> {
    const trimmed = text.trim()
    this.history.push(trimmed)
    if (trimmed.startsWith('/') && this.options.host.runCommand !== undefined) {
      this.document.addUser(trimmed, Date.now())
      this.windows.requestRender()
      try {
        const result = await this.options.host.runCommand(trimmed)
        if (result === undefined) this.document.addNotice('error', `Unknown command: ${trimmed}`, Date.now())
        else if (result.text !== undefined && result.text !== '') {
          this.document.addNotice(result.kind === 'error' ? 'error' : 'notice', result.text, Date.now())
        }
      } catch (error) {
        this.document.addNotice('error', error instanceof Error ? error.message : String(error), Date.now())
      }
      this.windows.requestRender()
      return
    }
    // Record the turn locally first, so the composer's contents appear in the
    // transcript immediately rather than when the host echoes the event back.
    this.document.addUser(trimmed, Date.now())
    this.windows.requestRender()
    this.options.host.send(trimmed)
  }

  /**
   * The composer's completion source: commands after `/`, files after `@`.
   * @param token - The token under the caret.
   * @returns Completions for it.
   */
  private complete(token: string): readonly Completion[] {
    if (token.startsWith('/')) {
      const prefix = token.slice(1).toLowerCase()
      return (this.options.host.commands?.() ?? [])
        .filter(command => command.name.toLowerCase().startsWith(prefix))
        .map(command => ({
          insert: `/${command.name} `,
          label: `/${command.name}`,
          detail: command.description,
        }))
    }
    if (token.startsWith('@')) {
      const prefix = token.slice(1)
      return (this.options.host.files?.(prefix) ?? []).slice(0, 8).map(path => ({
        insert: `@${path} `,
        label: `@${path}`,
        detail: 'file',
      }))
    }
    return []
  }

  /** Open the Help window. */
  showHelp(): void {
    const lines = [
      'tvision is a character-cell window manager for DeepSeek Harness.',
      '',
      'F1         this help          F6   next window',
      'F2         new session        F7   project window',
      'F3         open session       F8   tasks window',
      'F4         tool cards         F9   cycle skin',
      'F5         focus composer     F10  menu bar',
      '',
      'Ctrl+Q  quit            Ctrl+C  cancel the turn',
      'Ctrl+O  expand tools    Ctrl+R  show reasoning',
      'Ctrl+Z  zoom window     Ctrl+L  redraw',
      '',
      'Mouse: drag a title bar to move a window, drag the bottom-right',
      'grip (⋮) to resize it, click ≡ to close it, ▲ to zoom it, and',
      'double-click a title bar to zoom. The wheel scrolls whatever the',
      'pointer is over, including the function-key strip.',
      '',
      'Menus: press F10 and use ←/→ to walk the bar, ↓ to open a list,',
      'or press Alt plus the underlined letter. Inside a list, the',
      'underlined letter invokes the item directly.',
      '',
      'Composer: Enter sends, Alt+Enter inserts a newline, Tab completes',
      'a /command or an @file, Up/Down walk the input history.',
      '',
      'Transcript: PageUp/PageDown scroll, Home/End jump, and scrolling',
      'away from the end stops new output from pulling you back down.',
    ]
    this.openTextWindow(WINDOW_IDS.help, 'Help — keys and mouse', lines, { width: 62, height: 22 })
  }

  /** Open the About window. */
  showAbout(): void {
    const info = this.options.info
    this.openTextWindow(WINDOW_IDS.about, `About ${info.name}`, [
      `${info.name} ${info.version}`,
      '',
      'A Turbo Vision-style character-cell window manager for',
      'DeepSeek Harness agents. Overlapping framed windows, a menu',
      'bar, function keys, mouse dragging, and five skins — drawn',
      'cell by cell onto an off-screen grid and diffed to the screen.',
      '',
      `session  ${info.sessionId}`,
      `cwd      ${info.cwd}`,
      `skin     ${this.skin.id} — ${this.skin.name}`,
      '',
      'MIT licensed. Built on the DSH plugin model: this is an',
      'ordinary profile bundle, not a fork.',
    ], { width: 58, height: 16 })
  }

  /**
   * Open a centred read-only text window.
   * @param id - The window id.
   * @param title - The window title.
   * @param lines - The body.
   * @param size - The preferred size.
   */
  private openTextWindow(
    id: string,
    title: string,
    lines: readonly string[],
    size: { width: number; height: number },
  ): void {
    const desktop = this.windows.desktop
    const width = Math.min(size.width, desktop.width)
    const height = Math.min(size.height, desktop.height)
    const rect = {
      x: desktop.x + Math.max(0, Math.floor((desktop.width - width) / 2)),
      y: desktop.y + Math.max(0, Math.floor((desktop.height - height) / 2)),
      width,
      height,
    }
    const existing = this.windows.get(id)
    if (existing !== undefined) {
      existing.closed = false
      existing.setRect(rect)
      this.windows.setModal(existing.floating ? id : undefined)
      this.windows.focus(id)
      this.windows.requestRender()
      return
    }
    this.windows.open({
      id,
      title,
      rect,
      widget: new TextWindow(title, lines),
      closable: true,
      resizable: true,
      floating: true,
    })
    this.windows.setModal(id)
  }

  /**
   * Put a modal question to the user and wait for the answer.
   *
   * The dialog is an ordinary floating window locked as the desktop's modal, so
   * it takes the keyboard, blocks the windows beneath it, and is dismissed by
   * the same keys and clicks as everything else.
   * @param spec - The question, detail, and choices.
   * @param signal - Optional lifetime; aborting dismisses the dialog.
   * @returns The chosen value, or undefined when dismissed.
   */
  async ask(spec: DialogSpec, signal?: AbortSignal): Promise<string | undefined> {
    const dialog = new Dialog(spec, signal)
    const id = `dialog-${this.dialogSeq++}`
    const desktop = this.windows.desktop
    const width = Math.max(20, Math.min(Math.max(48, Math.min(78, desktop.width - 4)), desktop.width))
    const height = Math.max(6, Math.min(spec.detail === undefined ? 9 : 18, desktop.height))
    const rect = {
      x: desktop.x + Math.max(0, Math.floor((desktop.width - width) / 2)),
      y: desktop.y + Math.max(0, Math.floor((desktop.height - height) / 2)),
      width,
      height,
    }
    // A second dialog replaces the first as modal, and the first is settled by
    // its own dismissal path rather than left holding the keyboard. Closing the
    // window itself — the system box, the Window menu — must settle the promise
    // too, or the agent turn that asked waits forever on an answered dialog.
    this.windows.open({
      id,
      title: spec.title,
      rect,
      widget: dialog,
      closable: true,
      resizable: true,
      floating: true,
      onClose: () => dialog.settle({ dismissed: true }),
    })
    this.windows.setModal(id)
    this.windows.requestRender()
    this.frame()
    try {
      const result = await dialog.result
      return result.value
    } finally {
      this.windows.close(id)
      if (this.windows.modalWindowId === id) this.windows.setModal(undefined)
      this.windows.requestRender()
      this.frame()
    }
  }

  /**
   * The approval prompt, in the harness's own outcome vocabulary.
   * @param request - The tool, the reason, and the request's lifetime.
   * @returns The outcome to hand back to the approval service.
   */
  askApproval(request: {
    toolName: string
    reason?: string
    signal?: AbortSignal
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'> {
    return askApprovalDialog(this, request)
  }

  /**
   * A batch of structured questions, including plan review, which arrives
   * through the same path with an `intent` hint.
   * @param request - The questions, in order.
   * @returns The answer to hand back, or undefined to delegate to the next
   * answerer when there is nothing to ask.
   */
  askQuestions(request: {
    questions: readonly {
      id: string
      question: string
      header?: string
      detail?: string
      options?: readonly { label: string; description?: string }[]
      multiSelect?: boolean
    }[]
  }): Promise<{ answers: { id: string; selected: string[] }[] } | undefined> {
    if (request.questions.length === 0) return Promise.resolve(undefined)
    return askQuestionsDialog(this, request.questions)
  }

  /** A new session: clear the transcript and let the host mint one. */
  private newSession(): void {
    this.document.clear()
    this.notify('New session.', 'info', 2500)
    this.windows.requestRender()
  }

  /**
   * Feed a session event into the document.
   * @param event - The event, in the log's shape.
   */
  async applyEvent(event: { type: string; seq: number; time: number; data?: unknown }): Promise<void> {
    // Imported lazily so the fold's module graph is not pulled in until a
    // session event actually arrives.
    const module = await import('./events.ts')
    const outcome = module.foldEvent(this.document, event)
    if (outcome.notice !== undefined) {
      this.document.addNotice(outcome.notice.kind, outcome.notice.text, event.time)
    }
    if (outcome.changed) this.windows.requestRender()
  }

  /**
   * Render one frame if one is due.
   *
   * "Due" covers two cases that are not the same: the desktop changed, or the
   * screen was invalidated (a resize, `Ctrl+L`) and must be repainted even
   * though the content is identical.
   */
  frame(): void {
    if (!this.windows.dirty && !this.renderer.pendingFullRepaint) return
    const output = this.windows.render()
    if (output !== '') this.options.terminal.write(output)
  }

  /**
   * Take the screen and paint the first frame.
   *
   * This does *not* start the repaint loop — {@link startFrameLoop} does, and a
   * host that forgets it gets a desktop that paints once and never again, which
   * is exactly the failure the loop exists to prevent.
   */
  start(): void {
    if (this.running) return
    this.running = true
    this.installRenderHook()
    this.options.terminal.write(ScreenRenderer.enter({ mouse: this.options.mouse ?? true }))
    this.windows.requestRender()
    this.frame()
  }

  /**
   * Poll for due frames until the returned stopper is called.
   *
   * The loop is a poll rather than a subscription because there is nothing to
   * subscribe to: the terminal delivers bytes, and the app turns them into
   * mutations; a repaint is due when the mutation said so. A 16 ms tick matches
   * the terminal's own practical refresh ceiling and costs nothing when idle,
   * because an unchanged frame renders to the empty string. Unref'd so a host
   * that leaks the stopper cannot keep the process alive on it.
   * @param intervalMs - Poll interval (default 16, the practical ceiling).
   * @returns The stopper; call it *before* leaving the alternate screen, or a
   * straggling tick paints a frame onto the shell the user just got back.
   */
  startFrameLoop(intervalMs = 16): () => void {
    const timer = setInterval(() => this.frame(), intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /**
   * Refresh the Project window from the host's file index.
   *
   * Awaited by the caller rather than run on the frame loop: a walk is I/O, and
   * a frame that waits on a filesystem is a frame that stutters.
   * @returns The summary the window title reports, or undefined without a host index.
   */
  async refreshProject(): Promise<string | undefined> {
    const index = this.options.host.indexFiles
    if (index === undefined) return undefined
    try {
      const result = await index()
      this.setListRows(WINDOW_IDS.project, result.rows)
      this.projectRows = result.paths.map(path => ({ path }))
      this.setWindowTitle(WINDOW_IDS.project, `Project — ${result.summary}`)
      return result.summary
    } catch (error) {
      this.setListRows(WINDOW_IDS.project, [])
      this.projectRows = []
      this.setWindowTitle(WINDOW_IDS.project, 'Project — unreadable')
      this.notify(`Could not index the workspace: ${describeError(error)}`, 'error')
      return undefined
    }
  }

  /**
   * Replace the Sessions window's rows.
   *
   * Kept as a plain setter rather than a fetch because the caller owns storage
   * access; the application only knows how to draw a list.
   * @param sessions - The sessions to show.
   * @param home - The home directory, for the workspace column.
   */
  setSessions(
    sessions: readonly {
      id: string
      createdAt: number
      cwd?: string
      live: boolean
      persisted: boolean
      title?: string
      firstPrompt?: string
    }[],
    home?: string,
  ): void {
    this.sessionCwd.clear()
    for (const session of sessions) {
      if (session.cwd !== undefined) this.sessionCwd.set(session.id, session.cwd)
    }
    this.sessionRows = buildSessionRows(sessions, {
      ...(this.options.info.sessionId === '' ? {} : { currentId: this.options.info.sessionId }),
      ...(home === undefined ? {} : { home }),
    })
    this.setListRows(
      WINDOW_IDS.sessions,
      this.sessionRows.map(row => ({
        label: row.resumable ? row.label : `${row.label} (not resumable)`,
        ...(row.detail === '' ? {} : { detail: row.detail }),
        marker: row.marker,
      })),
    )
    this.setWindowTitle(WINDOW_IDS.sessions, `Sessions — ${this.sessionRows.length}`)
  }

  /**
   * The sessions currently listed, for tests and for the status line.
   * @returns The rows.
   */
  get sessions(): readonly SessionRow[] {
    return this.sessionRows
  }

  /**
   * The rows a list window is currently showing, rendered as text.
   *
   * Exists so a test can assert on a window's contents without depending on
   * where the window happens to be placed, how tall it is, or where it is
   * scrolled. Asks the widget, so it works for a window whose rows are derived
   * from the session document as well as one that was handed them.
   * @param id - The window id.
   * @returns The rows, one per line; empty for a window that is not a list.
   */
  listRowsFor(id: string): string {
    const widget = this.lists.get(id)
    if (widget === undefined) return ''
    return widget
      .visibleRows()
      .map(row => `${row.marker ?? ' '} ${row.label}${row.detail === undefined ? '' : `  ${row.detail}`}`)
      .join('\n')
  }

  /**
   * Render one frame and return its bytes instead of writing them.
   *
   * The frame loop writes; a test that wants to feed the bytes into a terminal
   * emulator of its own needs them undelivered. Same renderer, same diffing, so
   * what a test inspects is what the user sees.
   * @returns The escape sequence for this frame, or an empty string.
   */
  renderForTest(): string {
    return this.windows.render()
  }

  /**
   * Re-plan the chrome for a new screen height.
   *
   * The manager's bands are fixed at construction, so a resize has to hand it the
   * new sizes rather than let the desktop be squeezed toward nothing.
   * @param rows - The new screen height.
   */
  applyChrome(rows: number): void {
    // `setChrome` itself skips the work when the bands did not change, so this
    // does not need its own copy of that guard.
    this.chrome = planChrome(rows)
    this.windows.setChrome(this.chrome.top, this.chrome.bottom)
  }

  /**
   * Whether the desktop is currently drawn at all.
   * @returns True when the terminal is large enough to compose.
   */
  get usable(): boolean {
    return this.windows.usable
  }

  /** Leave the full-screen session and give the terminal back. */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.options.terminal.write(ScreenRenderer.leave({ mouse: this.options.mouse ?? true }))
    this.options.host.dispose?.()
  }

  /**
   * Feed raw terminal bytes.
   * @param chunk - The bytes.
   */
  feed(chunk: string): void {
    for (const event of this.decoder.push(chunk)) this.handle(event)
  }

  /** Release a held ESC as the Escape key. */
  flushInput(): void {
    for (const event of this.decoder.flush()) this.handle(event)
  }
}
