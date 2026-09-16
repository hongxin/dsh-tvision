/**
 * The demo: the desktop with a scripted agent behind it.
 *
 * Two jobs. It is the thing a curious person runs first — `node lib/demo.js` —
 * and it is what makes the interface reviewable without a DeepSeek key, a
 * profile, or a network. It is also the fastest way to see a change, because
 * nothing has to boot.
 *
 * The scripted agent streams a plausible answer token by token, calls a couple
 * of tools with real-shaped arguments, records a diff, writes a task list, and
 * then waits for you. Everything it does goes through the same {@link AppHost}
 * the real plugin implements, so the demo exercises the real code path rather
 * than a mock of it.
 * @module @dsh-tvision/dsh-tvision/demo
 */

import { TvisionApp, type AppHost, type AppTerminal } from './app/app.ts'
import { ProcessTerminal } from './term/process-terminal.ts'
import { SKINS, findSkin } from './kit/skin.ts'
import { VERSION } from './version.ts'

/** How the demo was invoked. */
interface DemoOptions {
  readonly skin: string
  readonly mouse: boolean
}

/**
 * Parse the demo's own flags.
 * @param argv - Arguments after the script name.
 * @returns The options.
 */
export function parseOptions(argv: readonly string[]): DemoOptions {
  let skin = 'tvision'
  let mouse = true
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--skin') {
      const value = argv[index + 1]
      if (value !== undefined && findSkin(value) !== undefined) skin = value
      index++
    } else if (arg?.startsWith('--skin=')) {
      const value = arg.slice('--skin='.length)
      if (findSkin(value) !== undefined) skin = value
    } else if (arg === '--no-mouse') {
      mouse = false
    } else if (arg === '--list-skins') {
      for (const candidate of SKINS) {
        process.stdout.write(`  ${candidate.id.padEnd(10)} ${candidate.name} — ${candidate.description}\n`)
      }
      process.exit(0)
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'tvision demo — a character-cell window manager for DSH agents',
        '',
        'usage: node lib/demo.js [--skin <id>] [--no-mouse] [--list-skins]',
        '',
        'The demo drives the real desktop with a scripted agent: no key, no',
        'network, and no profile required. Type anything and press Enter to',
        'watch it answer; F1 lists the keys, F10 opens the menu.',
        '',
      ].join('\n'))
      process.exit(0)
    }
  }
  return { skin, mouse }
}

/** A line of scripted output: text to stream, or an action to take. */
type Beat =
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly name: string; readonly args: string; readonly result: string; readonly diff?: readonly string[] }
  | { readonly kind: 'notice'; readonly text: string }
  | { readonly kind: 'todos'; readonly items: readonly { readonly text: string; readonly status: 'pending' | 'in_progress' | 'completed' }[] }
  | { readonly kind: 'pause'; readonly ms: number }

/**
 * The scripted response.
 *
 * Chosen to exercise every card the transcript knows how to draw: reasoning,
 * prose, a fenced code block, a successful tool call, a failing one, a diff, and
 * a task list. If a change breaks one of them, the demo shows it.
 */
const SCRIPT: readonly Beat[] = [
  { kind: 'reasoning', text: 'They want the parser to stream. Let me look at how it buffers first. ' },
  { kind: 'reasoning', text: 'The whole document is read before the first token, so nothing can be emitted early.' },
  { kind: 'text', text: "Right — the parser buffers the entire document before it emits anything, which is why the first token never arrives until the whole file is read.\n\nHere is the shape of the fix:\n\n```ts\nfor await (const chunk of source) {\n  buffer += chunk\n  for (const token of drain(buffer)) yield token\n}\n```\n\nLet me check what the tests expect before changing it.\n" },
  { kind: 'tool', name: 'bash', args: '{"command":"npm test -- parser","timeout":120000}', result: 'PASS tests/parser.spec.ts\n  ✓ emits a token as soon as one is complete (12 ms)\n  ✓ holds a partial token across a chunk boundary (3 ms)\n  ✗ streams a fenced block (8 ms)\n\nTests: 1 failed, 2 passed, 3 total' },
  { kind: 'text', text: '\nOne test already covers the chunk boundary, and another one fails — it expected the old all-at-once behaviour. That failure is the change working.\n' },
  { kind: 'tool', name: 'edit', args: '{"path":"src/parser.ts","old_string":"const whole = await readAll(source)","new_string":"for await (const chunk of source)"}', result: 'Edited src/parser.ts', diff: ['@@ -42,7 +42,9 @@ export async function parse(source) {', '-  const whole = await readAll(source)', '-  return tokenize(whole)', '+  for await (const chunk of source) {', '+    buffer += chunk', '+    yield* drain(buffer)', '+  }', ' }'] },
  { kind: 'todos', items: [
    { text: 'Find why the first token is late', status: 'completed' },
    { text: 'Make the parser emit per chunk', status: 'in_progress' },
    { text: 'Update the streaming test', status: 'pending' },
    { text: 'Check the fenced-block case', status: 'pending' },
  ] },
  { kind: 'tool', name: 'bash', args: '{"command":"npm test -- parser"}', result: 'Error: 1 test failed\n  ✗ streams a fenced block (8 ms)\n    expected ["```", "ts"] to equal ["```ts"]' },
  { kind: 'text', text: '\nThe fence opener is being split across two chunks and emitted as two tokens. `drain` needs to hold a partial fence the same way it holds a partial word.\n\nThat is the last piece. The task list above tracks where things stand.\n' },
  { kind: 'notice', text: 'Demo script finished. Press F1 for the key list, F10 for the menu, or type anything to replay.' },
]

/**
 * The scripted agent.
 *
 * Holds no state beyond whether a script is running, so a second Enter replays
 * the script rather than interleaving with the first.
 */
class ScriptedHost implements AppHost {
  private running = false
  private cancelled = false
  private readonly appOf: () => TvisionApp
  private readonly exitDemo: () => void

  /**
   * @param app - Supplies the application, which is constructed after the host.
   * @param quit - Called when the demo should end.
   */
  constructor(app: () => TvisionApp, quit: () => void) {
    this.appOf = app
    this.exitDemo = quit
  }

  /** Play the script into the document. */
  private async play(prompt: string): Promise<void> {
    const document = this.appOf().document
    const now = (): number => Date.now()
    document.setPhase('running', now())
    document.setModel('demo/scripted')
    document.beginAssistant({ turn: 0, step: 0 }, now())
    let step = 0
    for (const beat of SCRIPT) {
      if (this.cancelled) break
      switch (beat.kind) {
        case 'pause':
          await sleep(beat.ms)
          break
        case 'reasoning':
        case 'text': {
          // Streamed a few characters at a time, which is what makes the
          // transcript's follow-the-end behaviour visible.
          for (const piece of chunk(beat.text, beat.kind === 'text' ? 4 : 6)) {
            if (this.cancelled) break
            document.streamChunk({ turn: 0, step }, { kind: beat.kind === 'text' ? 'text' : 'reasoning', text: piece }, now())
            this.appOf().windows.requestRender()
            await sleep(12)
          }
          break
        }
        case 'tool': {
          const callId = `demo-${step}-${beat.name}`
          document.endStep({ turn: 0, step }, now())
          document.addToolCall({
            callId,
            name: beat.name,
            args: beat.args,
            turn: 0,
            step,
            time: now(),
          })
          this.appOf().windows.requestRender()
          await sleep(500)
          const failed = /^Error:/u.test(beat.result)
          document.finishToolCall(callId, {
            text: beat.result,
            isError: failed,
            ...(beat.diff === undefined ? {} : { diff: beat.diff }),
          })
          document.update(document.toolEntry(callId)?.id ?? -1, { endedAt: now() })
          step++
          document.beginAssistant({ turn: 0, step }, now())
          this.appOf().windows.requestRender()
          break
        }
        case 'notice':
          document.addNotice('notice', beat.text, now())
          break
        case 'todos':
          document.setTodos(beat.items.map((item, index) => ({
            id: String(index),
            text: item.text,
            status: item.status,
          })))
          break
      }
      this.appOf().windows.requestRender()
    }
    document.endStep({ turn: 0, step }, now())
    document.setPhase('idle', now())
    this.appOf().windows.requestRender()
    void prompt
  }

  send(text: string): void {
    if (this.running) return
    this.running = true
    this.cancelled = false
    void this.play(text).finally(() => {
      this.running = false
    })
  }

  async runCommand(line: string): Promise<{ text?: string; kind: 'success' | 'error' } | undefined> {
    const [verb] = line.slice(1).split(/\s+/u)
    switch (verb) {
      case 'help':
        return {
          kind: 'success',
          text: '/help  /model  /status  /skin  /clear  /exit',
        }
      case 'model':
        return { kind: 'success', text: `demo/scripted — start it with --skin to see another skin` }
      case 'status':
        return { kind: 'success', text: `tvision ${VERSION} · demo mode · scripted agent` }
      case 'skin':
        return { kind: 'success', text: `skins: ${SKINS.map(skin => skin.id).join(', ')} (F9 cycles)` }
      case 'clear':
        this.appOf().document.clear()
        return { kind: 'success' }
      case 'exit':
      case 'quit':
        this.quit()
        return { kind: 'success', text: 'Bye.' }
      default:
        return undefined
    }
  }

  cancel(): void {
    this.cancelled = true
    this.appOf().document.addNotice('notice', 'Cancelled (demo).', Date.now())
  }

  /** The slash commands the demo advertises. */
  readonly commands = (): readonly { name: string; description: string }[] => [
    { name: 'help', description: 'List the demo commands' },
    { name: 'model', description: 'Show the scripted model route' },
    { name: 'status', description: 'Show the demo status' },
    { name: 'skin', description: 'List the available skins' },
    { name: 'clear', description: 'Clear the transcript' },
    { name: 'exit', description: 'Leave the demo' },
  ]

  /** The file references the demo offers for `@` completion. */
  readonly files = (): readonly string[] => [
    'src/parser.ts',
    'src/stream.ts',
    'src/index.ts',
    'tests/parser.spec.ts',
    'README.md',
  ]

  /** The model route label the status line shows. */
  readonly modelLabel = (): string => 'demo/scripted'

  /** A plausible context window, so the pressure bar has something to show. */
  readonly contextWindow = (): number => 128_000

  /** Leave the demo. */
  quit(): void {
    this.exitDemo()
  }
}

/**
 * Split text into small chunks, for a streamed effect.
 * @param text - The text.
 * @param size - Characters per chunk.
 * @returns The chunks.
 */
export function chunk(text: string, size: number): string[] {
  const out: string[] = []
  for (let index = 0; index < text.length; index += size) out.push(text.slice(index, index + size))
  return out
}

/**
 * Wait.
 * @param ms - Milliseconds.
 * @returns A promise that resolves afterwards.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run the demo until the user leaves.
 * @param argv - Arguments after the script name.
 * @returns A promise that resolves when the terminal has been released.
 */
export async function runDemo(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv)
  const skin = findSkin(options.skin) ?? SKINS[0]
  /* c8 ignore next -- the catalogue is never empty. */
  if (skin === undefined) throw new Error('tvision: no skins available')
  const terminal = new ProcessTerminal({ mouse: options.mouse })
  let app: TvisionApp | undefined
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const host = new ScriptedHost(
    () => {
      /* c8 ignore next -- the host is only reachable once the app exists. */
      if (app === undefined) throw new Error('tvision: host used before mount')
      return app
    },
    () => {
      app?.stop()
      terminal.stop()
      resolveDone?.()
    },
  )

  app = new TvisionApp({
    terminal: {
      get columns(): number { return terminal.columns },
      get rows(): number { return terminal.rows },
      write: (data: string) => terminal.write(data),
    } satisfies AppTerminal,
    host,
    info: {
      name: 'tvision',
      version: VERSION,
      sessionId: 'demo',
      cwd: process.cwd(),
    },
    skin,
  })

  terminal.onEscapeTimeout = () => app?.flushInput()
  terminal.setTitle(`tvision ${VERSION} — demo`)
  app.start()

  // A frame loop, at the terminal's practical refresh ceiling. An unchanged
  // frame renders to the empty string, so idling costs nothing.
  const timer = setInterval(() => app?.frame(), 16)
  terminal.start(
    chunkIn => app?.feed(chunkIn),
    () => app?.handle({ type: 'resize', columns: terminal.columns, rows: terminal.rows }),
  )

  // Open with the same script a user would get by pressing Enter, so the first
  // thing on screen is the desktop doing its job rather than an empty window.
  app.document.addUser('why is the first token so slow?', Date.now())
  host.send('why is the first token so slow?')

  try {
    await done
  } finally {
    clearInterval(timer)
    terminal.stop()
  }
}

// Run when executed directly rather than imported by a test.
/* c8 ignore next 4 -- the guard is only true under `node demo.js`. */
if (process.argv[1] !== undefined && /demo\.(?:js|ts)$/u.test(process.argv[1])) {
  await runDemo()
}
