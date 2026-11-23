/**
 * Copy and paste: the selection, the session clipboard, and OSC 52.
 *
 * The app takes the pointer (mouse reporting is on), which removes the
 * terminal's own drag-select unless the reader holds Shift — so the view owns
 * a selection, Ctrl+C copies it to a session clipboard and offers it to the
 * system clipboard through an OSC 52 write, and Ctrl+V pastes what the session
 * copied. The terminal's native paste (⌘V / Ctrl+Shift+V) keeps arriving as
 * bracketed paste regardless.
 */
import { describe, expect, it } from 'vitest'
import { TvisionApp } from '../src/app/app.ts'
import { TranscriptView } from '../src/views/transcript.ts'
import { SessionDocument } from '../src/session/model.ts'
import { CellBuffer, rect } from '../src/kit/cell.ts'
import { Painter } from '../src/kit/painter.ts'
import { Consumed, type MouseEvent, type WidgetContext } from '../src/kit/widget.ts'
import { TURBO_VISION, resolvePalette } from '../src/kit/skin.ts'

const palette = resolvePalette(TURBO_VISION)

const press = (x: number, y: number): MouseEvent =>
  ({ x, y, kind: 'press', button: 'left' })
const drag = (x: number, y: number): MouseEvent =>
  ({ x, y, kind: 'drag', button: 'left' })
const release = (x: number, y: number): MouseEvent =>
  ({ x, y, kind: 'release', button: 'left' })

describe('the transcript selection', () => {
  function viewWith(text: string): { view: TranscriptView; document: SessionDocument } {
    const document = new SessionDocument()
    document.addUser(text, 1)
    document.beginAssistant({ turn: 1, step: 1 }, 1)
    document.streamChunk({ turn: 1, step: 1 }, { kind: 'text', text: 'the reply' }, 2)
    document.settleAssistant({ turn: 1, step: 1 }, [{ kind: 'text', text: 'the reply' }], 3)
    const theme = { gutterWidth: 2, collapsed: true, showReasoning: true }
    const view = new TranscriptView(document, theme)
    const buffer = new CellBuffer(40, 12)
    view.draw(new Painter(buffer, rect(0, 0, 40, 12)), {
      palette, focused: true, requestRender: () => {},
    } satisfies WidgetContext)
    return { view, document }
  }

  it('a drag selects the rows it crossed', () => {
    const { view } = viewWith('one\ntwo\nthree')
    expect(view.onMouse(press(3, 1))).toBe(Consumed.Yes)
    expect(view.onMouse(drag(3, 4))).toBe(Consumed.Yes)
    expect(view.onMouse(release(3, 4))).toBe(Consumed.Yes)
    expect(view.selectionActive).toBe(true)
    const text = view.selectedText() ?? ''
    // The rows between press and release, gutter characters included.
    expect(text.split('\n').length).toBeGreaterThan(2)
    expect(text).toContain('two')
    expect(text).toContain('three')
  })

  it('a click without a drag selects nothing', () => {
    const { view } = viewWith('one two three')
    view.onMouse(press(2, 1))
    view.onMouse(release(2, 1))
    expect(view.selectionActive).toBe(false)
    expect(view.selectedText()).toBeUndefined()
  })

  it('Escape drops the selection', () => {
    const { view } = viewWith('one two three')
    view.onMouse(press(2, 1))
    view.onMouse(drag(10, 1))
    view.onMouse(release(10, 1))
    expect(view.selectionActive).toBe(true)
    view.clearSelection()
    expect(view.selectionActive).toBe(false)
  })

  it('a one-row drag still selects that row', () => {
    const { view } = viewWith('one two three')
    view.onMouse(press(2, 1))
    view.onMouse(drag(10, 1))
    view.onMouse(release(10, 1))
    expect(view.selectionActive).toBe(true)
    expect(view.selectedText()).toContain('one two three')
  })
})

describe('Ctrl+C and Ctrl+V through the app', () => {
  class FakeTerminal {
    columns = 100
    rows = 30
    output = ''
    write(data: string): void { this.output += data }
  }

  function build(): { app: TvisionApp; terminal: FakeTerminal; cancelled: () => number } {
    const terminal = new FakeTerminal()
    let cancelled = 0
    const host = {
      send: () => {},
      cancel: () => { cancelled++ },
      quit: () => {},
      commands: () => [{ name: 'model', description: 'Choose the model route' }],
      files: () => [],
      modelLabel: () => 'deepseek-official/deepseek-flash',
      contextWindow: () => 128_000,
    }
    const app = new TvisionApp({
      terminal: terminal as never,
      host: host as never,
      info: { name: 'tvision', version: '0.0.0', sessionId: 'main-session-test', cwd: '/tmp/ws' },
      skin: TURBO_VISION,
    })
    return { app, terminal, cancelled: () => cancelled }
  }

  /** A settled two-line user turn on screen, then a selection over it. */
  function selectTranscript(app: TvisionApp): void {
    app.composer.insert('alpha beta gamma')
    app.composer.onKey({ type: 'key', key: 'enter' })
    app.frame()
    // SGR-mouse press, drag, release over the transcript body: the first
    // content rows sit a couple of rows below the window's top frame.
    app.feed('\u001B[<0;5;4M')
    app.feed('\u001B[<32;5;6M')
    app.feed('\u001B[<0;5;6m')
  }

  it('Ctrl+C with a selection copies instead of cancelling, and broadcasts OSC 52', () => {
    const { app, terminal, cancelled } = build()
    app.start()
    selectTranscript(app)
    const before = cancelled()
    app.feed('\u0003')
    expect(cancelled()).toBe(before)
    expect(terminal.output).toContain('\u001B]52;c;')
  })

  it('Ctrl+C without a selection still cancels the turn', () => {
    const { app, cancelled } = build()
    app.start()
    app.frame()
    app.feed('\u0003')
    expect(cancelled()).toBe(1)
  })

  it('Ctrl+V pastes the session clipboard into the composer', () => {
    const { app } = build()
    app.start()
    selectTranscript(app)
    app.feed('\u0003')
    app.feed('\u0016')
    expect(app.composer.value).not.toBe('')
  })

  it('Ctrl+V with an empty session clipboard says so and touches nothing', () => {
    const { app } = build()
    app.start()
    app.frame()
    app.feed('\u0016')
    expect(app.composer.value).toBe('')
  })
})
