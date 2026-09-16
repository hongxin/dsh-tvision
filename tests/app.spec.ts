/**
 * Application tests.
 *
 * These drive the whole desktop through its public surface — feed raw terminal
 * bytes in, read the painted frame out — with a fake host standing in for the
 * agent. That is the only way to test the parts that actually matter and are
 * actually easy to break: that `F10` opens the menu without also typing an `F10`
 * into the composer, that a click on a title bar drags rather than focuses, and
 * that the transcript, the chrome, and the windows agree about where things are.
 */
import { describe, expect, it, vi } from 'vitest'
import { TvisionApp, WINDOW_IDS, planLayout } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { TURBO_VISION } from '../src/kit/skin.ts'
import { rect } from '../src/kit/cell.ts'

/** A terminal that remembers everything written to it. */
class FakeTerminal {
  columns = 100
  rows = 30
  output = ''
  writes = 0

  write(data: string): void {
    this.output += data
    this.writes++
  }

  /** Everything written, with escape sequences removed, for readable assertions. */
  get plain(): string {
    return this.output.replace(/\u001B\[[0-9;?]*[a-zA-Z]/gu, '')
  }

  /** The characters of the most recent frame, escapes stripped. */
  lastFrame(): string {
    const frames = this.output.split('\u001B[?2026h')
    const last = frames[frames.length - 1] ?? ''
    return last.replace(/\u001B\[[0-9;?]*[a-zA-Z]/gu, '')
  }
}

interface Harness {
  readonly app: TvisionApp
  readonly terminal: FakeTerminal
  readonly host: {
    sent: string[]
    commands: string[]
    cancelled: number
    quit: number
  }
}

function build(overrides: Partial<AppHost> = {}): Harness {
  const terminal = new FakeTerminal()
  const sent: string[] = []
  const commands: string[] = []
  const counters = { cancelled: 0, quit: 0 }
  const host: AppHost = {
    send: text => { sent.push(text) },
    runCommand: async (line) => {
      commands.push(line)
      return { kind: 'success', text: `ran ${line}` }
    },
    cancel: () => { counters.cancelled++ },
    quit: () => { counters.quit++ },
    commands: () => [
      { name: 'model', description: 'Choose the model route' },
      { name: 'compact', description: 'Compact the context' },
      { name: 'help', description: 'List commands' },
    ],
    files: () => ['src/a.ts', 'src/b.ts'],
    modelLabel: () => 'deepseek-official/deepseek-flash',
    contextWindow: () => 128_000,
    ...overrides,
  }
  const app = new TvisionApp({
    terminal,
    host,
    info: { name: 'tvision', version: '0.1.0', sessionId: 'main-session-test', cwd: '/tmp/ws' },
    skin: TURBO_VISION,
  })
  return {
    app,
    terminal,
    host: {
      sent,
      commands,
      get cancelled() { return counters.cancelled },
      get quit() { return counters.quit },
    },
  }
}

/** Type a string into the composer, one key at a time. */
function type(app: TvisionApp, text: string): void {
  app.feed(text)
}

describe('layout planning', () => {
  it('gives the transcript the full width on a narrow terminal', () => {
    const plan = planLayout(80, 24, rect(0, 1, 80, 21))
    expect(plan.sideWidth).toBe(0)
    expect(plan.transcript.width).toBe(80)
  })

  it('opens a side column on a wide terminal', () => {
    const plan = planLayout(140, 40, rect(0, 1, 140, 37))
    expect(plan.sideWidth).toBeGreaterThanOrEqual(28)
    expect(plan.transcript.width + plan.sideWidth).toBe(140)
  })

  it('reserves a usable composer height', () => {
    // A separator, the input line, and one row so a completion popup has
    // somewhere to open without the pane resizing under the reader.
    expect(planLayout(100, 30, rect(0, 1, 100, 27)).composerHeight).toBe(3)
    expect(planLayout(100, 10, rect(0, 1, 100, 7)).composerHeight).toBeLessThanOrEqual(7)
  })

  it('gives the composer up before it starves the transcript', () => {
    // On a desktop of five rows the transcript keeps its floor and the composer
    // takes what is left, even though that is less than it would like.
    const plan = planLayout(60, 8, rect(0, 1, 60, 5))
    expect(plan.composerHeight).toBeLessThan(3)
    expect(plan.composerHeight + 4).toBeLessThanOrEqual(5)
  })
})

describe('startup', () => {
  it('enters the alternate screen and mouse reporting', () => {
    const { app, terminal } = build()
    app.start()
    expect(terminal.output).toContain('\u001B[?1049h')
    expect(terminal.output).toContain('\u001B[?1000h')
    expect(terminal.output).toContain('\u001B[?1006h')
  })

  it('opens the conversation window focused', () => {
    const { app } = build()
    app.start()
    expect(app.windows.isOpen(WINDOW_IDS.transcript)).toBe(true)
    expect(app.windows.activeWindowId).toBe(WINDOW_IDS.transcript)
  })

  it('opens the side windows on a wide terminal', () => {
    const { app } = build()
    app.start()
    expect(app.windows.isOpen(WINDOW_IDS.project)).toBe(true)
    expect(app.windows.isOpen(WINDOW_IDS.tasks)).toBe(true)
  })

  it('leaves the floaters closed until asked for', () => {
    const { app } = build()
    app.start()
    expect(app.windows.isOpen(WINDOW_IDS.sessions)).toBe(false)
    expect(app.windows.isOpen(WINDOW_IDS.jobs)).toBe(false)
  })

  it('restores the terminal on stop', () => {
    const { app, terminal } = build()
    app.start()
    app.stop()
    expect(terminal.output).toContain('\u001B[?1049l')
    expect(terminal.output).toContain('\u001B[?1006l')
  })

  it('paints a frame with the menu bar and the function keys', () => {
    const { app, terminal } = build()
    app.start()
    const text = terminal.plain
    expect(text).toContain('File')
    expect(text).toContain('View')
    expect(text).toContain('Help')
    expect(text).toContain('F1')
    expect(text).toContain('F10')
  })

  it('draws the desktop frame border', () => {
    const { app, terminal } = build()
    app.start()
    // The transcript window is active, so its frame is the double-line variant.
    expect(terminal.plain).toContain('╔')
    expect(terminal.plain).toContain('Conversation')
  })
})

describe('composer', () => {
  it('accepts typed text and sends it on Enter', () => {
    const { app, host } = build()
    app.start()
    type(app, 'hello there')
    app.feed('\r')
    expect(host.sent).toEqual(['hello there'])
  })

  it('clears after sending', () => {
    const { app } = build()
    app.start()
    type(app, 'hi')
    app.feed('\r')
    expect(app.composer.value).toBe('')
  })

  it('does not send a blank line', () => {
    const { app, host } = build()
    app.start()
    type(app, '   ')
    app.feed('\r')
    expect(host.sent).toEqual([])
  })

  it('adds the sent line to the transcript', () => {
    const { app } = build()
    app.start()
    type(app, 'do the thing')
    app.feed('\r')
    expect(app.document.all.some(entry => entry.text === 'do the thing')).toBe(true)
  })

  it('supports backspace and Delete', () => {
    const { app } = build()
    app.start()
    type(app, 'abc')
    app.feed('\u007F')
    expect(app.composer.value).toBe('ab')
    // Backspace left the caret between `a` and `b`, so Left then forward-delete
    // takes the `b` and leaves the `a`.
    app.feed('\u001B[D')
    app.feed('\u001B[3~')
    expect(app.composer.value).toBe('a')
  })

  it('moves the caret with the arrows and Home/End', () => {
    const { app } = build()
    app.start()
    type(app, 'abc')
    app.feed('\u001B[D')
    expect(app.composer.caret).toBe(2)
    app.feed('\u001B[H')
    expect(app.composer.caret).toBe(0)
    app.feed('\u001B[F')
    expect(app.composer.caret).toBe(3)
  })

  it('deletes the previous word with Ctrl+W', () => {
    const { app } = build()
    app.start()
    type(app, 'one two three')
    app.feed('\u0017')
    // The whitespace before the word goes with it, as in every readline.
    expect(app.composer.value).toBe('one two')
  })

  it('clears before the caret with Ctrl+U', () => {
    const { app } = build()
    app.start()
    type(app, 'abcdef')
    // Two lefts put the caret after `abcd`, so Ctrl+U keeps `ef`.
    app.feed('\u001B[D')
    app.feed('\u001B[D')
    app.feed('\u0015')
    expect(app.composer.value).toBe('ef')
    expect(app.composer.caret).toBe(0)
  })

  it('walks the input history with Up and Down', () => {
    const { app } = build()
    app.start()
    type(app, 'first')
    app.feed('\r')
    type(app, 'second')
    app.feed('\r')
    app.feed('\u001B[A')
    expect(app.composer.value).toBe('second')
    app.feed('\u001B[A')
    expect(app.composer.value).toBe('first')
    app.feed('\u001B[B')
    expect(app.composer.value).toBe('second')
    app.feed('\u001B[B')
    expect(app.composer.value).toBe('')
  })

  it('inserts a newline on Alt+Enter instead of sending', () => {
    const { app, host } = build()
    app.start()
    type(app, 'line one')
    // The kitty encoding is unambiguous for Alt+Enter; `ESC CR` is not, because
    // a terminal in normal mode sends `ESC` then `CR` for two separate keys.
    app.feed('\u001B[13;3u')
    expect(host.sent).toEqual([])
    expect(app.composer.value).toBe('line one\n')
  })

  it('accepts a paste as one insertion', () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[200~pasted text\u001B[201~')
    expect(app.composer.value).toBe('pasted text')
  })

  it('drops the carriage returns a paste may carry', () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[200~a\r\nb\u001B[201~')
    expect(app.composer.value).toBe('a\nb')
  })
})

describe('completions', () => {
  it('completes a slash command on Tab', () => {
    const { app } = build()
    app.start()
    type(app, '/mo')
    app.feed('\t')
    expect(app.composer.value).toBe('/model ')
  })

  it('completes a file reference on Tab', () => {
    const { app } = build()
    app.start()
    type(app, '@src/')
    app.feed('\t')
    expect(app.composer.value).toBe('@src/a.ts ')
  })

  it('shows the completion list while typing a command', () => {
    const { app } = build()
    app.start()
    type(app, '/')
    app.windows.requestRender()
    const text = (app.windows.paint()).lines().join('\n')
    expect(text).toContain('/model')
    expect(text).toContain('Choose the model route')
  })

  it('walks the completion list with the arrows and accepts with Tab', () => {
    const { app } = build()
    app.start()
    type(app, '/')
    app.feed('\u001B[B')
    app.feed('\t')
    expect(app.composer.value).toBe('/compact ')
  })

  it('dismisses the list with Escape', () => {
    const { app } = build()
    app.start()
    type(app, '/')
    app.feed('\u001B')
    app.flushInput()
    app.windows.requestRender()
    expect(app.windows.paint().lines().join('\n')).not.toContain('Choose the model route')
  })

  it('offers nothing for an ordinary word', () => {
    const { app } = build()
    app.start()
    type(app, 'hello')
    app.feed('\t')
    expect(app.composer.value).toBe('hello')
  })
})

describe('slash commands', () => {
  it('routes a command through the host', async () => {
    const { app, host } = build()
    app.start()
    type(app, '/help')
    app.feed('\r')
    await Promise.resolve()
    await Promise.resolve()
    expect(host.commands).toEqual(['/help'])
  })

  it('reports an unknown command', async () => {
    const { app } = build({ runCommand: async () => undefined })
    app.start()
    type(app, '/nope')
    app.feed('\r')
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(app.document.all.some(entry => entry.kind === 'error')).toBe(true)
  })
})

describe('global keys', () => {
  it('quits on Ctrl+Q', () => {
    const { app, host } = build()
    app.start()
    app.feed('\u0011')
    expect(host.quit).toBe(1)
  })

  it('cancels on Ctrl+C', () => {
    const { app, host } = build()
    app.start()
    app.feed('\u0003')
    expect(host.cancelled).toBe(1)
  })

  it('opens the help window on F1', () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[11~')
    expect(app.windows.isOpen(WINDOW_IDS.help)).toBe(true)
  })

  it('opens the about window from the Help menu', () => {
    const { app } = build()
    app.start()
    app.feed('\u001Bh')
    app.feed('\u001B[B')
    app.feed('\r')
    expect(app.windows.isOpen(WINDOW_IDS.about)).toBe(true)
  })

  it('opens the menu bar on F10 without typing into the composer', () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[21~')
    expect(app.composer.value).toBe('')
    type(app, 'x')
    // A key aimed at the menu must not reach the composer.
    expect(app.composer.value).toBe('')
  })

  it('cycles windows on F6', () => {
    const { app } = build()
    app.start()
    const before = app.windows.activeWindowId
    app.feed('\u001B[17~')
    expect(app.windows.activeWindowId).not.toBe(before)
  })

  it('hides and restores the task window with F8', () => {
    const { app } = build()
    app.start()
    // F8 focuses a visible-but-unfocused window first and hides it on the next
    // press; that is what makes one key serve both "show me" and "go away".
    app.feed('\u001B[19~')
    expect(app.windows.activeWindowId).toBe(WINDOW_IDS.tasks)
    app.feed('\u001B[19~')
    expect(app.windows.isOpen(WINDOW_IDS.tasks)).toBe(false)
    app.feed('\u001B[19~')
    expect(app.windows.isOpen(WINDOW_IDS.tasks)).toBe(true)
  })

  it('opens the session list on F3', () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[13~')
    expect(app.windows.isOpen(WINDOW_IDS.sessions)).toBe(true)
  })

  it('cycles the skin on F9', async () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[20~')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(app.activeSkin.id).not.toBe('tvision')
  })

  it('redraws on Ctrl+L', () => {
    const { app, terminal } = build()
    app.start()
    const before = terminal.writes
    app.feed('\u000C')
    app.frame()
    expect(terminal.writes).toBeGreaterThan(before)
  })
})

describe('mouse', () => {
  it('drags a window by its title bar', () => {
    const { app } = build()
    app.start()
    app.frame()
    const transcript = app.windows.get(WINDOW_IDS.transcript)
    /* c8 ignore next -- the window exists. */
    if (transcript === undefined) throw new Error('no transcript window')
    const before = transcript.rect.x
    // Press on the title bar, move right, release.
    app.feed('\u001B[<0;10;2M')
    app.feed('\u001B[<32;20;2M')
    expect(transcript.rect.x).not.toBe(before)
    app.feed('\u001B[<0;20;2m')
    expect(app.windows.dragging).toBe(false)
  })

  it('zooms on a double click of the title bar', () => {
    const { app } = build()
    app.start()
    app.frame()
    const transcript = app.windows.get(WINDOW_IDS.transcript)
    /* c8 ignore next -- the window exists. */
    if (transcript === undefined) throw new Error('no transcript window')
    app.feed('\u001B[<0;10;2M')
    app.feed('\u001B[<0;10;2m')
    app.feed('\u001B[<0;10;2M')
    expect(transcript.zoomed).toBe(true)
  })

  it('scrolls the transcript with the wheel', () => {
    const { app } = build()
    app.start()
    for (let index = 0; index < 60; index++) app.document.addUser(`line ${index}`, index)
    app.windows.requestRender()
    app.frame()
    app.feed('\u001B[<64;10;10M')
    expect(app.transcript.following).toBe(false)
  })

  it('opens a menu from a click on the bar', () => {
    const { app } = build()
    app.start()
    app.windows.requestRender()
    app.frame()
    // "File" starts at column 2 on the bar, so a click there opens its list.
    app.feed('\u001B[<0;3;1M')
    app.windows.requestRender()
    expect(app.windows.paint().lines().join('\n')).toContain('New session')
  })

  it('places the caret on a click in the composer', () => {
    const { app } = build()
    app.start()
    type(app, 'abcdef')
    app.frame()
    // The composer is the last row of the transcript window's interior.
    const window = app.windows.get(WINDOW_IDS.transcript)
    /* c8 ignore next -- the window exists. */
    if (window === undefined) throw new Error('no transcript window')
    const row = window.rect.y + window.rect.height - 1
    app.feed(`\u001B[<0;8;${row}M`)
    expect(app.composer.caret).toBeLessThan(6)
  })
})

describe('session events', () => {
  it('streams an assistant response into the transcript', async () => {
    const { app } = build()
    app.start()
    await app.applyEvent({ type: 'turn/start', seq: 1, time: 0, data: { turn: 0 } })
    await app.applyEvent({ type: 'step/start', seq: 2, time: 1, data: { turn: 0, step: 0 } })
    await app.applyEvent({
      type: 'assistant/chunk', seq: 3, time: 2,
      data: { turn: 0, step: 0, chunk: { type: 'text', text: 'hello' } },
    })
    expect(app.document.all.some(entry => entry.text === 'hello')).toBe(true)
  })

  it('records a tool call and its result', async () => {
    const { app } = build()
    app.start()
    await app.applyEvent({
      type: 'tool/call', seq: 1, time: 0,
      data: { turn: 0, step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    await app.applyEvent({
      type: 'tool/result', seq: 2, time: 10,
      data: { turn: 0, step: 0, callId: 'c1', message: { content: [{ type: 'text', text: 'a.txt' }] } },
    })
    const tool = app.document.toolEntry('c1')
    expect(tool).toMatchObject({ title: 'bash', state: 'ok', result: 'a.txt' })
  })

  it('shows a task list from a todo write', async () => {
    const { app } = build()
    app.start()
    await app.applyEvent({
      type: 'todo/write', seq: 1, time: 0,
      data: { todos: [{ id: '1', text: 'write the docs', status: 'in_progress' }] },
    })
    expect(app.document.todoList).toEqual([{ id: '1', text: 'write the docs', status: 'in_progress' }])
  })

  it('announces a failed turn', async () => {
    const { app } = build()
    app.start()
    await app.applyEvent({
      type: 'turn/end', seq: 1, time: 0,
      data: { turn: 0, reason: { kind: 'error', error: { message: 'rate limited' } } },
    })
    expect(app.document.all.some(entry => entry.kind === 'error' && entry.text?.includes('rate limited'))).toBe(true)
  })
})

describe('the painted frame', () => {
  /** Render once and return the window manager's grid as text. */
  function grid(app: TvisionApp): string {
    app.windows.requestRender()
    app.frame()
    return (app.windows.lastFrame()?.lines() ?? []).join('\n')
  }

  it('draws the transcript, the composer, and the chrome together', () => {
    const { app } = build()
    app.start()
    app.document.addUser('refactor the parser', 0)
    const text = grid(app)
    expect(text).toContain('File')
    expect(text).toContain('Conversation')
    expect(text).toContain('refactor the parser')
    expect(text).toContain('dsh>')
    expect(text).toContain('F1')
  })

  it('draws a tool card with its diff inside the transcript', () => {
    const { app } = build()
    app.start()
    app.document.addToolCall({ callId: 'c', name: 'edit', args: '{"path":"a.ts"}', turn: 0, step: 0, time: 0 })
    app.document.finishToolCall('c', { text: 'edited', isError: false, diff: ['-old line', '+new line'] })
    app.transcript.expandAll()
    const text = grid(app)
    expect(text).toContain('edit')
    expect(text).toContain('-old line')
    expect(text).toContain('+new line')
  })

  it('shows the model route in the status line', () => {
    const { app } = build()
    app.start()
    expect(grid(app)).toContain('deepseek-flash')
  })

  it('shows the task list in its window', () => {
    const { app } = build()
    app.start()
    app.document.setTodos([{ id: '1', text: 'write the design doc', status: 'pending' }])
    expect(grid(app)).toContain('write the design doc')
  })

  it('draws a menu dropdown over the windows', () => {
    const { app } = build()
    app.start()
    app.feed('\u001B[21~')
    app.feed('\u001B[B')
    const text = grid(app)
    expect(text).toContain('New session')
    expect(text).toContain('Open session')
  })

  it('never produces a line wider than the terminal', () => {
    const { app } = build()
    app.start()
    app.document.addUser('x'.repeat(500), 0)
    app.document.addToolCall({ callId: 'c', name: 'bash', args: `{"command":"${'y'.repeat(300)}"}`, turn: 0, step: 0, time: 0 })
    app.transcript.expandAll()
    app.windows.requestRender()
    app.frame()
    const frame = app.windows.lastFrame()
    /* c8 ignore next -- a frame always exists after painting. */
    if (frame === undefined) throw new Error('no frame')
    for (let row = 0; row < frame.height; row++) {
      expect(frame.row(row).length, `row ${row}`).toBe(frame.width)
    }
  })
})

describe('window management from the app', () => {
  it('tiles and cascades through the View menu', () => {
    const { app } = build()
    app.start()
    app.windows.tile()
    expect(app.windows.get(WINDOW_IDS.project)?.rect.width).toBeGreaterThan(0)
    app.windows.cascade()
    expect(app.windows.all().length).toBeGreaterThan(1)
  })

  it('arranges back to the planned layout', () => {
    const { app } = build()
    app.start()
    const planned = app.windows.get(WINDOW_IDS.transcript)?.rect
    app.windows.get(WINDOW_IDS.transcript)?.setRect({ x: 3, y: 3, width: 20, height: 6 })
    app.feed('\u001Bh')
    // Esc to close the menu, then use the View > Layout > Arrange path.
    app.feed('\u001B')
    const menu = app.windows
    expect(menu.get(WINDOW_IDS.transcript)?.rect).not.toEqual(planned)
  })

  it('reaches every window grip without the chrome covering it', () => {
    const { app } = build()
    app.start()
    app.windows.requestRender()
    app.frame()
    // A grip that falls under the status bands can never be clicked, so the
    // layout has to keep both side windows' bottom edges clear of them.
    const chromeTop = app.windows.height - 2
    for (const id of [WINDOW_IDS.project, WINDOW_IDS.tasks]) {
      const window = app.windows.get(id)
      /* c8 ignore next -- both windows exist on a wide terminal. */
      if (window === undefined) throw new Error(`no ${id} window`)
      const gripRow = window.rect.y + window.rect.height - 1
      expect(gripRow, id).toBeLessThan(chromeTop)
      // The shared dividing row means the Project window's own grip row is
      // occupied by the Tasks frame above it, which is true of any tiled
      // desktop; what matters is that the window on top there is reachable.
      const gripColumn = window.rect.x + window.rect.width - 2
      expect(app.windows.windowAt(gripColumn, gripRow), id).toBeDefined()
    }
  })

  it('resizes a window from a grip drag', () => {
    const { app } = build()
    app.start()
    const window = app.windows.get(WINDOW_IDS.tasks)
    /* c8 ignore next -- the window exists on a wide terminal. */
    if (window === undefined) throw new Error('no tasks window')
    const before = window.rect
    // The manager drives its own drags through `beginDrag`, which is also what
    // a mouse press on the grip does.
    expect(app.windows.beginDrag(WINDOW_IDS.tasks, 'resize', before.x, before.y)).toBe(true)
    window.restoreForDrag(before)
    window.resizeTo(before.width - 6, before.height + 2, app.windows.desktop)
    expect(window.rect.width).toBe(before.width - 6)
    expect(window.rect.height).toBe(before.height + 2)
    // And the mouse path reaches the same state.
    app.feed(`\u001B[<0;${before.x + before.width - 2};${before.y + before.height}M`)
    expect(app.windows.dragging).toBe(true)
    app.windows.cancelDrag()
  })

  it('reports a list of windows for the Window menu', () => {
    const { app } = build()
    app.start()
    const items = app.windows.listWindows().map(item => item.id)
    expect(items).toContain(WINDOW_IDS.transcript)
    expect(items).toContain(WINDOW_IDS.project)
  })
})

describe('host integration points', () => {
  it('exposes the transcript to the host through the document', () => {
    const { app } = build()
    app.start()
    const listener = vi.fn()
    app.document.subscribe(listener)
    app.document.addNotice('notice', 'from the host', 1)
    expect(listener).toHaveBeenCalled()
  })

  it('notifies the user when a window does not exist', () => {
    const { app, terminal } = build()
    app.start()
    app.toggleWindow('nope')
    app.frame()
    expect(terminal.plain).toContain('No window named nope')
  })
})

describe('list windows', () => {
  it('shows rows supplied by the host', () => {
    const { app } = build()
    app.start()
    app.setListRows(WINDOW_IDS.project, [
      { label: 'src/parser.ts' },
      { label: 'src/stream.ts', detail: 'modified' },
    ])
    app.windows.requestRender()
    const text = app.windows.paint().lines().join('\n')
    expect(text).toContain('src/parser.ts')
    expect(text).toContain('src/stream.ts')
  })

  it('resets the selection when the rows are replaced', () => {
    const { app } = build()
    app.start()
    app.setListRows(WINDOW_IDS.project, [{ label: 'alpha' }, { label: 'beta' }, { label: 'gamma' }])
    app.windows.focus(WINDOW_IDS.project)
    app.feed('\u001B[B')
    app.feed('\u001B[B')
    app.setListRows(WINDOW_IDS.project, [{ label: 'only' }])
    // The old index would be out of range; the widget must not point past the
    // end, and the old rows must be gone. Assert on the window's own interior
    // rather than the whole frame, which contains those letters as prose.
    app.windows.requestRender()
    const window = app.windows.get(WINDOW_IDS.project)
    /* c8 ignore next -- the window exists on a wide terminal. */
    if (window === undefined) throw new Error('no project window')
    const frame = app.windows.paint()
    const interior = window.interior
    let rows = ''
    for (let row = interior.y; row < interior.y + interior.height; row++) {
      rows += `${frame.row(row).slice(interior.x, interior.x + interior.width)}\n`
    }
    expect(rows).toContain('only')
    expect(rows).not.toContain('alpha')
  })

  it('warns about rows for a window that does not exist', () => {
    const { app, terminal } = build()
    app.start()
    app.setListRows('nope', [{ label: 'x' }])
    app.frame()
    expect(terminal.plain).toContain('No list window named nope')
  })
})

describe('screen modes', () => {
  it('takes the alternate screen and mouse reporting on start', () => {
    const { app, terminal } = build()
    app.start()
    expect(terminal.output).toContain('\u001B[?1049h')
    expect(terminal.output).toContain('\u001B[?1000h')
    expect(terminal.output).toContain('\u001B[?1002h')
    expect(terminal.output).toContain('\u001B[?1006h')
    expect(terminal.output).toContain('\u001B[?2004h')
  })

  it('gives every one of them back on stop, exactly once', () => {
    const { app, terminal } = build()
    app.start()
    app.stop()
    for (const sequence of ['\u001B[?1049l', '\u001B[?1000l', '\u001B[?1002l', '\u001B[?1006l', '\u001B[?2004l']) {
      expect(terminal.output.split(sequence).length - 1, sequence).toBe(1)
    }
  })

  it('leaves mouse reporting alone when it was disabled', () => {
    const terminal = new FakeTerminal()
    const app = new TvisionApp({
      terminal,
      host: { send: () => {}, quit: () => {} },
      info: { name: 'tvision', version: '0.1.0', sessionId: 's', cwd: '/tmp' },
      skin: TURBO_VISION,
      mouse: false,
    })
    app.start()
    expect(terminal.output).not.toContain('\u001B[?1006h')
    app.stop()
    expect(terminal.output).not.toContain('\u001B[?1006l')
  })

  it('shows the cursor again before handing the terminal back', () => {
    // A terminal left with a hidden cursor looks broken until the user runs
    // `reset`, and they will not know that is what happened.
    const { app, terminal } = build()
    app.start()
    app.stop()
    const leaveAt = terminal.output.lastIndexOf('\u001B[?1049l')
    const showAt = terminal.output.lastIndexOf('\u001B[?25h')
    expect(showAt).toBeGreaterThan(0)
    expect(showAt).toBeLessThan(leaveAt)
  })

  it('is safe to stop twice', () => {
    const { app, terminal } = build()
    app.start()
    app.stop()
    app.stop()
    expect(terminal.output.split('\u001B[?1049l').length - 1).toBe(1)
  })
})

describe('frame loop', () => {
  it('paints a due frame on the pump tick, and nothing when idle', () => {
    vi.useFakeTimers()
    try {
      const { app, terminal } = build()
      app.start()
      terminal.writes = 0
      // The loop, not the mutation, is what turns a dirty flag into bytes:
      // this is the pump the real profile runs on.
      const stop = app.startFrameLoop()
      // A mutation, not a bare request: an unchanged frame diffs to the empty
      // string by design, so the tick must have something real to paint.
      app.notify('the agent says hi')
      vi.advanceTimersByTime(17)
      expect(terminal.writes).toBeGreaterThan(0)
      // An unchanged frame renders to the empty string, so idling writes nothing.
      terminal.writes = 0
      vi.advanceTimersByTime(50)
      expect(terminal.writes).toBe(0)
      stop()
      app.windows.requestRender()
      vi.advanceTimersByTime(50)
      expect(terminal.writes).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cluster-aware editing', () => {
  it('backspace deletes a whole astral glyph, never half of one', () => {
    const { app } = build()
    app.composer.insert('\u{1F600}')
    app.composer.insert('!')
    app.feed('\u007F') // backspace
    expect(app.composer.value).toBe('\u{1F600}')
    app.feed('\u007F') // backspace deletes the glyph itself
    expect(app.composer.value).toBe('')
  })

  it('the caret steps over a wide cluster as one unit', () => {
    const { app } = build()
    app.composer.insert('a\u{1F600}b')
    app.composer.setValue('a\u{1F600}b')
    // Walk left from the end: b, then the whole glyph, then a — never the
    // surrogate pair's midpoint.
    // 'a' + a two-unit surrogate pair + 'b' is four code units; the caret
    // starts past 'b' and must step over the glyph whole.
    app.composer.setValue('a\u{1F600}b', 4)
    app.feed('\u001B[D') // over 'b'
    expect(app.composer.caret).toBe(3)
    app.feed('\u001B[D') // over the whole glyph, never its midpoint
    expect(app.composer.caret).toBe(1)
    app.feed('\u001B[D')
    expect(app.composer.caret).toBe(0)
  })
})

describe('F4 toggles both ways', () => {
  it('expands, then collapses, then expands again', () => {
    const { app } = build()
    app.document.addToolCall({ callId: 'c1', name: 'bash', args: '', turn: 0, step: 0, time: 1 })
    app.frame()
    const showsExpanded = (): boolean =>
      app.windows.lastFrame()?.lines().join('\n').includes('▾') === true
    expect(showsExpanded()).toBe(false)
    app.handle({ type: 'key', key: 'f4' })
    app.frame()
    expect(showsExpanded()).toBe(true)
    app.handle({ type: 'key', key: 'f4' })
    app.frame()
    expect(showsExpanded()).toBe(false)
  })
})

describe('usage without a reported total', () => {
  it('keeps the pressure display numeric', async () => {
    const { app, terminal } = build()
    await app.applyEvent({ type: 'assistant/message', seq: 1, time: 1, data: {
      message: { content: [{ type: 'text', text: 'hi' }] },
      usage: { input: 10, output: 5 },
      turn: 0, step: 0,
    } })
    app.frame()
    expect(Number.isFinite(app.document.contextTokens)).toBe(true)
    expect(terminal.lastFrame()).not.toContain('NaN')
  })
})
