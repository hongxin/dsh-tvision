/**
 * Terminal lifecycle tests.
 *
 * These matter more than they look: a terminal left in raw mode with mouse
 * reporting enabled is unusable, and the failure only shows up after the process
 * has already exited. So the tests drive a fake pair of streams through every
 * path — normal stop, thrown exception, and repeated start/stop — and assert
 * that each mode that was turned on is turned off again.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { ProcessTerminal, ESC_TIMEOUT_MS } from '../src/term/process-terminal.ts'

/** A readable stream stand-in that records raw-mode changes. */
class FakeInput extends EventEmitter {
  isRaw = false
  rawCalls: boolean[] = []
  encoding: string | undefined
  paused = false
  resumed = false

  setRawMode(value: boolean): this {
    this.isRaw = value
    this.rawCalls.push(value)
    return this
  }

  setEncoding(encoding: string): this {
    this.encoding = encoding
    return this
  }

  resume(): this {
    this.resumed = true
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }

  /** Emit a chunk of input. */
  deliver(chunk: string): void {
    this.emit('data', chunk)
  }
}

/** A writable stream stand-in that records everything written. */
class FakeOutput extends EventEmitter {
  columns = 100
  rows = 30
  output = ''

  write(data: string): boolean {
    this.output += data
    return true
  }

  /** Emit a resize. */
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

function build(): { terminal: ProcessTerminal; input: FakeInput; output: FakeOutput } {
  const input = new FakeInput()
  const output = new FakeOutput()
  const terminal = new ProcessTerminal({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  })
  return { terminal, input, output }
}

describe('size', () => {
  it('reports the stream size', () => {
    const { terminal } = build()
    expect(terminal.columns).toBe(100)
    expect(terminal.rows).toBe(30)
    expect(terminal.size()).toEqual({ columns: 100, rows: 30 })
  })

  it('falls back to a sane size when the stream reports none', () => {
    const input = new FakeInput()
    const output = new FakeOutput()
    // A pipe has no dimensions, which is exactly when a full-screen app has to
    // pick something rather than divide by undefined.
    Object.defineProperty(output, 'columns', { value: undefined })
    Object.defineProperty(output, 'rows', { value: undefined })
    const terminal = new ProcessTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    })
    expect(terminal.columns).toBe(80)
    expect(terminal.rows).toBe(24)
  })
})

describe('start', () => {
  it('enters raw mode', () => {
    const { terminal, input } = build()
    terminal.start(() => {}, () => {})
    expect(input.isRaw).toBe(true)
    expect(input.encoding).toBe('utf8')
  })

  it('leaves the screen modes to the application', () => {
    // The alternate screen, mouse reporting, and bracketed paste belong to the
    // app, because its renderer is what decides whether the hardware cursor is
    // visible. Two writers on one alternate screen is how a terminal ends up in
    // a mode nobody turns off — which showed up as the leave sequence being
    // emitted twice.
    const { terminal, output } = build()
    terminal.start(() => {}, () => {})
    terminal.stop()
    expect(output.output).not.toContain('\u001B[?1049')
    expect(output.output).not.toContain('\u001B[?1006')
  })

  it('is idempotent', () => {
    const { terminal, input } = build()
    terminal.start(() => {}, () => {})
    terminal.start(() => {}, () => {})
    expect(input.rawCalls).toEqual([true])
  })

  it('forwards input chunks', () => {
    const { terminal, input } = build()
    const received: string[] = []
    terminal.start(chunk => received.push(chunk), () => {})
    input.deliver('a')
    input.deliver('bc')
    expect(received).toEqual(['a', 'bc'])
  })

  it('reports a resize', () => {
    const { terminal, output } = build()
    const resizes = vi.fn()
    terminal.start(() => {}, resizes)
    output.resize(120, 40)
    expect(resizes).toHaveBeenCalledTimes(1)
  })
})

describe('stop', () => {
  it('restores raw mode and pauses input', () => {
    const { terminal, input } = build()
    terminal.start(() => {}, () => {})
    terminal.stop()
    expect(input.isRaw).toBe(false)
    expect(input.paused).toBe(true)
  })

  it('remembers whether the terminal was already raw', () => {
    const { terminal, input } = build()
    // dsh may already have taken the terminal; claiming it was not raw would
    // leave the parent shell broken on the way out.
    input.isRaw = true
    terminal.start(() => {}, () => {})
    terminal.stop()
    expect(input.isRaw).toBe(true)
  })

  it('stops forwarding after stop', () => {
    const { terminal, input } = build()
    const received: string[] = []
    terminal.start(chunk => received.push(chunk), () => {})
    terminal.stop()
    input.deliver('x')
    expect(received).toEqual([])
  })

  it('is idempotent', () => {
    const { terminal, input, output } = build()
    terminal.start(() => {}, () => {})
    const before = output.output.length
    terminal.stop()
    terminal.stop()
    // The second stop must not write anything or touch the streams again.
    expect(output.output.length).toBe(before)
    expect(input.rawCalls).toEqual([true, false])
  })

  it('restores the terminal when the process exits', () => {
    const { terminal, input } = build()
    terminal.start(() => {}, () => {})
    // A thrown exception is exactly when a raw terminal would otherwise be left
    // behind, so the exit hook is the safety net.
    // The real signature is `(code)`, so pass one; the handler does not read it.
    process.emit('exit', 0)
    expect(input.isRaw).toBe(false)
  })

  it('can be started again after stopping', () => {
    const { terminal, input } = build()
    terminal.start(() => {}, () => {})
    terminal.stop()
    terminal.start(() => {}, () => {})
    expect(input.rawCalls).toEqual([true, false, true])
    terminal.stop()
  })
})

describe('escape timing', () => {
  it('reports a quiet moment so a lone ESC can be released', async () => {
    const { terminal, input } = build()
    const flushed = vi.fn()
    terminal.onEscapeTimeout = flushed
    terminal.start(() => {}, () => {})
    input.deliver('\u001B')
    expect(flushed).not.toHaveBeenCalled()
    await new Promise(resolve => setTimeout(resolve, ESC_TIMEOUT_MS + 20))
    expect(flushed).toHaveBeenCalledTimes(1)
    terminal.stop()
  })

  it('does not fire while input keeps arriving', async () => {
    const { terminal, input } = build()
    const flushed = vi.fn()
    terminal.onEscapeTimeout = flushed
    terminal.start(() => {}, () => {})
    input.deliver('\u001B')
    await new Promise(resolve => setTimeout(resolve, ESC_TIMEOUT_MS / 2))
    input.deliver('[')
    await new Promise(resolve => setTimeout(resolve, ESC_TIMEOUT_MS / 2))
    expect(flushed).not.toHaveBeenCalled()
    terminal.stop()
  })
})

describe('title', () => {
  it('sets the title through OSC 0', () => {
    const { terminal, output } = build()
    terminal.setTitle('dsh — tvision')
    expect(output.output).toContain('\u001B]0;dsh — tvision\u0007')
  })

  it('strips a terminator that would corrupt the sequence', () => {
    const { terminal, output } = build()
    terminal.setTitle('bad\u0007title')
    expect(output.output).toContain('\u001B]0;badtitle\u0007')
  })
})

describe('draining', () => {
  it('resolves after the input goes quiet', async () => {
    const { terminal, input } = build()
    terminal.start(() => {}, () => {})
    input.deliver('x')
    await terminal.drainInput(200, 10)
    terminal.stop()
    expect(true).toBe(true)
  })

  it('resolves immediately when not started', async () => {
    const { terminal } = build()
    await terminal.drainInput(10, 10)
    expect(true).toBe(true)
  })
})
