/**
 * Session document and transcript view tests.
 *
 * The document is the contract between the agent's event stream and the screen,
 * so these tests assert on the *fold* — what a sequence of events produces —
 * rather than on individual setters. The view tests then assert on the rendered
 * rows, including the two behaviours that are easy to get subtly wrong: a stream
 * of chunks must wrap as one paragraph, and a long word must be cut rather than
 * allowed to overflow its window.
 */
import { describe, expect, it, vi } from 'vitest'
import { CellBuffer, rect } from '../src/kit/cell.ts'
import { Painter } from '../src/kit/painter.ts'
import { TURBO_VISION, resolvePalette } from '../src/kit/skin.ts'
import { Consumed } from '../src/kit/widget.ts'
import { textWidth } from '../src/kit/text.ts'
import { SessionDocument, readContentBlocks, splitFencedCode } from '../src/session/model.ts'
import { foldEvent } from '../src/app/events.ts'
import {
  TranscriptView,
  buildRows,
  prettyJson,
  summarizeArgs,
  wrapText,
} from '../src/views/transcript.ts'

const palette = resolvePalette(TURBO_VISION)
const theme = { gutterWidth: 2, collapsed: true, showReasoning: true }

describe('SessionDocument', () => {
  it('starts empty and reports its shape', () => {
    const document = new SessionDocument()
    expect(document.all).toEqual([])
    expect(document.summary()).toMatchObject({ total: 0, streaming: false })
  })

  it('records a user turn', () => {
    const document = new SessionDocument()
    document.addUser('hello', 1000)
    const [entry] = document.all
    expect(entry).toMatchObject({ kind: 'user', title: 'You', text: 'hello', time: 1000 })
  })

  it('labels injected context differently from a human prompt', () => {
    const document = new SessionDocument()
    document.addUser('file changed', 1, { synthetic: true })
    expect(document.all[0]).toMatchObject({ kind: 'context', title: 'Context' })
  })

  it('notifies subscribers on every mutation', () => {
    const document = new SessionDocument()
    const listener = vi.fn()
    const unsubscribe = document.subscribe(listener)
    document.addUser('a', 1)
    document.setTitle('t')
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    document.setTitle('u')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('advances the revision so a view can detect staleness', () => {
    const document = new SessionDocument()
    const before = document.revision
    document.addUser('a', 1)
    expect(document.revision).toBeGreaterThan(before)
  })

  it('coalesces consecutive chunks of the same kind into one piece', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 1)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'Hel' }, 2)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'lo' }, 3)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'reasoning', text: 'hm' }, 4)
    const [entry] = document.all
    expect(entry?.pieces).toHaveLength(2)
    expect(entry?.text).toBe('Hello')
    expect(entry?.reasoning).toBe('hm')
    expect(entry?.streaming).toBe(true)
  })

  it('creates the assistant entry when a chunk arrives before its step', () => {
    const document = new SessionDocument()
    document.streamChunk({ turn: 2, step: 1 }, { kind: 'text', text: 'x' }, 5)
    expect(document.all).toHaveLength(1)
    expect(document.all[0]).toMatchObject({ kind: 'assistant', turn: 2, step: 1, text: 'x' })
  })

  it('starts a new entry when the step changes', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 1)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'a' }, 2)
    document.endStep({ turn: 0, step: 0 }, 3)
    document.beginAssistant({ turn: 0, step: 1 }, 4)
    expect(document.all).toHaveLength(2)
  })

  it('settles the streamed entry with the model final content', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 1)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'partial' }, 2)
    document.settleAssistant({ turn: 0, step: 0 }, [{ kind: 'text', text: 'complete' }], 3)
    const [entry] = document.all
    expect(entry?.text).toBe('complete')
    // A settled message is not streaming, but the step is still open; only
    // endStep closes it.
    expect(entry?.endedAt).toBeUndefined()
    document.endStep({ turn: 0, step: 0 }, 4)
    expect(document.all[0]?.streaming).toBe(false)
  })

  it('keeps the streamed text when the settled content is empty', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 1)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'kept' }, 2)
    document.settleAssistant({ turn: 0, step: 0 }, [], 3)
    expect(document.all[0]?.text).toBe('kept')
  })

  it('creates the entry when a settle arrives with nothing open', () => {
    const document = new SessionDocument()
    document.settleAssistant({ turn: 0, step: 0 }, [{ kind: 'text', text: 'late' }], 1)
    expect(document.all[0]).toMatchObject({ kind: 'assistant', text: 'late', streaming: false })
  })

  it('records a step end time for the duration footer', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 100)
    document.endStep({ turn: 0, step: 0 }, 1600)
    expect(document.all[0]?.endedAt).toBe(1600)
  })

  it('pairs a tool result with the card its call created', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'c1', name: 'bash', args: '{"command":"ls"}', turn: 0, step: 0, time: 1 })
    const running = document.toolEntry('c1')
    expect(running?.state).toBe('running')
    document.finishToolCall('c1', { text: 'a\nb', isError: false })
    expect(document.toolEntry('c1')).toMatchObject({ state: 'ok', result: 'a\nb' })
  })

  it('marks a failed tool call', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'c1', name: 'bash', args: '{}', turn: 0, step: 0, time: 1 })
    document.finishToolCall('c1', { text: 'boom', isError: true })
    expect(document.toolEntry('c1')?.state).toBe('error')
  })

  it('carries a diff through to the card', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'c1', name: 'edit', args: '{}', turn: 0, step: 0, time: 1 })
    document.finishToolCall('c1', { text: 'edited', isError: false, diff: ['-old', '+new'] })
    expect(document.toolEntry('c1')?.diff).toEqual(['-old', '+new'])
  })

  it('ignores a result for a call it never saw', () => {
    const document = new SessionDocument()
    expect(document.finishToolCall('ghost', { text: 'x', isError: false })).toBeUndefined()
  })

  it('re-uses a card when the same call arrives twice', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'c1', name: 'bash', args: '{}', turn: 0, step: 0, time: 1 })
    document.finishToolCall('c1', { text: 'done', isError: false })
    const again = document.addToolCall({ callId: 'c1', name: 'bash', args: '{}', turn: 0, step: 0, time: 2 })
    expect(document.all).toHaveLength(1)
    expect(again.state).toBe('running')
  })

  it('stores the todo list and the session title', () => {
    const document = new SessionDocument()
    document.setTodos([{ id: '1', text: 'do it', status: 'pending' }])
    document.setTitle('Refactor the parser')
    expect(document.todoList).toHaveLength(1)
    expect(document.sessionTitle).toBe('Refactor the parser')
  })

  it('does not notify when the title is unchanged', () => {
    const document = new SessionDocument()
    const listener = vi.fn()
    document.subscribe(listener)
    document.setTitle('same')
    document.setTitle('same')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('accumulates usage across messages and tracks context separately', () => {
    const document = new SessionDocument()
    document.addUsage({ input: 100, output: 20 })
    document.addUsage({ input: 50, output: 10, total: 5000 })
    expect(document.tokens).toMatchObject({ input: 150, output: 30 })
    expect(document.contextTokens).toBe(5000)
  })

  it('moves between phases and records when each began', () => {
    const document = new SessionDocument()
    document.setPhase('running', 100)
    expect(document.agentPhase).toBe('running')
    expect(document.phaseSince).toBe(100)
    const listener = vi.fn()
    document.subscribe(listener)
    document.setPhase('running', 200)
    expect(listener).not.toHaveBeenCalled()
  })

  it('clears everything for a fresh session', () => {
    const document = new SessionDocument()
    document.addUser('a', 1)
    document.setTitle('t')
    document.addUsage({ input: 5 })
    document.clear()
    expect(document.all).toEqual([])
    expect(document.sessionTitle).toBeUndefined()
    expect(document.tokens.input).toBe(0)
  })

  it('appends notices, errors, and compaction markers', () => {
    const document = new SessionDocument()
    document.addNotice('notice', 'fyi', 1)
    document.addNotice('error', 'bad', 2)
    document.addNotice('compaction', 'squashed', 3)
    expect(document.all.map(entry => entry.kind)).toEqual(['notice', 'error', 'compaction'])
  })
})

describe('content parsing', () => {
  it('lifts fenced code out of prose', () => {
    const pieces = splitFencedCode('before\n```sh\nls -la\n```\nafter')
    expect(pieces).toEqual([
      { kind: 'text', text: 'before\n' },
      { kind: 'code', text: 'ls -la\n', language: 'sh' },
      { kind: 'text', text: '\nafter' },
    ])
  })

  it('treats an unterminated fence as code to the end', () => {
    const pieces = splitFencedCode('text\n```\nunterminated')
    expect(pieces.at(-1)).toMatchObject({ kind: 'code', text: 'unterminated' })
  })

  it('returns prose unchanged when there is no fence', () => {
    expect(splitFencedCode('just words')).toEqual([{ kind: 'text', text: 'just words' }])
  })

  it('reads text and thinking blocks and skips the rest', () => {
    const pieces = readContentBlocks([
      { type: 'thinking', thinking: 'hmm' },
      { type: 'text', text: 'answer' },
      { type: 'image' },
      { type: 'text', text: '' },
    ])
    expect(pieces).toEqual([
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'text', text: 'answer' },
    ])
  })
})

describe('wrapText', () => {
  it('wraps at the column budget without trailing blanks', () => {
    expect(wrapText('one two three', 8)).toEqual(['one two', 'three'])
    expect(wrapText('one two  three', 8)).toEqual(['one two', 'three'])
  })

  it('preserves explicit newlines and blank lines', () => {
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b'])
  })

  it('cuts a word longer than the line rather than overflowing', () => {
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never counts a wide glyph as one column', () => {
    expect(wrapText('中中中', 4)).toEqual(['中中', '中'])
  })

  it('returns one empty line for empty input', () => {
    expect(wrapText('', 10)).toEqual([''])
  })
})

describe('argument summaries', () => {
  it('prefers the conventional argument keys', () => {
    expect(summarizeArgs('{"command":"npm test"}')).toBe('npm test')
    expect(summarizeArgs('{"path":"src/a.ts","content":"x"}')).toBe('src/a.ts')
    expect(summarizeArgs('{"query":"find the bug"}')).toBe('find the bug')
  })

  it('falls back to the key list', () => {
    expect(summarizeArgs('{"alpha":1,"beta":2}')).toBe('alpha, beta')
  })

  it('handles a non-JSON argument string', () => {
    expect(summarizeArgs('not json')).toBe('not json')
  })

  it('handles an empty or scalar argument', () => {
    expect(summarizeArgs('')).toBe('')
    expect(summarizeArgs('"a string"')).toBe('a string')
  })

  it('pretty-prints JSON for the expanded card', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('nope')).toBe('nope')
  })
})

describe('transcript rows', () => {
  it('renders a user turn with a gutter marker', () => {
    const document = new SessionDocument()
    document.addUser('do the thing', 1)
    const rows = buildRows(document.all, 40, palette, theme)
    expect(rows[0]?.text).toBe('> You')
    expect(rows[1]?.text).toBe('  do the thing')
  })

  it('renders an assistant turn with a step heading', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 0)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'sure' }, 10)
    document.endStep({ turn: 0, step: 0 }, 500)
    const rows = buildRows(document.all, 40, palette, theme)
    expect(rows[0]?.text).toBe('| Agent · 0.5s')
    expect(rows[1]?.text).toBe('  sure')
  })

  it('shows an ellipsis only while a step is open', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 0)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'x' }, 1)
    expect(buildRows(document.all, 40, palette, theme)[0]?.text).toBe('| Agent …')
    document.endStep({ turn: 0, step: 0 }, 100)
    expect(buildRows(document.all, 40, palette, theme)[0]?.text).not.toContain('…')
  })

  it('shows a streaming marker while a step is open', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 0)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'text', text: 'x' }, 1)
    const rows = buildRows(document.all, 40, palette, theme)
    expect(rows[0]?.text).toBe('| Agent …')
  })

  it('hides reasoning when the theme says to', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 0)
    document.streamChunk({ turn: 0, step: 0 }, { kind: 'reasoning', text: 'secret' }, 1)
    const hidden = buildRows(document.all, 40, palette, { ...theme, showReasoning: false })
    expect(hidden.map(row => row.text).join('\n')).not.toContain('secret')
    const shown = buildRows(document.all, 40, palette, theme)
    expect(shown.map(row => row.text).join('\n')).toContain('secret')
  })

  it('frames a code block', () => {
    const document = new SessionDocument()
    document.beginAssistant({ turn: 0, step: 0 }, 0)
    // The document stores streamed text as prose; fenced code is lifted when the
    // pieces are set, which is what `readContentBlocks` does for a settled one.
    document.settleAssistant({ turn: 0, step: 0 }, splitFencedCode('```sh\nls\n```'), 1)
    const rows = buildRows(document.all, 30, palette, theme)
    const text = rows.map(row => row.text).join('\n')
    expect(text).toContain('┌ sh ')
    expect(text).toContain('│ ls')
    expect(text).toContain('└')
  })

  it('summarises a tool call on one line when collapsed', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'c', name: 'bash', args: '{"command":"npm test"}', turn: 0, step: 0, time: 0 })
    const rows = buildRows(document.all, 60, palette, theme)
    const text = rows.map(row => row.text).join('\n')
    expect(text).toContain('~ bash')
    expect(text).toContain('npm test')
    expect(text).toContain('running')
    // Collapsed means no framed body.
    expect(text).not.toContain('┌ args')
  })

  it('expands a tool card to show arguments and output', () => {
    const document = new SessionDocument()
    const entry = document.addToolCall({ callId: 'c', name: 'bash', args: '{"command":"ls"}', turn: 0, step: 0, time: 0 })
    document.finishToolCall('c', { text: 'file-a\nfile-b', isError: false })
    const rows = buildRows(document.all, 60, palette, { ...theme, collapsed: false }, new Set([entry.id]))
    const text = rows.map(row => row.text).join('\n')
    expect(text).toContain('┌ args')
    expect(text).toContain('"command"')
    expect(text).toContain('┌ output (2 lines)')
    expect(text).toContain('file-a')
  })

  it('styles diff lines by their marker', () => {
    const document = new SessionDocument()
    const entry = document.addToolCall({ callId: 'c', name: 'edit', args: '{}', turn: 0, step: 0, time: 0 })
    document.finishToolCall('c', { text: 'ok', isError: false, diff: ['-old', '+new', ' ctx'] })
    const rows = buildRows(document.all, 60, palette, { ...theme, collapsed: false }, new Set([entry.id]))
    const added = rows.find(row => row.text.includes('+new'))
    const removed = rows.find(row => row.text.includes('-old'))
    expect(added?.style).toEqual(palette.diffAdded)
    expect(removed?.style).toEqual(palette.diffRemoved)
  })

  it('marks a failed tool call', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'c', name: 'bash', args: '{}', turn: 0, step: 0, time: 0 })
    document.finishToolCall('c', { text: 'boom', isError: true })
    const rows = buildRows(document.all, 60, palette, theme)
    expect(rows.map(row => row.text).join('\n')).toContain('failed')
  })

  it('separates entries with a blank row', () => {
    const document = new SessionDocument()
    document.addUser('a', 1)
    document.addUser('b', 2)
    const rows = buildRows(document.all, 40, palette, theme)
    expect(rows.map(row => row.text)).toEqual(['> You', '  a', '', '> You', '  b'])
  })

  it('says so when the transcript is empty', () => {
    const rows = buildRows([], 40, palette, theme)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.text).toContain('nothing here yet')
  })

  it('never emits a row wider than the window', async () => {
    const document = new SessionDocument()
    document.addUser('x'.repeat(200), 1)
    document.addToolCall({ callId: 'c', name: 'bash', args: `{"command":"${'y'.repeat(200)}"}`, turn: 0, step: 0, time: 1 })
    const rows = buildRows(document.all, 24, palette, { ...theme, collapsed: false }, new Set([document.all[1]?.id ?? 0]))
    // A row one cell too wide shifts the terminal's whole line, so this is the
    // single most important invariant of the view.
    const { textWidth } = await import('../src/kit/text.ts')
    for (const row of rows) {
      expect(textWidth(row.text), JSON.stringify(row.text)).toBeLessThanOrEqual(24)
    }
  })
})

describe('TranscriptView scrolling', () => {
  const build = (): { view: TranscriptView; document: SessionDocument } => {
    const document = new SessionDocument()
    for (let index = 0; index < 40; index++) document.addUser(`line ${index}`, index)
    const view = new TranscriptView(document, theme)
    return { view, document }
  }

  function paint(view: TranscriptView, width = 40, height = 10): CellBuffer {
    const buffer = new CellBuffer(width, height)
    view.draw(new Painter(buffer, rect(0, 0, width, height)), { palette, focused: true, requestRender: () => {} })
    return buffer
  }

  it('follows new output by default', () => {
    const { view, document } = build()
    paint(view)
    expect(view.following).toBe(true)
    const before = view.offset
    // Several entries, so there is somewhere further down to scroll to.
    for (let index = 0; index < 5; index++) document.addUser(`extra ${index}`, 100 + index)
    paint(view)
    expect(view.offset).toBeGreaterThan(before)
  })

  it('stops following once the reader scrolls up', () => {
    const { view, document } = build()
    paint(view)
    view.onKey({ key: 'pageup' })
    expect(view.following).toBe(false)
    const parked = view.offset
    document.addUser('late', 200)
    paint(view)
    expect(view.offset).toBe(parked)
  })

  it('re-arms following when scrolled back to the end', () => {
    const { view } = build()
    paint(view)
    view.onKey({ key: 'pageup' })
    view.onKey({ key: 'end' })
    expect(view.following).toBe(true)
  })

  it('jumps to the start and the end', () => {
    const { view } = build()
    paint(view)
    view.onKey({ key: 'home' })
    expect(view.offset).toBe(0)
    view.onKey({ key: 'end' })
    expect(view.following).toBe(true)
  })

  it('steps one row at a time with the arrows', () => {
    const { view } = build()
    paint(view)
    view.onKey({ key: 'home' })
    view.onKey({ key: 'down' })
    expect(view.offset).toBe(1)
    view.onKey({ key: 'up' })
    expect(view.offset).toBe(0)
    // Already at the top; scrolling up must not go negative.
    view.onKey({ key: 'up' })
    expect(view.offset).toBe(0)
  })

  it('ignores modified keys so the composer keeps them', () => {
    const { view } = build()
    paint(view)
    expect(view.onKey({ key: 'up', ctrl: true })).toBe(Consumed.No)
    expect(view.onKey({ key: 'a' })).toBe(Consumed.No)
  })

  it('scrolls with the wheel', () => {
    const { view } = build()
    paint(view)
    view.onKey({ key: 'home' })
    expect(view.onMouse({ x: 0, y: 0, kind: 'wheel', button: 'none', delta: 1 })).toBe(Consumed.Yes)
    expect(view.offset).toBe(3)
    expect(view.onMouse({ x: 0, y: 0, kind: 'press', button: 'left' })).toBe(Consumed.No)
  })

  it('reports scroll metrics for the scrollbar', () => {
    const { view } = build()
    paint(view)
    const metrics = view.scrollMetrics()
    expect(metrics.total).toBeGreaterThan(metrics.visible)
    expect(metrics.visible).toBe(10)
  })

  it('toggles a tool card open and closed', () => {
    const document = new SessionDocument()
    const entry = document.addToolCall({ callId: 'c', name: 'bash', args: '{"command":"ls"}', turn: 0, step: 0, time: 0 })
    document.finishToolCall('c', { text: 'out', isError: false })
    const view = new TranscriptView(document, theme)
    const collapsed = view.rowsFor(60, palette).length
    view.toggleEntry(entry.id)
    expect(view.rowsFor(60, palette).length).toBeGreaterThan(collapsed)
  })

  it('expands and collapses every card', () => {
    const document = new SessionDocument()
    document.addToolCall({ callId: 'a', name: 'x', args: '{}', turn: 0, step: 0, time: 0 })
    document.addToolCall({ callId: 'b', name: 'y', args: '{}', turn: 0, step: 0, time: 1 })
    const view = new TranscriptView(document, theme)
    view.expandAll()
    const expanded = view.rowsFor(60, palette).length
    view.collapseAll()
    expect(view.rowsFor(60, palette).length).toBeLessThan(expanded)
  })

  it('rebuilds rows when the width changes', () => {
    // Content that actually wraps has to be used: a one-word entry occupies one
    // row at every width, so it would prove nothing.
    const document = new SessionDocument()
    document.addUser('the quick brown fox jumps over the lazy dog and keeps going', 1)
    const view = new TranscriptView(document, theme)
    const narrow = view.rowsFor(30, palette).length
    const wide = view.rowsFor(100, palette).length
    expect(narrow).toBeGreaterThan(wide)
  })

  it('reuses cached rows for an unchanged document', () => {
    const { view } = build()
    const first = view.rowsFor(40, palette)
    const second = view.rowsFor(40, palette)
    // Identity, not equality: the point is that no work happened.
    expect(second).toBe(first)
  })

  it('rebuilds rows when the document changes', () => {
    const { view, document } = build()
    const first = view.rowsFor(40, palette)
    document.addUser('new', 999)
    expect(view.rowsFor(40, palette)).not.toBe(first)
  })

  it('paints the transcript into a buffer', () => {
    const { view } = build()
    const frame = paint(view, 40, 6)
    expect(frame.lines().join('\n')).toContain('line 39')
  })

  it('shows a remainder indicator when scrolled up', () => {
    const { view } = build()
    paint(view, 40, 10)
    view.onKey({ key: 'home' })
    const frame = paint(view, 40, 10)
    expect(frame.lines().join('\n')).toContain('more')
  })

  it('clamps the scroll when the document shrinks', () => {
    const { view, document } = build()
    paint(view)
    view.onKey({ key: 'end' })
    document.clear()
    paint(view, 40, 10)
    expect(view.offset).toBe(0)
  })
})

describe('echoed user messages', () => {
  /** A user/message event shaped the way the harness appends it. */
  const echo = (text: string, seq = 1): Parameters<typeof foldEvent>[1] => ({
    type: 'user/message',
    seq,
    time: seq * 1000,
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  })

  it('a live send is not appended twice', () => {
    // The composer adds the row locally so the user sees it instantly; the
    // harness echoes the same send as user/message. The fold must claim the
    // echo rather than append a second copy.
    const document = new SessionDocument()
    document.addUser('hello', 1, { local: true })
    const outcome = foldEvent(document, echo('hello'))
    expect(outcome.changed).toBe(true)
    expect(document.all.filter(entry => entry.kind === 'user')).toHaveLength(1)
    expect(document.all[0]?.local).toBeFalsy()
  })

  it('a replayed log has no local entries, so every message folds once', () => {
    const document = new SessionDocument()
    foldEvent(document, echo('one', 1))
    foldEvent(document, echo('two', 2))
    expect(document.all.filter(entry => entry.kind === 'user')).toHaveLength(2)
  })

  it('an echo of different text is its own entry, not a claim', () => {
    const document = new SessionDocument()
    document.addUser('hello', 1, { local: true })
    foldEvent(document, echo('a different message', 2))
    const users = document.all.filter(entry => entry.kind === 'user')
    expect(users).toHaveLength(2)
    expect(users.map(entry => entry.text)).toEqual(['hello', 'a different message'])
  })
})

describe('kinsoku (禁則) wrapping', () => {
  /** No line may start with closing punctuation or end with an opener. */
  const clean = (lines: string[]): boolean =>
    lines.every(line => !/^[，。、！？；：）」』…]/u.test(line) && !/[（「『]$/u.test(line))

  it('never leaves closing punctuation at the start of a line, at any width', () => {
    const paragraph = '这个解析器把整个文档读入内存之后才开始输出第一个token，所以首token的延迟不会低于整个文件的读取时间。正确的做法是边读边切词，把不完整的词留在缓冲区里等待下一个chunk补全。另外，缓冲区还需要处理词边界跨越chunk的情况。'
    for (let width = 20; width <= 78; width++) {
      const lines = wrapText(paragraph, width)
      expect(lines.every(line => line !== ''), `width ${width}`).toBe(true)
      expect(clean(lines), `width ${width}: ${lines.filter(l => /^[，。、]/u.test(l)).join('/')}`).toBe(true)
      for (const line of lines) expect(textWidth(line) <= width, `width ${width}`).toBe(true)
    }
  })

  it('keeps an opening bracket with the text that follows it', () => {
    const lines = wrapText('这里有一个很长的前置说明文字用来撑满行宽然后出现括号（括号里有内容）后续文字继续撑宽度继续撑宽度继续撑', 20)
    expect(clean(lines)).toBe(true)
  })
})
