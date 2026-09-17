/**
 * The event fold: session-log events into document mutations.
 *
 * Kept separate from the application so it can be tested against recorded event
 * shapes without a terminal, an agent, or a Cordis context. The rule this module
 * follows is that it knows the *log format* and nothing else — no services, no
 * widgets, no I/O — which is what makes the transcript reproducible from a
 * replay and the tests meaningful.
 * @module @dsh-tvision/dsh-tvision/app/events
 */

import type { ContentPiece, SessionDocument } from '../session/model.ts'
import { readContentBlocks } from '../session/model.ts'

/**
 * The parts of a session event this fold reads.
 *
 * Deliberately a structural subset rather than the real union: the fold should
 * not have to be edited every time an unrelated event type gains a field, and it
 * documents exactly which fields the view depends on.
 */
export interface FoldableEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data?: unknown
}

/** What the fold decided to do, for the caller to act on. */
export interface FoldOutcome {
  /** A tool result invalidated the workspace file index. */
  readonly invalidateFileSearch?: boolean
  /** The session title changed. */
  readonly titleChanged?: string
  /** A turn ended for a reason worth announcing. */
  readonly notice?: { kind: 'notice' | 'error'; text: string }
  /** The document changed, so a repaint is due. */
  readonly changed: boolean
}

/** The result when an event had no effect on the document. */
const UNCHANGED: FoldOutcome = Object.freeze({ changed: false })

/**
 * Read a nested field without a cast at every call site.
 * @param value - The object to read from.
 * @param key - The field name.
 * @returns The value, or undefined.
 */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

/**
 * Read a numeric field.
 * @param value - The object.
 * @param key - The field name.
 * @param fallback - Returned when the field is absent or not a number.
 * @returns The number.
 */
function num(value: unknown, key: string, fallback: number): number {
  const raw = field(value, key)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/**
 * Read a string field.
 * @param value - The object.
 * @param key - The field name.
 * @returns The string, or undefined.
 */
function str(value: unknown, key: string): string | undefined {
  const raw = field(value, key)
  return typeof raw === 'string' ? raw : undefined
}

/**
 * Flatten an assistant message's content blocks into view pieces.
 * @param message - The message object.
 * @returns Pieces in order.
 */
function piecesOf(message: unknown): ContentPiece[] {
  const content = field(message, 'content')
  if (!Array.isArray(content)) return []
  return readContentBlocks(content as { type: string; text?: string; thinking?: string }[])
}

/**
 * Fold one session event into the document.
 *
 * @param document - The document to mutate.
 * @param event - The event, in the log's own shape.
 * @returns What the caller should do beyond repainting.
 */
export function foldEvent(document: SessionDocument, event: FoldableEvent): FoldOutcome {
  const data = event.data
  switch (event.type) {
    case 'turn/start': {
      // A new turn clears the previous task list, which is what the todo window
      // showing stale items would otherwise fail to do.
      document.setPhase('running', event.time)
      document.setTodos([])
      return { changed: true }
    }
    case 'turn/end': {
      document.setPhase('idle', event.time)
      const reason = field(data, 'reason')
      const kind = str(reason, 'kind') ?? 'completed'
      if (kind === 'completed') return { changed: true }
      if (kind === 'aborted') {
        return { changed: true, notice: { kind: 'notice', text: 'Turn cancelled.' } }
      }
      if (kind === 'max-tokens') {
        return { changed: true, notice: { kind: 'notice', text: 'Turn hit the output-token ceiling.' } }
      }
      if (kind === 'interrupted') {
        return { changed: true, notice: { kind: 'notice', text: 'Turn was interrupted by a restart.' } }
      }
      if (kind === 'blocked') {
        return { changed: true, notice: { kind: 'notice', text: 'Turn was blocked.' } }
      }
      if (kind === 'error') {
        const detail = str(field(reason, 'error'), 'message') ?? 'unknown failure'
        return { changed: true, notice: { kind: 'error', text: `Turn failed: ${detail}` } }
      }
      return { changed: true }
    }
    case 'user/message': {
      const content = field(data, 'content')
      const text = typeof content === 'string' ? content : textOfBlocks(content)
      if (text.trim() === '') return UNCHANGED
      // `source` is an object in live logs ({kind: 'user'} | {kind: 'plugin', …})
      // and a plain string in some older ones; either way the kind is what
      // separates a human turn from injected context. Reading only the string
      // form made every plugin injection — the whole skill catalog, runtime
      // snapshots — render as `> You`, in the user's voice.
      const rawSource = field(data, 'source')
      const source = typeof rawSource === 'string' ? rawSource : str(rawSource, 'kind')
      // A live send is echoed: the composer already added this text locally so
      // the transcript would show it twice — once instantly, once from the log.
      // The echo text is byte-identical to what the composer stored (the host
      // builds the message from the same trimmed string), so matching the
      // newest local entry is sound. Replay logs carry no local entries, so
      // they fold unchanged; injected context never matches, being synthetic.
      if (source === undefined || source === 'user') {
        const echoed = claimLocalEcho(document, text, event.time)
        if (echoed) return echoed
      }
      document.addUser(text, event.time, {
        synthetic: source !== undefined && source !== 'user',
        ...(source === undefined || source === 'user' ? {} : { label: contextLabel(source) }),
      })
      return { changed: true }
    }
    case 'step/start': {
      // Deliberately no beginAssistant here. In the log, the drained
      // user/message lands *after* the step that will answer it, so an entry
      // created at step start renders the Agent header above the question on a
      // replayed session. streamChunk and settleAssistant both create the entry
      // on demand — at first content, which is after the question, exactly
      // where the live session had it.
      return { changed: true }
    }
    case 'assistant/chunk': {
      const chunk = field(data, 'chunk')
      const piece = pieceOfChunk(chunk)
      if (piece === undefined) return UNCHANGED
      document.streamChunk(
        { turn: num(data, 'turn', 0), step: num(data, 'step', 0) },
        piece,
        event.time,
      )
      return { changed: true }
    }
    case 'assistant/message': {
      const message = field(data, 'message')
      document.settleAssistant(
        { turn: num(data, 'turn', 0), step: num(data, 'step', 0) },
        piecesOf(message),
        event.time,
      )
      const usage = field(data, 'usage')
      if (usage !== undefined && usage !== null) {
        // `total` is passed only when the provider actually reported one: a NaN
        // sentinel here flowed into the context bar, whose `'█'.repeat(NaN)`
        // renders an empty bar and whose percentage reads "NaN%".
        const total = num(usage, 'total', Number.NaN)
        document.addUsage({
          input: num(usage, 'input', 0),
          output: num(usage, 'output', 0),
          cacheRead: num(usage, 'cacheRead', 0),
          cacheWrite: num(usage, 'cacheWrite', 0),
          ...(Number.isFinite(total) ? { total } : {}),
        })
      }
      if (field(data, 'interrupted') === true) {
        return { changed: true, notice: { kind: 'notice', text: 'Response was cut short.' } }
      }
      return { changed: true }
    }
    case 'step/end': {
      document.endStep({ turn: num(data, 'turn', 0), step: num(data, 'step', 0) }, event.time)
      return { changed: true }
    }
    case 'tool/call': {
      document.addToolCall({
        callId: str(data, 'callId') ?? `seq-${event.seq}`,
        name: str(data, 'name') ?? 'tool',
        args: str(data, 'arguments') ?? '',
        turn: num(data, 'turn', 0),
        step: num(data, 'step', 0),
        time: event.time,
      })
      return { changed: true }
    }
    case 'tool/result': {
      // The result cites its call from inside the message: dsh-agent-loop
      // appends {turn, step, message} with the call id at message.source.callId
      // (and again on the content block), never at the top level — a fallback
      // to `seq-<n>` here meant no result ever found its card, and every tool
      // in a real transcript stayed "running" forever.
      const callId = toolResultCallId(data) ?? `seq-${event.seq}`
      const message = field(data, 'message')
      const isError = isToolError(message, data)
      const text = toolResultText(message)
      const diff = readDiff(field(data, 'meta'))
      const entry = document.finishToolCall(callId, {
        text,
        isError,
        ...(diff === undefined ? {} : { diff }),
      })
      if (entry !== undefined) {
        // A result carries the step's end time when the log did not emit a
        // separate step/end for the tool-only step.
        document.update(entry.id, { endedAt: event.time })
      }
      return { changed: true, invalidateFileSearch: true }
    }
    case 'todo/write': {
      const todos = field(data, 'todos')
      if (!Array.isArray(todos)) return UNCHANGED
      document.setTodos(todos.map((item, index) => ({
        id: str(item, 'id') ?? String(index),
        text: str(item, 'text') ?? str(item, 'content') ?? '',
        status: normalizeTodoStatus(str(item, 'status')),
      })))
      return { changed: true }
    }
    case 'session/title': {
      const title = str(data, 'title')
      if (title === undefined || title === '') return UNCHANGED
      document.setTitle(title)
      return { changed: true, titleChanged: title }
    }
    case 'compaction/start': {
      document.setPhase('compacting', event.time)
      document.addNotice('compaction', 'Compacting context…', event.time)
      return { changed: true }
    }
    case 'compaction/end': {
      document.addNotice('compaction', 'Context compacted.', event.time)
      document.setPhase('idle', event.time)
      return { changed: true }
    }
    case 'llm/retry': {
      const attempt = num(data, 'attempt', 0)
      const message = str(data, 'message') ?? 'retrying'
      document.addNotice('notice', `Retrying (attempt ${attempt}): ${message}`, event.time)
      return { changed: true }
    }
    default:
      return UNCHANGED
  }
}

/**
 * Match an echoed `user/message` against the newest optimistically-added entry.
 *
 * @param document - The document the composer wrote to.
 * @param text - The echoed text.
 * @param time - The echo's timestamp.
 * @returns An outcome claiming the echo when it matched, or undefined when the
 * text was not a live send (a replayed log, or a different message) and should
 * be appended as its own entry.
 */
function claimLocalEcho(document: SessionDocument, text: string, time: number): FoldOutcome | undefined {
  for (let index = document.all.length - 1; index >= 0; index--) {
    const entry = document.all[index]
    if (entry === undefined) continue
    // Only the newest local entry can be the echo; anything older is a local
    // send whose echo never arrived (a cancelled turn) and must not absorb a
    // message it did not send.
    if (entry.local !== true) return undefined
    if (entry.kind !== 'user' || entry.text !== text) return undefined
    // Clearing the flag bumps the revision so the row repaints, and keeps a
    // replayed log from folding the entry twice.
    document.update(entry.id, { local: false, time })
    return { changed: true }
  }
  return undefined
}

/**
 * Normalise a todo status string onto the view's union.
 * @param status - The raw status.
 * @returns A known status.
 */
function normalizeTodoStatus(status: string | undefined): 'pending' | 'in_progress' | 'completed' | 'cancelled' {
  switch (status) {
    case 'in_progress':
    case 'in-progress':
      return 'in_progress'
    case 'completed':
    case 'done':
      return 'completed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    /* c8 ignore next 2 -- an unknown status reads as not started. */
    default:
      return 'pending'
  }
}

/**
 * A human label for an injected-context source.
 * @param source - The log's source string.
 * @returns A short label.
 */
function contextLabel(source: string): string {
  switch (source) {
    case 'agent':
      return 'Context'
    case 'goal':
      return 'Goal'
    case 'hook':
      return 'Hook'
    case 'system':
    case 'plugin':
    case 'skill-catalog':
      return 'Context'
    /* c8 ignore next 2 -- an unrecognised source keeps its own name. */
    default:
      return source
  }
}

/**
 * Concatenate the text of a content-block array.
 * @param blocks - The blocks.
 * @returns The joined text.
 */
function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    const type = str(block, 'type')
    if (type === 'text') {
      const text = str(block, 'text')
      if (text !== undefined && text !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * Turn a streamed chunk into a view piece.
 *
 * The provider's chunk shape is not part of this module's contract beyond the
 * two kinds it can carry, so anything else is ignored rather than guessed at.
 * @param chunk - The chunk object.
 * @returns The piece, or undefined.
 */
function pieceOfChunk(chunk: unknown): ContentPiece | undefined {
  const kind = str(chunk, 'type') ?? str(chunk, 'kind')
  const delta = field(chunk, 'delta')
  const text = str(chunk, 'text') ?? str(chunk, 'delta')
  if (kind === 'thinking' || kind === 'reasoning') {
    const reasoning = str(chunk, 'text') ?? str(chunk, 'thinking') ?? (typeof delta === 'string' ? delta : undefined)
    return reasoning === undefined || reasoning === '' ? undefined : { kind: 'reasoning', text: reasoning }
  }
  if (typeof text === 'string' && text !== '') return { kind: 'text', text }
  return undefined
}

/**
 * The call id a `tool/result` event cites, wherever the harness put it.
 *
 * @param data - The event's data.
 * @returns The call id, or undefined when the event cites none.
 */
function toolResultCallId(data: unknown): string | undefined {
  const direct = str(data, 'callId')
  if (direct !== undefined) return direct
  const message = field(data, 'message')
  const fromSource = str(field(message, 'source'), 'callId')
  if (fromSource !== undefined) return fromSource
  const blocks = field(message, 'content')
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      const id = str(block, 'toolCallId')
      if (id !== undefined) return id
    }
  }
  return undefined
}

/**
 * Whether a tool result represents a failure.
 * @param message - The result message.
 * @param data - The event data, in case the flag lives there.
 * @returns True for a failure.
 */
function isToolError(message: unknown, data: unknown): boolean {
  const content = field(message, 'content')
  if (Array.isArray(content)) {
    for (const block of content) {
      if (field(block, 'isError') === true) return true
    }
  }
  if (field(message, 'isError') === true) return true
  return field(data, 'error') !== undefined && field(data, 'error') !== null
}

/**
 * Extract the text of a tool result.
 * @param message - The result message.
 * @returns The joined text.
 */
function toolResultText(message: unknown): string {
  const content = field(message, 'content')
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      const text = str(block, 'text')
      if (text !== undefined) parts.push(text)
    }
    return parts.join('\n')
  }
  return ''
}

/**
 * Pull a unified diff out of a tool's presentation metadata.
 *
 * The metadata's shape is owned by the tool that wrote it, so this reads the two
 * field names the first-party file tools use and ignores anything else rather
 * than inventing a rendering for it.
 * @param meta - The tool-private metadata.
 * @returns The diff lines, or undefined.
 */
function readDiff(meta: unknown): string[] | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  for (const key of ['diff', 'patch', 'unifiedDiff']) {
    const value = (meta as Record<string, unknown>)[key]
    if (typeof value === 'string' && value !== '') return value.split('\n')
    if (Array.isArray(value) && value.every(line => typeof line === 'string')) return value as string[]
  }
  const nested = (meta as Record<string, unknown>)['presentation']
  if (nested !== null && typeof nested === 'object') return readDiff(nested)
  return undefined
}
