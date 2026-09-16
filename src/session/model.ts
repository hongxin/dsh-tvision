/**
 * The session document: a retained, renderer-independent model of one agent
 * conversation.
 *
 * This is the piece the upstream TUI does not have, and the reason it cannot be
 * reused as-is: there, the transcript *is* the widget tree, and rows are spliced
 * into it by index as events arrive. That works for an append-only log, but it
 * makes the transcript un-repaintable — a window that scrolls, resizes, or is
 * covered and uncovered needs to re-render from state, not from a mutation
 * history.
 *
 * So the fold here produces *entries*, in order, and the view turns entries into
 * cells whenever it needs to. Entries are append-only within a turn and replaced
 * wholesale by compaction, which is exactly the semantics the session log itself
 * has.
 *
 * Two conventions are worth stating because they are load-bearing:
 *
 * - **`seq` is the ordering key.** Entries carry the log sequence number that
 *   produced them, so a late `tool/result` can find the card its `tool/call`
 *   created without a side table, and a replayed log folds to the same document.
 * - **Nothing here knows about cells.** Widths, wrapping, and glyphs are the
 *   view's business; this module would work with any renderer.
 * @module @dsh-tvision/dsh-tvision/session/model
 */

/** Which role produced an entry, used by the view to pick a style and a gutter. */
export type EntryKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'notice'
  | 'error'
  | 'context'
  | 'compaction'

/** How a tool call ended. */
export type ToolState = 'running' | 'ok' | 'error'

/** A block of assistant content, in the order the model produced it. */
export type ContentPiece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string; readonly language?: string }

/** One rendered entry in the transcript. */
export interface Entry {
  /** Stable identity: the log sequence number that created it. */
  readonly id: number
  readonly kind: EntryKind
  /** The turn and step this belongs to, for grouping and timing. */
  readonly turn?: number
  readonly step?: number
  /** Epoch milliseconds the entry was created. */
  readonly time: number
  /** Heading shown in the gutter, e.g. `You`, `Agent`, or `bash`. */
  readonly title?: string
  /** Prose body. For an assistant entry this is the accumulated visible text. */
  readonly text?: string
  /** Reasoning text, kept separate so the view can hide or dim it. */
  readonly reasoning?: string
  /** Content pieces, when the entry interleaves text, reasoning, and code. */
  readonly pieces?: readonly ContentPiece[]
  /** Tool-call identity, for a `tool` entry. */
  readonly callId?: string
  /** Tool arguments, verbatim as the model produced them. */
  readonly args?: string
  /** The tool's result text, once it has one. */
  readonly result?: string
  /** How the tool call ended. */
  readonly state?: ToolState
  /** A unified diff, when the tool produced one. */
  readonly diff?: readonly string[]
  /** Whether the entry is still being written to. */
  readonly streaming?: boolean
  /** Epoch milliseconds the step finished, for the timing footer. */
  readonly endedAt?: number
  /** Extra lines the view should show verbatim (command output, file previews). */
  readonly lines?: readonly string[]
}

/** A todo item as the todo window shows it. */
export interface TodoItem {
  readonly id: string
  readonly text: string
  readonly status: 'pending' | 'in_progress' | 'completed' | 'cancelled'
}

/** Token accounting for the status line. */
export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The agent's own state, mirrored so the chrome can render it. */
export type AgentPhase = 'idle' | 'running' | 'compacting'

/**
 * The document.
 *
 * Mutation is deliberately confined to a small set of named operations, each
 * mirroring one session event, so the fold is auditable against the log format
 * rather than being an opaque pile of setters.
 */
export class SessionDocument {
  private readonly entries: Entry[] = []
  private readonly byCallId = new Map<string, number>()
  private nextSyntheticId = -1
  /** The assistant entry currently being streamed, if any. */
  private openAssistant: Entry | undefined
  private todos: TodoItem[] = []
  private title: string | undefined
  private phase: AgentPhase = 'idle'
  private phaseStartedAt = 0
  /** Tokens as reported by the most recent assistant message. */
  readonly tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  /** Total tokens the session has spent, for the pressure bar. */
  contextTokens = 0
  /** The model route, as `provider/model`. */
  model: string | undefined
  private readonly listeners = new Set<() => void>()
  private version = 0

  /** Every entry, oldest first. */
  get all(): readonly Entry[] {
    return this.entries
  }

  /** The task list as last written. */
  get todoList(): readonly TodoItem[] {
    return this.todos
  }

  /** The session title, once the title plugin has produced one. */
  get sessionTitle(): string | undefined {
    return this.title
  }

  /** Whether the agent is mid-turn or compacting. */
  get agentPhase(): AgentPhase {
    return this.phase
  }

  /** When the current phase began. */
  get phaseSince(): number {
    return this.phaseStartedAt
  }

  /**
   * A counter that increments on every mutation. A view can compare it against
   * the value it last rendered to decide whether its cached rows are stale,
   * which is cheaper and less error-prone than invalidating by hand.
   */
  get revision(): number {
    return this.version
  }

  /**
   * Subscribe to mutations.
   * @param listener - Called after each mutation, coalesced by the caller.
   * @returns An unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Notify subscribers that the document changed. */
  private touch(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  /** Discard everything, as a fresh session does. */
  clear(): void {
    this.entries.length = 0
    this.byCallId.clear()
    this.openAssistant = undefined
    this.todos = []
    this.title = undefined
    this.phase = 'idle'
    this.contextTokens = 0
    this.tokens.input = 0
    this.tokens.output = 0
    this.tokens.cacheRead = 0
    this.tokens.cacheWrite = 0
    this.touch()
  }

  /**
   * Append an entry.
   * @param entry - The entry, without an id.
   * @returns The stored entry, with its id assigned.
   */
  push(entry: Omit<Entry, 'id'> & { id?: number }): Entry {
    const id = entry.id ?? this.nextSyntheticId--
    const stored: Entry = { ...entry, id }
    this.entries.push(stored)
    this.touch()
    return stored
  }

  /**
   * Replace an entry in place, preserving its position.
   * @param id - The entry id.
   * @param patch - Fields to merge.
   * @returns The updated entry, or undefined when the id is unknown.
   */
  update(id: number, patch: Partial<Entry>): Entry | undefined {
    const index = this.entries.findIndex(entry => entry.id === id)
    if (index < 0) return undefined
    const current = this.entries[index]
    /* c8 ignore next -- the index came from findIndex. */
    if (current === undefined) return undefined
    const next: Entry = { ...current, ...patch }
    this.entries[index] = next
    this.touch()
    return next
  }

  /**
   * Add a user turn.
   * @param text - The prompt text.
   * @param time - When it was submitted.
   * @param options - `synthetic` marks injected context rather than a human.
   * @returns The stored entry.
   */
  addUser(text: string, time: number, options: { synthetic?: boolean; label?: string } = {}): Entry {
    return this.push({
      kind: options.synthetic === true ? 'context' : 'user',
      time,
      title: options.label ?? (options.synthetic === true ? 'Context' : 'You'),
      text,
    })
  }

  /**
   * Open an assistant entry for streaming.
   * @param position - The turn and step being streamed.
   * @param time - When the step started.
   * @returns The stored entry.
   */
  beginAssistant(position: { turn: number; step: number }, time: number): Entry {
    const entry = this.push({
      kind: 'assistant',
      turn: position.turn,
      step: position.step,
      time,
      title: position.step === 0 ? 'Agent' : `Agent · step ${position.step + 1}`,
      text: '',
      streaming: true,
    })
    this.openAssistant = entry
    return entry
  }

  /**
   * Append streamed text to the open assistant entry, creating one when a chunk
   * arrives before its step boundary did.
   * @param position - The turn and step the chunk belongs to.
   * @param piece - The content piece.
   * @param time - When the chunk arrived.
   */
  streamChunk(
    position: { turn: number; step: number },
    piece: ContentPiece,
    time: number,
  ): void {
    let target = this.openAssistant
    if (target === undefined || target.turn !== position.turn || target.step !== position.step) {
      target = this.beginAssistant(position, time)
    }
    const pieces = [...(target.pieces ?? [])]
    const last = pieces[pieces.length - 1]
    // Consecutive chunks of the same kind extend one piece; that is what makes a
    // streamed answer wrap as prose rather than as one paragraph per token.
    if (last !== undefined && last.kind === piece.kind) {
      pieces[pieces.length - 1] = { ...last, text: last.text + piece.text }
    } else {
      pieces.push(piece)
    }
    const reasoning = pieces.filter(part => part.kind === 'reasoning').map(part => part.text).join('')
    const text = pieces.filter(part => part.kind === 'text').map(part => part.text).join('')
    const index = this.entries.indexOf(target)
    /* c8 ignore next -- the entry came from this array. */
    if (index < 0) return
    const next: Entry = { ...target, pieces, reasoning, text, streaming: true }
    this.entries[index] = next
    this.openAssistant = next
    this.touch()
  }

  /**
   * Settle the open assistant entry with the model's final content, which may
   * differ from the streamed prefix when the provider rewrote it.
   * @param position - The turn and step.
   * @param content - The final content pieces.
   * @param time - When the message settled.
   */
  settleAssistant(
    position: { turn: number; step: number },
    content: readonly ContentPiece[],
    time: number,
  ): void {
    const target = this.openAssistant
    if (target === undefined) {
      const created = this.beginAssistant(position, time)
      const createdIndex = this.entries.indexOf(created)
      /* c8 ignore next -- the entry came from this array. */
      if (createdIndex >= 0) {
        this.entries[createdIndex] = {
          ...created,
          pieces: content,
          text: content.filter(part => part.kind === 'text').map(part => part.text).join(''),
          reasoning: content.filter(part => part.kind === 'reasoning').map(part => part.text).join(''),
          streaming: false,
        }
      }
      this.openAssistant = undefined
      this.touch()
      return
    }
    const text = content.filter(part => part.kind === 'text').map(part => part.text).join('')
    const reasoning = content.filter(part => part.kind === 'reasoning').map(part => part.text).join('')
    const index = this.entries.indexOf(target)
    this.entries[index] = {
      ...target,
      pieces: content,
      text: text === '' ? target.text : text,
      reasoning: reasoning === '' ? target.reasoning : reasoning,
      streaming: false,
    }
    this.openAssistant = undefined
    this.touch()
  }

  /**
   * Finish the open assistant entry, recording when the step ended so the view
   * can show a duration.
   * @param position - The turn and step.
   * @param time - When the step ended.
   */
  endStep(position: { turn: number; step: number }, time: number): void {
    const target = this.openAssistant
    if (target !== undefined && target.turn === position.turn && target.step === position.step) {
      const index = this.entries.indexOf(target)
      this.entries[index] = { ...target, streaming: false, endedAt: time }
      this.openAssistant = undefined
      this.touch()
      return
    }
    // A step that produced no visible content still deserves a marker, or a turn
    // that only called tools looks like it did nothing.
    const last = this.entries[this.entries.length - 1]
    if (last !== undefined && last.kind === 'tool' && last.turn === position.turn) {
      this.touch()
    }
  }

  /**
   * Record a tool call, or attach to an existing card for the same call id.
   * @param call - The call facts.
   * @returns The stored entry.
   */
  addToolCall(
    call: { callId: string; name: string; args: string; turn: number; step: number; time: number },
  ): Entry {
    const existingId = this.byCallId.get(call.callId)
    if (existingId !== undefined) {
      const updated = this.update(existingId, { state: 'running' })
      /* c8 ignore next -- the id came from the map. */
      if (updated !== undefined) return updated
    }
    const entry = this.push({
      kind: 'tool',
      turn: call.turn,
      step: call.step,
      time: call.time,
      title: call.name,
      callId: call.callId,
      args: call.args,
      state: 'running',
    })
    this.byCallId.set(call.callId, entry.id)
    this.touch()
    return entry
  }

  /**
   * Attach a result to a tool call card.
   * @param callId - The call identity.
   * @param result - The result facts.
   * @returns The updated entry, or undefined when no card exists for the call.
   */
  finishToolCall(
    callId: string,
    result: { text: string; isError: boolean; diff?: readonly string[]; lines?: readonly string[] },
  ): Entry | undefined {
    const id = this.byCallId.get(callId)
    if (id === undefined) return undefined
    return this.update(id, {
      result: result.text,
      state: result.isError ? 'error' : 'ok',
      diff: result.diff,
      lines: result.lines,
    })
  }

  /**
   * Replace the task list.
   * @param todos - The new list.
   */
  setTodos(todos: readonly TodoItem[]): void {
    this.todos = [...todos]
    this.touch()
  }

  /**
   * Set the session title.
   * @param title - The title.
   */
  setTitle(title: string): void {
    if (this.title === title) return
    this.title = title
    this.touch()
  }

  /**
   * Set the model route label.
   * @param label - `provider/model`.
   */
  setModel(label: string): void {
    if (this.model === label) return
    this.model = label
    this.touch()
  }

  /**
   * Move the agent between phases.
   * @param phase - The new phase.
   * @param time - When it began.
   */
  setPhase(phase: AgentPhase, time: number): void {
    if (this.phase === phase) return
    this.phase = phase
    this.phaseStartedAt = time
    this.touch()
  }

  /**
   * Add a notice, an error banner, or a compaction marker.
   * @param kind - Which of those.
   * @param text - The message.
   * @param time - When it happened.
   * @returns The stored entry.
   */
  addNotice(kind: 'notice' | 'error' | 'compaction', text: string, time: number): Entry {
    const entry = this.push({
      kind,
      time,
      title: kind === 'error' ? 'Error' : kind === 'compaction' ? 'Context' : undefined,
      text,
    })
    this.touch()
    return entry
  }

  /**
   * Record token usage from one assistant message.
   * @param usage - The reported usage.
   */
  addUsage(usage: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }): void {
    // Usage is per request, not cumulative, so the totals accumulate here and the
    // last reported total is what the context bar shows.
    this.tokens.input += usage.input ?? 0
    this.tokens.output += usage.output ?? 0
    this.tokens.cacheRead += usage.cacheRead ?? 0
    this.tokens.cacheWrite += usage.cacheWrite ?? 0
    if (usage.total !== undefined) this.contextTokens = usage.total
    this.touch()
  }

  /**
   * Look up a tool card by its call identity.
   * @param callId - The call identity.
   * @returns The entry, or undefined.
   */
  toolEntry(callId: string): Entry | undefined {
    const id = this.byCallId.get(callId)
    return id === undefined ? undefined : this.entries.find(entry => entry.id === id)
  }

  /**
   * A cheap digest of the document's shape, for the debug overlay and for tests
   * that want to assert "nothing changed" without deep-comparing entries.
   * @returns Counts by kind plus the revision.
   */
  summary(): { revision: number; total: number; byKind: Record<string, number>; streaming: boolean } {
    const byKind: Record<string, number> = {}
    for (const entry of this.entries) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    return {
      revision: this.version,
      total: this.entries.length,
      byKind,
      streaming: this.openAssistant !== undefined,
    }
  }
}

/**
 * Split assistant text into pieces, lifting fenced code blocks out so the view
 * can paint them differently.
 *
 * This is deliberately not a Markdown parser: the tool-call cards and diffs are
 * the parts of a coding transcript that need structure, and prose reads fine as
 * prose. Fenced blocks are the one exception, because a shell transcript with
 * no visual separation is genuinely hard to read.
 * @param text - The assistant's raw text.
 * @returns Pieces in order.
 */
export function splitFencedCode(text: string): ContentPiece[] {
  const pieces: ContentPiece[] = []
  const pattern = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/gu
  let cursor = 0
  for (;;) {
    const match = pattern.exec(text)
    if (match === null) break
    const before = text.slice(cursor, match.index)
    if (before !== '') pieces.push({ kind: 'text', text: before })
    const language = (match[1] ?? '').trim()
    pieces.push({
      kind: 'code',
      text: match[2] ?? '',
      ...(language === '' ? {} : { language }),
    })
    cursor = match.index + match[0].length
  }
  const rest = text.slice(cursor)
  if (rest !== '') pieces.push({ kind: 'text', text: rest })
  return pieces.length === 0 ? [{ kind: 'text', text }] : pieces
}

/**
 * Read the visible text out of a model content block, skipping blocks that have
 * no textual form (images, tool calls) and flattening the ones that do.
 * @param blocks - Content blocks from an assistant message.
 * @returns The concatenated text and reasoning.
 */
export function readContentBlocks(
  blocks: readonly { type: string; text?: string; thinking?: string }[],
): ContentPiece[] {
  const pieces: ContentPiece[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
      pieces.push(...splitFencedCode(block.text))
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
      pieces.push({ kind: 'reasoning', text: block.thinking })
    }
  }
  return pieces
}
