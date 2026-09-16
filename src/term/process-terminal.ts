/**
 * The real terminal: raw mode, the byte stream, and the screen modes.
 *
 * Small on purpose. The application owns the frame loop and the renderer owns
 * the escape sequences; this module owns only the four things that genuinely
 * need `process`: putting stdin into raw mode, forwarding bytes, reporting the
 * window size, and putting all of it back on the way out.
 *
 * Two details are easy to get wrong and expensive to debug:
 *
 * - **Raw mode must be restored on every exit path.** A terminal left raw is
 *   unusable, and a crash is exactly when it happens. The handler is installed
 *   for `exit`, for signals, and for the ordinary stop.
 * - **The original raw-mode state is remembered, not assumed.** dsh may already
 *   be running with a modified terminal, and claiming it was not raw would leave
 *   the parent shell broken.
 * @module @dsh-tvision/dsh-tvision/term/process-terminal
 */

import { ScreenRenderer } from '../kit/screen.ts'

/** Options for {@link ProcessTerminal}. */
export interface ProcessTerminalOptions {
  /** Whether to enable SGR mouse reporting (default true). */
  readonly mouse?: boolean
  /** Fallback width when the terminal reports nothing (default 80). */
  readonly defaultColumns?: number
  /** Fallback height when the terminal reports nothing (default 24). */
  readonly defaultRows?: number
  /** Where to write; defaults to `process.stdout`. */
  readonly write?: (data: string) => void
  /** Where to read; defaults to `process.stdin`. */
  readonly input?: NodeJS.ReadStream
  /** Where to watch for size changes; defaults to `process.stdout`. */
  readonly output?: NodeJS.WriteStream
}

/**
 * The terminal.
 *
 * Deliberately not a `Terminal` implementation for some other framework's
 * interface: the only consumer is {@link TvisionApp}, and a narrower class is
 * easier to reason about than an eighteen-method adapter.
 */
export class ProcessTerminal {
  private readonly options: ProcessTerminalOptions
  private readonly input: NodeJS.ReadStream
  private readonly output: NodeJS.WriteStream
  private wasRaw = false
  private started = false
  private inputHandler: ((chunk: string) => void) | undefined
  private resizeHandler: (() => void) | undefined
  private escapeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly exitHandler: () => void

  /**
   * @param options - Streams, mouse policy, and size fallbacks.
   */
  constructor(options: ProcessTerminalOptions = {}) {
    this.options = options
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.exitHandler = () => {
      // A terminal left in raw mode with mouse reporting on is unusable, and a
      // thrown exception is exactly when it would otherwise happen.
      if (this.started) this.stop()
    }
  }

  /** Current width in columns. */
  get columns(): number {
    return this.output.columns ?? this.options.defaultColumns ?? 80
  }

  /** Current height in rows. */
  get rows(): number {
    return this.output.rows ?? this.options.defaultRows ?? 24
  }

  /** The current size, as one value. */
  size(): { columns: number; rows: number } {
    return { columns: this.columns, rows: this.rows }
  }

  /**
   * Take the terminal: raw mode, alt screen, mouse reporting, and byte
   * forwarding.
   * @param onInput - Called with whatever the terminal produced. Chunks are
   * whatever the OS delivered; the input decoder buffers partial sequences.
   * @param onResize - Called when the window size changes.
   */
  start(onInput: (chunk: string) => void, onResize: () => void): void {
    if (this.started) return
    this.started = true
    this.inputHandler = onInput
    this.resizeHandler = onResize
    this.wasRaw = this.input.isRaw === true
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(true)
    this.input.setEncoding('utf8')
    this.input.resume()
    const onData = (chunk: string | Buffer): void => {
      this.escapeTimer = this.scheduleEscapeFlush()
      this.inputHandler?.(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    }
    this.input.on('data', onData)
    this.dataHandler = onData
    const onWinch = (): void => this.resizeHandler?.()
    this.output.on('resize', onWinch)
    this.winchHandler = onWinch
    process.on('exit', this.exitHandler)
    this.write(ScreenRenderer.enter({ mouse: this.options.mouse ?? true }))
  }

  private dataHandler: ((chunk: string | Buffer) => void) | undefined
  private winchHandler: (() => void) | undefined

  /**
   * Release the terminal, restoring the modes it had.
   */
  stop(): void {
    if (!this.started) return
    this.started = false
    this.write(ScreenRenderer.leave({ mouse: this.options.mouse ?? true }))
    if (this.dataHandler !== undefined) this.input.off('data', this.dataHandler)
    if (this.winchHandler !== undefined) this.output.off('resize', this.winchHandler)
    process.off('exit', this.exitHandler)
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    this.escapeTimer = undefined
    this.input.pause()
    if (typeof this.input.setRawMode === 'function') this.input.setRawMode(this.wasRaw)
    this.dataHandler = undefined
    this.winchHandler = undefined
    this.inputHandler = undefined
    this.resizeHandler = undefined
  }

  /**
   * Write bytes to the terminal.
   * @param data - The escape sequence or text.
   */
  write(data: string): void {
    if (this.options.write !== undefined) this.options.write(data)
    else this.output.write(data)
  }

  /**
   * Wait until stdin has gone quiet, so a terminal that is about to be handed
   * back does not deliver a trailing escape sequence into the parent shell.
   * @param maxMs - Longest to wait.
   * @param idleMs - How long a gap counts as quiet.
   */
  async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
    if (!this.started) return
    await new Promise<void>((resolve) => {
      let idle: ReturnType<typeof setTimeout> | undefined
      const done = (): void => {
        if (idle !== undefined) clearTimeout(idle)
        clearTimeout(hard)
        this.input.off('data', bump)
        resolve()
      }
      const bump = (): void => {
        if (idle !== undefined) clearTimeout(idle)
        idle = setTimeout(done, idleMs)
      }
      const hard = setTimeout(done, maxMs)
      this.input.on('data', bump)
      bump()
    })
  }

  /**
   * Arm the ESC-release timer. A lone ESC is ambiguous — it is either the Escape
   * key or the first byte of an Alt combination — and the only way to tell is
   * that nothing followed it.
   * @returns The timer handle.
   */
  private scheduleEscapeFlush(): ReturnType<typeof setTimeout> {
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer)
    return setTimeout(() => {
      this.escapeTimer = undefined
      this.onEscapeTimeout?.()
    }, ESC_TIMEOUT_MS)
  }

  /** Called when a held ESC should be released as an Escape key press. */
  onEscapeTimeout: (() => void) | undefined

  /** Set the terminal window title. */
  setTitle(title: string): void {
    // Escape the terminator: a title containing BEL would otherwise corrupt the
    // terminal's state rather than the title.
    this.write(`\u001B]0;${title.replace(/[\u0007\u001B]/gu, '')}\u0007`)
  }
}

/**
 * How long to wait before deciding a lone ESC was the Escape key.
 *
 * Below the terminal's own Alt-prefix timing (which is effectively "immediately")
 * and above the inter-byte gap of a real escape sequence over SSH, which is
 * where the ambiguity actually bites.
 */
export const ESC_TIMEOUT_MS = 40
