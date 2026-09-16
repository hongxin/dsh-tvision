/**
 * Integration tests: the whole path, from a scripted agent to cells in a
 * terminal.
 *
 * Everything below the host has already been tested in isolation. What these
 * cover is the seam that only exists when the pieces are assembled — that a
 * streamed answer actually reaches the screen through the document, the view,
 * the compositor, and the renderer; that a resize mid-stream does not corrupt
 * the grid; and that the demo script exercises every card the transcript draws.
 *
 * The terminal here is a real emulator, so a failure means the bytes really do
 * not produce the grid we think they do.
 * @module @dsh-tvision/dsh-tvision/tests/integration
 */

import { describe, expect, it } from 'vitest'
import { TvisionApp } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { findSkin } from '../src/kit/skin.ts'
import { resolvePalette } from '../src/kit/skin.ts'
import { textWidth } from '../src/kit/text.ts'
import { HeadlessTerminal } from './headless-terminal.ts'
import { chunk } from '../src/demo.ts'

/** What a recording host remembers. */
interface HostLog {
  readonly sent: string[]
  cancelCalls: number
  quitCalls: number
}

/**
 * A host that records what it was asked to do.
 * @param log - The record to write into.
 * @returns The host.
 */
function recordingHost(log: HostLog = { sent: [], cancelCalls: 0, quitCalls: 0 }): AppHost & HostLog {
  return {
    sent: log.sent,
    get cancelCalls() { return log.cancelCalls },
    get quitCalls() { return log.quitCalls },
    send: (text) => { log.sent.push(text) },
    runCommand: async () => ({ kind: 'success', text: 'ok' }),
    cancel: () => { log.cancelCalls++ },
    quit: () => { log.quitCalls++ },
    commands: () => [{ name: 'help', description: 'List commands' }],
    modelLabel: () => 'test/model',
    contextWindow: () => 100_000,
  }
}

/** A live app wired to a headless terminal. */
function build(columns = 100, rows = 30, skin = 'tvision') {
  const terminal = new HeadlessTerminal(columns, rows)
  let size = { columns, rows }
  const host = recordingHost()
  const app = new TvisionApp({
    terminal: {
      get columns(): number { return size.columns },
      get rows(): number { return size.rows },
      write: (data: string) => terminal.write(data),
    },
    host,
    info: { name: 'tvision', version: '0.1.0', sessionId: 'it', cwd: '/tmp/ws' },
    skin: findSkin(skin) ?? findSkin('tvision')!,
  })
  return {
    app,
    terminal,
    host,
    resize(nextColumns: number, nextRows: number) {
      size = { columns: nextColumns, rows: nextRows }
      terminal.resize(nextColumns, nextRows)
      app.handle({ type: 'resize', columns: nextColumns, rows: nextRows })
    },
    /** Render and settle, then read the grid back. */
    async paint(): Promise<string> {
      app.windows.requestRender()
      await terminal.writeAndSettle(app.renderForTest())
      return terminal.snapshot().rawRows.map(row => row.replace(/\s+$/u, '')).join('\n')
    },
  }
}

describe('streamed output reaches the screen', () => {
  it('shows a chunk that arrives after the step opens', async () => {
    const view = build()
    view.app.start()
    await view.app.applyEvent({ type: 'step/start', seq: 1, time: 0, data: { turn: 0, step: 0 } })
    await view.app.applyEvent({
      type: 'assistant/chunk',
      seq: 2,
      time: 1,
      data: { turn: 0, step: 0, chunk: { type: 'text', text: 'a streamed answer' } },
    })
    expect(await view.paint()).toContain('a streamed answer')
  })

  it('shows the running indicator while a turn is open', async () => {
    const view = build()
    view.app.start()
    await view.app.applyEvent({ type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 0 } })
    // The sigil carries the elapsed time, so a working agent is visible without
    // the frame changing.
    expect(await view.paint()).toContain('dsh ')
  })

  it('streams a long answer and keeps the frame inside the window', async () => {
    const view = build(90, 24)
    view.app.start()
    await view.app.applyEvent({ type: 'step/start', seq: 1, time: 0, data: { turn: 0, step: 0 } })
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')
    for (const piece of chunk(words, 7)) {
      await view.app.applyEvent({
        type: 'assistant/chunk',
        seq: 2,
        time: 1,
        data: { turn: 0, step: 0, chunk: { type: 'text', text: piece } },
      })
    }
    const frame = await view.paint()
    for (const row of frame.split('\n')) {
      expect(textWidth(row), JSON.stringify(row)).toBeLessThanOrEqual(90)
    }
    // The tail of the answer must be on screen: the view follows the end.
    expect(frame).toContain('word59')
  })

  it('keeps the tail visible after a tool card is appended', async () => {
    const view = build(90, 24)
    view.app.start()
    await view.app.applyEvent({ type: 'step/start', seq: 1, time: 0, data: { turn: 0, step: 0 } })
    await view.app.applyEvent({
      type: 'assistant/chunk',
      seq: 2,
      time: 1,
      data: { turn: 0, step: 0, chunk: { type: 'text', text: 'done with the analysis' } },
    })
    await view.app.applyEvent({
      type: 'tool/call',
      seq: 3,
      time: 2,
      data: { turn: 0, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    })
    const frame = await view.paint()
    expect(frame).toContain('bash')
  })
})

describe('resize', () => {
  it('reflows the desktop and repaints inside the new bounds', async () => {
    const view = build(120, 40)
    view.app.start()
    view.app.document.addUser('a fairly long prompt that will need wrapping at the narrower width', 0)
    await view.paint()
    view.resize(70, 22)
    const frame = await view.paint()
    const rows = frame.split('\n')
    expect(rows.length).toBeLessThanOrEqual(22)
    for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(70)
    // The side column collapses at this width, so the transcript takes it all.
    expect(view.app.windows.isOpen('project')).toBe(true)
    expect(view.app.windows.get('transcript')?.rect.width).toBeGreaterThan(0)
  })

  it('survives a grow back', async () => {
    const view = build(80, 24)
    view.app.start()
    view.resize(160, 48)
    const frame = await view.paint()
    for (const row of frame.split('\n')) expect(textWidth(row)).toBeLessThanOrEqual(160)
    expect(frame).toContain('Conversation')
  })
})

describe('the scripted demo', () => {
  it('splits text into streamable chunks without losing a character', () => {
    const text = 'the quick brown fox'
    expect(chunk(text, 4).join('')).toBe(text)
    expect(chunk('', 4)).toEqual([])
    expect(chunk('a', 4)).toEqual(['a'])
  })

  it('draws every card kind the transcript knows about', async () => {
    const view = build(110, 140)
    view.app.start()
    const document = view.app.document
    document.addUser('why is the first token so slow?', 0)
    document.beginAssistant({ turn: 0, step: 0 }, 1)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'reasoning', text: 'considering the parser' }, 2)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'It buffers everything.\n\n```ts\nyield* drain(buffer)\n```\n' }, 3)
    document.endStep({ turn: 0, step: 0 }, 500)
    const card = document.addToolCall({ callId: 'c1', name: 'edit', args: '{"path":"src/parser.ts"}', turn: 0, step: 1, time: 600 })
    document.finishToolCall('c1', { text: 'Edited', isError: false, diff: ['-old', '+new'] })
    document.update(card.id, { endedAt: 900 })
    document.addToolCall({ callId: 'c2', name: 'bash', args: '{"command":"npm test"}', turn: 0, step: 1, time: 1000 })
    document.finishToolCall('c2', { text: 'Error: 1 failed', isError: true })
    document.setTodos([{ id: '1', text: 'Update the test', status: 'pending' }])
    document.addNotice('notice', 'Script finished.', 1100)
    view.app.transcript.expandAll()
    // Every row the view can produce, so the assertion is about rendering
    // rather than about what happens to be on screen.
    const rendered = view.app.transcript
      .rowsFor(110, resolvePalette(findSkin('tvision')!))
      .map(row => row.text)
      .join('\n')
    expect(rendered).toContain('You')
    expect(rendered).toContain('considering the parser')
    expect(rendered).toContain('It buffers everything.')
    expect(rendered).toContain('+new')
    expect(rendered).toContain('failed')
    expect(rendered).toContain('Script finished.')
    // A tall window, because the question is whether every card *renders*, not
    // which ones fit; scrolling is covered separately.
    const frame = await view.paint()
    expect(frame).toContain('You')
    expect(frame).toContain('considering the parser')
    expect(frame).toContain('It buffers everything.')
    expect(frame).toContain('ts')
    expect(frame).toContain('edit')
    expect(frame).toContain('+new')
    expect(frame).toContain('failed')
    expect(frame).toContain('Script finished.')
    // The task list lives in its own window, so it is asserted on the desktop
    // frame rather than on the transcript's rows.
    expect(frame).toContain('Update the test')
  })
})

describe('the live terminal path', () => {
  it('feeds raw bytes through the decoder into a rendered frame', async () => {
    const view = build()
    view.app.start()
    // A whole typed line and a submit, byte by byte, is the real input path:
    // any buffering mistake shows up as a wrong character.
    for (const char of 'hello there') view.app.feed(char)
    expect(view.app.composer.value).toBe('hello there')
    view.app.feed('\r')
    expect(view.host.sent).toEqual(['hello there'])
    expect(await view.paint()).toContain('hello there')
  })

  it('treats a split escape sequence as one key', async () => {
    const view = build()
    view.app.start()
    view.app.feed('abc')
    // A real terminal can deliver one sequence in two reads.
    view.app.feed('\u001B')
    view.app.feed('[D')
    expect(view.app.composer.caret).toBe(2)
    await view.paint()
  })

  it('handles a paste of many lines in one event', async () => {
    const view = build()
    view.app.start()
    const pasted = Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n')
    view.app.feed(`\u001B[200~${pasted}\u001B[201~`)
    expect(view.app.composer.value.split('\n')).toHaveLength(12)
  })

  it('survives a burst that mixes keys, mouse, and a menu', async () => {
    const view = build()
    view.app.start()
    view.app.feed('text\u001B[<0;10;2M\u001B[<32;20;4M\u001B[<0;20;4m\u001B[21~\u001B[B\u001B')
    view.app.flushInput()
    const frame = await view.paint()
    // The burst must leave a coherent desktop rather than a corrupted frame.
    expect(frame).toContain('Conversation')
    for (const row of frame.split('\n')) expect(textWidth(row)).toBeLessThanOrEqual(100)
  })
})
