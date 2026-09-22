/**
 * Visual regression tests.
 *
 * These paint the whole desktop and compare the result against a checked-in
 * frame. They are the only tests that catch a change which is correct in every
 * unit but wrong on screen — a frame one cell short, a gutter that drifted, a
 * dropdown that no longer covers what it should.
 *
 * The expected frames live in `tests/snapshots/*.txt` and are regenerated with
 * `Tvision_SNAPSHOT=refresh npx vitest run tests/snapshot.spec.ts`. They are
 * deliberately ASCII: a reader can see the whole interface in a diff, which is
 * the point of a character-cell UI and a real advantage over an image snapshot.
 * @module @dsh-tvision/dsh-tvision/tests/snapshot
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { TvisionApp, WINDOW_IDS } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { findSkin } from '../src/kit/skin.ts'
import { HeadlessTerminal } from './headless-terminal.ts'
import type { InputEvent } from '../src/kit/input.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SNAPSHOT_DIR = join(HERE, 'snapshots')
const REFRESH = process.env['Tvision_SNAPSHOT'] === 'refresh'

/** A host that answers plausibly and records what it was asked. */
function fakeHost(): AppHost & { sent: string[]; ran: string[] } {
  const sent: string[] = []
  const ran: string[] = []
  return {
    sent,
    ran,
    send: (text) => { sent.push(text) },
    runCommand: async (line) => {
      ran.push(line)
      return { kind: 'success', text: `ran ${line}` }
    },
    cancel: () => {},
    quit: () => {},
    commands: () => [
      { name: 'model', description: 'Choose the model route' },
      { name: 'compact', description: 'Compact the context' },
    ],
    files: () => ['src/parser.ts'],
    modelLabel: () => 'deepseek-official/deepseek-flash',
    contextWindow: () => 128_000,
  }
}

/** A harness that drives the app and reads the terminal back. */
interface Scene {
  readonly app: TvisionApp
  readonly terminal: HeadlessTerminal
  feed(data: string): void
  handle(event: InputEvent): void
  /** Render pending changes and return the emulator's grid as text. */
  frame(): Promise<string>
}

/**
 * Build a scene at a fixed size.
 * @param columns - Screen width.
 * @param rows - Screen height.
 * @param skin - Skin id.
 * @returns The scene.
 */
function scene(columns = 100, rows = 30, skin = 'tvision'): Scene {
  const terminal = new HeadlessTerminal(columns, rows)
  const size = { columns, rows }
  const app = new TvisionApp({
    terminal: {
      get columns(): number { return size.columns },
      get rows(): number { return size.rows },
      write: (data: string) => terminal.write(data),
    },
    host: fakeHost(),
    info: { name: 'tvision', version: '0.1.0', sessionId: 'snapshot-session', cwd: '/home/dev/project' },
    skin: findSkin(skin) ?? findSkin('tvision')!,
  })
  return {
    app,
    terminal,
    feed: (data) => app.feed(data),
    handle: (event) => app.handle(event),
    async frame() {
      app.windows.requestRender()
      // Settle twice: the frame loop's own render, then the emulator's parse,
      // which is asynchronous.
      await terminal.writeAndSettle(app.renderForTest())
      const view = terminal.snapshot()
      return view.rawRows.map(row => row.replace(/\s+$/u, '')).join('\n').replace(/\n+$/u, '')
    },
  }
}

/**
 * Compare a rendered frame against a checked-in snapshot.
 * @param name - The snapshot file's base name.
 * @param actual - The rendered frame.
 */
function expectSnapshot(name: string, actual: string): void {
  const path = join(SNAPSHOT_DIR, `${name}.txt`)
  if (REFRESH || !existsSync(path)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true })
    writeFileSync(path, `${actual}\n`)
    return
  }
  const expected = readFileSync(path, 'utf8').replace(/\n$/u, '')
  expect(actual).toBe(expected)
}

describe('desktop snapshots', () => {
  it('renders an empty desktop', async () => {
    const view = scene()
    view.app.start()
    expectSnapshot('desktop-empty', await view.frame())
  })

  it('renders a conversation with prose and a tool card', async () => {
    const view = scene()
    view.app.start()
    view.app.document.addUser('why is the first token so slow?', 0)
    view.app.document.beginAssistant({ turn: 0, step: 0 }, 10)
    view.app.document.streamChunk(
      { turn: 0, step: 0 },
      { kind: 'text', text: 'The parser buffers the whole document before it emits anything.\n\nHere is the fix — **stream by chunk**, `drain(buffer)`, and a list:\n\n- read chunks as they arrive\n- hold a partial fence in the buffer\n- [x] emit tokens early\n- [ ] keep the old test passing\n\n> A fence that straddles a chunk boundary is the hard part.\n\n---\n\n### See also\n' },
      20,
    )
    view.app.document.endStep({ turn: 0, step: 0 }, 1400)
    view.app.document.addToolCall({
      callId: 'c1',
      name: 'bash',
      args: '{"command":"npm test -- parser"}',
      turn: 0,
      step: 1,
      time: 1500,
    })
    view.app.document.finishToolCall('c1', { text: 'PASS 3 tests', isError: false })
    view.app.document.setTodos([
      { id: '1', text: 'Find why the first token is late', status: 'completed' },
      { id: '2', text: 'Make the parser emit per chunk', status: 'in_progress' },
      { id: '3', text: 'Update the streaming test', status: 'pending' },
    ])
    expectSnapshot('conversation', await view.frame())
  })

  it('renders an expanded tool card with a diff', async () => {
    const view = scene()
    view.app.start()
    const entry = view.app.document.addToolCall({
      callId: 'c1',
      name: 'edit',
      args: '{"path":"src/parser.ts","old_string":"readAll(source)"}',
      turn: 0,
      step: 0,
      time: 0,
    })
    view.app.document.finishToolCall('c1', {
      text: 'Edited src/parser.ts',
      isError: false,
      diff: ['@@ -42,4 +42,6 @@', '-  const whole = await readAll(source)', '+  for await (const chunk of source) {', '+    yield* drain(buffer)'],
    })
    view.app.transcript.toggleEntry(entry.id)
    expectSnapshot('tool-card-expanded', await view.frame())
  })

  it('renders an open menu over the desktop', async () => {
    const view = scene()
    view.app.start()
    view.feed('\u001B[21~')
    view.feed('\u001B[B')
    expectSnapshot('menu-open', await view.frame())
  })

  it('renders the View menu with its submenu', async () => {
    const view = scene()
    view.app.start()
    view.feed('\u001B[21~')
    view.feed('\u001B[B')
    view.feed('\u001B[C')
    view.feed('\u001B[B')
    view.feed('\u001B[B')
    view.feed('\u001B[B')
    view.feed('\u001B[B')
    view.feed('\u001B[B')
    view.feed('\u001B[B')
    expectSnapshot('menu-submenu', await view.frame())
  })

  it('renders the help window', async () => {
    const view = scene()
    view.app.start()
    view.feed('\u001B[11~')
    expectSnapshot('help-window', await view.frame())
  })

  it('renders an approval dialog', async () => {
    const view = scene(96, 26)
    view.app.start()
    const pending = view.app.askApproval({ toolName: 'bash', reason: 'writes outside the workspace' })
    await view.frame()
    const rendered = await view.frame()
    expectSnapshot('approval-dialog', rendered)
    // Settle it so the promise does not outlive the test. A lone ESC is held
    // by the decoder until the terminal says input went quiet, which is what
    // `flushInput` stands in for here.
    view.feed('\u001B')
    view.app.flushInput()
    await pending
  })

  it('renders the composer with a command completion popup', async () => {
    const view = scene()
    view.app.start()
    view.feed('/')
    expectSnapshot('composer-completions', await view.frame())
  })

  it('renders a narrow terminal without a side column', async () => {
    const view = scene(72, 22)
    view.app.start()
    view.app.document.addUser('a narrow terminal drops the side column', 0)
    view.app.document.beginAssistant({ turn: 0, step: 0 }, 10)
    view.app.document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'So the transcript keeps its width.' }, 20)
    expectSnapshot('narrow', await view.frame())
  })

  it('renders each shipped skin', async () => {
    for (const skin of ['phosphor', 'amber', 'slate', 'ansi']) {
      const view = scene(90, 20, skin)
      view.app.start()
      view.app.document.addUser('the same desktop, a different phosphor', 0)
      view.app.document.beginAssistant({ turn: 0, step: 0 }, 10)
      view.app.document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'Only the palette changed.' }, 20)
      expectSnapshot(`skin-${skin}`, await view.frame())
      view.app.stop()
    }
  })

  it('renders a wide CJK transcript without shifting the frame', async () => {
    const view = scene(100, 24)
    view.app.start()
    view.app.document.addUser('为什么第一个 token 这么慢？', 0)
    view.app.document.beginAssistant({ turn: 0, step: 0 }, 10)
    view.app.document.streamChunk(
      { turn: 0, step: 0 },
      { kind: 'text', text: '解析器在发出任何内容之前会先缓冲整个文档，所以第一个 token 必须等到文件读完。正确的做法是边读边切词，把不完整的词留在缓冲区里等待下一个数据块补全，这样首token的延迟就只取决于第一个完整词何时出现，禁则处理保证标点不会落到行首，中英之间的间隙由显示层补上。' },
      20,
    )
    view.app.document.addToolCall({
      callId: 'c1',
      name: 'bash',
      args: '{"command":"npm test -- parser"}',
      turn: 0,
      step: 1,
      time: 30,
    })
    view.app.document.finishToolCall('c1', { text: '通过 3 个测试', isError: false })
    expectSnapshot('cjk', await view.frame())
  })

  it('renders markdown prose with every block type', async () => {
    const view = scene()
    view.app.start()
    view.app.document.addUser('explain the fix', 0)
    view.app.document.beginAssistant({ turn: 0, step: 0 }, 10)
    view.app.document.streamChunk(
      { turn: 0, step: 0 },
      { kind: 'text', text: '# Streaming the parser\n\n## Why it was slow\n\nThe old code buffered **everything** — *every* byte — before it emitted a `token`. Now it reads chunk by chunk:\n\n1. read a chunk\n2. drain complete tokens\n3. hold partial ones\n   - a partial word waits\n   - a partial fence waits too\n\n> The first token now arrives when the first complete word does,\n> not when the whole file has been read.\n\n---\n\n### Details\n\nA ~~buffer-everything~~ approach cannot stream; ~~no~~ yes, ~~gone~~. See [the parser](src/parser.ts) for the shape.\n' },
      20,
    )
    view.app.document.endStep({ turn: 0, step: 0 }, 30)
    expectSnapshot('markdown', await view.frame())
  })

  it('renders the window menu listing every window', async () => {
    const view = scene()
    view.app.start()
    view.app.windows.tile()
    view.feed('\u001B[21~')
    // Walk to the Window menu: File, View, Agent, Tools, Window.
    for (let step = 0; step < 4; step++) view.feed('\u001B[C')
    view.feed('\u001B[B')
    expectSnapshot('window-menu', await view.frame())
  })

  it('renders the session list', async () => {
    const view = scene(104, 28)
    view.app.start()
    const now = Date.now()
    view.app.setSessions([
      { id: 'main-session-7f3a91c2', createdAt: now - 4 * 60_000, cwd: '/home/dev/project', live: true, persisted: true, title: 'Make the parser stream' },
      { id: 'main-session-2b8e40d1', createdAt: now - 3 * 3_600_000, cwd: '/home/dev/project', live: false, persisted: true, title: 'Fix the fence tokenizer' },
      { id: 'main-session-9c1d5f07', createdAt: now - 26 * 3_600_000, cwd: '/home/dev/other', live: false, persisted: true, firstPrompt: 'why is the first token so slow?' },
      { id: 'main-session-4ae77b30', createdAt: now - 5 * 86_400_000, live: false, persisted: true },
      { id: 'main-session-0d5c1e88', createdAt: now - 6 * 86_400_000, live: false, persisted: false },
    ], '/home/dev')
    view.app.setListRows(WINDOW_IDS.project, [
      { label: 'parser.ts', detail: 'src' },
      { label: 'stream.ts', detail: 'src' },
      { label: 'parser.spec.ts', detail: 'tests' },
    ])
    view.app.setWindowTitle(WINDOW_IDS.project, 'Project — 3 files')
    view.app.openWindow(WINDOW_IDS.sessions)
    expectSnapshot('sessions', await view.frame())
  })

  it('renders the session list with the workspace collapsed', async () => {
    const view = scene()
    view.app.start()
    view.app.setSessions([
      { id: 'main-session-7f3a91c2', createdAt: Date.now() - 60_000, cwd: '/home/dev/project', live: false, persisted: true, title: 'A session whose workspace is long enough to shorten' },
    ], '/home/dev')
    view.app.openWindow(WINDOW_IDS.sessions)
    expectSnapshot('sessions-home', await view.frame())
  })

  it('renders a tiled desktop', async () => {
    const view = scene()
    view.app.start()
    view.app.openWindow(WINDOW_IDS.sessions)
    view.app.openWindow(WINDOW_IDS.jobs)
    view.app.windows.tile()
    expectSnapshot('tiled', await view.frame())
  })
})
