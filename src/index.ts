/**
 * The DSH plugin: the bridge between the harness and the tvision desktop.
 *
 * Everything DSH-specific lives here. The application (`app/app.ts`) knows only
 * an {@link AppHost}; this module is the one implementation of that interface
 * that talks to a real agent, which is what keeps the desktop testable without a
 * harness and the harness integration readable in one file.
 *
 * Three seams are worth understanding, because they are where a terminal front
 * end either works or fails silently:
 *
 * - **Conversation** is one `session/event` subscription folded into the
 *   document. The agent owns the log; this module only reads it, so a replay
 *   produces the same screen as the live turn did.
 * - **Approvals and questions** are Cordis *waterfall* events, not services you
 *   register with. A front end claims one by returning an answer and delegates
 *   by calling `next()`. Getting this wrong is invisible: the harness fails
 *   closed to `unavailable` and every gated tool call is denied with a message
 *   about a missing approval channel.
 * - **Commands** are invoked as `execute(agent, line, attachments, signal)` —
 *   four arguments, and the signal must be real, because the runtime reads
 *   `signal.aborted` before dispatching.
 * @module dsh-tvision
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-token-meter'
import { TvisionApp, WINDOW_IDS, type AppHost } from './app/app.ts'
import { ProjectIndex } from './app/project.ts'
import { createProjectWatcher } from './app/project-watch.ts'
import { DEFAULT_SKIN_ID, findSkin, SKINS, skinOrDefault, type Skin } from './kit/skin.ts'
import { ProcessTerminal } from './term/process-terminal.ts'

export { TvisionApp } from './app/app.ts'
export type { AppHost, AppInfo, AppTerminal } from './app/app.ts'
export { SKINS, findSkin, skinOrDefault } from './kit/skin.ts'
export { VERSION } from './version.ts'

import { VERSION } from './version.ts'

/** Plugin name, as Cordis reports it. */
export const name = 'tvision'

/** Services the plugin needs before it may mount. */
export const inject = ['agents', 'commands']

/**
 * The plugin's configuration, as the profile's patch layer supplies it.
 *
 * Every field is optional so a deployment can override one thing without
 * restating the rest, and so a `!!js` expression in the patch can compute it.
 */
export interface Config {
  /** The session id of the agent this front end drives (default `main`). */
  readonly sessionId?: string
  /** The skin id to start with (default `tvision`). */
  readonly skin?: string
  /** Whether reasoning is initially visible (default true). */
  readonly showReasoning?: boolean
  /** Whether to enable mouse reporting (default true). */
  readonly mouse?: boolean
  /** A line to print once the terminal is released on exit. */
  readonly goodbye?: string
}

/** The persisted preference shape: today, the remembered skin. */
const TVISION_SETTINGS = z.object({ skin: z.string().default(DEFAULT_SKIN_ID) })

/** How long to wait after a file-changing tool before re-indexing the workspace. */
export const PROJECT_REINDEX_DEBOUNCE_MS = 1500

/** How many sessions get their title read, since each one costs a log read. */
export const SESSION_TITLE_LIMIT = 40

/**
 * Whether an event is a tool result for a tool that could have changed files.
 *
 * A blunt filter on purpose: the alternative is a registry of which tools write,
 * which would go stale the moment a plugin adds one. Re-indexing after a shell
 * command that changed nothing costs one walk; *not* re-indexing after one that
 * added a file leaves the window lying.
 * @param event - The session event.
 * @returns True when the workspace may have changed.
 */
export function isFileMutatingTool(event: { type: string; data?: unknown }): boolean {
  if (event.type !== 'tool/result') return false
  const data = event.data
  if (data === null || typeof data !== 'object') return false
  const name = (data as { name?: unknown }).name
  if (typeof name === 'string') {
    return /^(bash|pwsh|shell|edit|write|str_replace|apply_patch|notebook|create|delete|move)/iu.test(name)
  }
  // A result with a tool-private diff in its metadata came from a writer.
  const meta = (data as { meta?: unknown }).meta
  return meta !== null && typeof meta === 'object'
}

/**
 * The user's home directory, for collapsing workspace paths in the list.
 * @returns The path, or undefined when it cannot be determined.
 */
function homeDirectory(): string | undefined {
  return process.env['HOME'] ?? process.env['USERPROFILE']
}

/** The terminal-mode service a host may use to hand the screen over. */
export abstract class TvisionService extends Service {
  /** The running application, once the terminal is up. */
  abstract readonly app: TvisionApp | undefined
  /**
   * Release the terminal, run `task`, and take it back. Used by anything that
   * needs the screen to itself for a moment, such as an in-place resume.
   * @param task - The work to run with the terminal released.
   * @returns Whatever `task` returned.
   */
  abstract suspend<T>(task: () => Promise<T>): Promise<T>
}

/** What {@link mount} needs. */
export interface MountInput {
  readonly ctx: Context
  readonly agent: Agent
  readonly config: Config
  readonly terminal: ProcessTerminal
  /** Called when the user asks to leave; the launcher owns the exit. */
  readonly requestExit: () => void
  /**
   * The jobs registry slot, filled by mount's `ctx.inject(['jobs'])` and read
   * by the host's `killJob`. Behind a mutable slot so neither side touches a
   * service that may not exist in this composition.
   */
  readonly jobsSlot: {
    list?: (caller: unknown) => unknown[]
    kill?: (id: string, caller: unknown, reason?: string) => void
  }
  /**
   * The settings seam: `read` yields the remembered skin id when the settings
   * service has resolved one, `save` persists a new choice. Both optional —
   * a composition without the service boots with the flag/default alone.
   */
  readonly settings: {
    read?(): string | undefined
    save?(id: string): void
    watch?(listener: (next: { skin?: string }) => void): void
  }
  /**
   * The credentials seam: `sync` pushes the resolved key state into the app
   * (the service's describe is async, so this is push-shaped), and `save`
   * stores a new key. Both optional — a composition without the credentials
   * service shows nothing and stores nothing.
   */
  readonly credentials: {
    sync?(state: { configured: boolean; source?: string } | undefined): void
    save?(key: string): Promise<void>
  }
}

/**
 * Read the starting skin, by precedence: the `--skin` flag, then the choice
 * remembered in settings, then the shipped default. An explicit flag outranks
 * the memory — a one-off look must not rewrite a preference the user did not
 * change — and an unknown id anywhere falls back to the catalogue's first
 * entry rather than failing the boot.
 * @param config - The plugin configuration (flag-derived skin, when present).
 * @param saved - The remembered skin id from the settings service, if any.
 * @returns The skin.
 */
export function resolveSkin(config: Config, saved?: string): Skin {
  return findSkin(config.skin ?? saved ?? DEFAULT_SKIN_ID) ?? SKINS[0] ?? (() => {
    /* c8 ignore next -- the catalogue is never empty. */
    throw new Error('tvision: no skins loaded')
  })()
}

/**
 * Build the host that connects the application to one agent.
 *
 * The host is a plain object rather than a class because it is a set of
 * closures over the agent and the context, and nothing ever needs to inspect it.
 * @param input - Context, agent, config, and terminal.
 * @returns The host and a disposer for the work it started.
 */
export function createHost(input: MountInput): { host: AppHost; dispose(): void } {
  const { ctx, agent, config, terminal } = input
  const controllers = new Set<AbortController>()
  const project = new ProjectIndex(agent.session.header.cwd ?? process.cwd())
  let app: TvisionApp | undefined
  let quitting = false
  /**
   * The route's advertised context window, memoised. Reading it meant scanning
   * the whole event log backwards — on every painted frame, because the status
   * line asks per frame. Only a new `request/context` event can change the
   * answer, so that is the only invalidation.
   */
  let cachedContextWindow: number | undefined
  // The jobs registry rides in on the input; see MountInput.jobsSlot.
  const jobsSlot = input.jobsSlot

  const host: AppHost = {
    send(text: string): void {
      // A prompt sent while the agent is working steers the current step;
      // otherwise it opens a turn. That is what a terminal user expects from
      // Enter, and it is the same rule the web surface uses.
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      })
      try {
        if (agent.status === 'running') agent.steer(message)
        else agent.followup(message)
      } catch (error) {
        app?.document.addNotice('error', `Could not send: ${describe(error)}`, Date.now())
      }
    },
    async runCommand(line: string) {
      const controller = new AbortController()
      controllers.add(controller)
      try {
        // Four arguments: the runtime reads `signal.aborted` immediately, so
        // passing the signal in the attachments slot throws before dispatch.
        const execution = await ctx.commands.execute(agent, line, [], controller.signal)
        if (execution === undefined) return undefined
        return execution.result.kind === 'error'
          ? { kind: 'error' as const, text: execution.result.text }
          : {
              kind: 'success' as const,
              ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
            }
      } finally {
        controllers.delete(controller)
      }
    },
    cancel(): void {
      agent.cancel({ kind: 'user' })
    },
    commands: () => ctx.commands.list(agent).map(command => ({
      name: command.name,
      description: command.description,
    })),
    modelLabel: () => {
      const options = agent.options as { provider?: string; model?: string } | undefined
      if (options?.provider === undefined || options.model === undefined) return undefined
      return `${options.provider}/${options.model}`
    },
    contextWindow: () => {
      if (cachedContextWindow !== undefined) return cachedContextWindow
      // The route's advertised window rides `request/context`, which is absent
      // until the first request — which reads correctly as "not yet known" and
      // hides the pressure bar rather than showing a fabricated one.
      const events = agent.session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index--) {
        const event = events[index]
        if (event?.type !== 'request/context') continue
        const contextWindow = (event.data as { contextWindow?: number }).contextWindow
        if (typeof contextWindow === 'number') {
          cachedContextWindow = contextWindow
          return contextWindow
        }
      }
      return 0
    },
    async resume(sessionId: string, cwd?: string): Promise<never> {
      const host = ctx.get('tvisionResumeHost')
      if (host === undefined) {
        throw new Error('this launcher cannot resume in place; restart with --resume')
      }
      // Never returns on success.
      return host.handoff(sessionId, cwd)
    },
    async indexFiles() {
      const snapshot = project.refresh()
      return {
        rows: project.rows(),
        paths: snapshot.files.map(file => file.path),
        summary: project.summary(),
      }
    },
    // The `@file` completion reads the same index the Project window shows, so
    // the two can never disagree about what exists. Without this the Tab
    // completion is silently dead in production — the demo supplies its own
    // list, which is why the gap did not show there.
    files: (prefix: string): readonly string[] => project.complete(prefix),
    killJob: (id: string): void => {
      if (jobsSlot.kill === undefined) {
        ctx.logger.warn(`tvision: no jobs registry; cannot kill ${id}`)
        return
      }
      jobsSlot.kill(id, agent)
    },
    saveSkin: (id: string): void => {
      input.settings.save?.(id)
    },
    saveApiKey: (key: string): Promise<void> => {
      if (input.credentials.save === undefined) {
        return Promise.reject(new Error('this composition has no credentials service'))
      }
      return input.credentials.save(key)
    },
    quit(): void {
      if (quitting) return
      quitting = true
      input.requestExit()
    },
  }

  return {
    host,
    dispose: () => {
      for (const controller of controllers) controller.abort()
      controllers.clear()
      if (config.goodbye !== undefined) terminal.write(`\n${config.goodbye}\n`)
      app = undefined
    },
    // `app` is assigned by `mount` through this setter, so the host's closures
    // can reach the desktop without a circular construction. `invalidateContext`
    // rides the same object: the mount owns the event subscription that knows
    // when a new `request/context` has arrived.
    ...({
      attach: (instance: TvisionApp) => { app = instance },
      invalidateContext: () => { cachedContextWindow = undefined },
      projectRoot: project.indexedRoot,
    } as object),
  }
}

/**
 * Describe any thrown value as a one-line message.
 * @param error - Whatever was thrown.
 * @returns A readable string.
 */
function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Mount the desktop against one agent and start reading the terminal.
 * @param input - Context, agent, config, and terminal.
 * @returns A disposer that releases the terminal.
 */
export function mount(input: MountInput): () => void {
  const { ctx, agent, config, terminal } = input
  if (input.jobsSlot === undefined) throw new Error('tvision: mount needs a jobsSlot')
  const handle = createHost(input)
  const attach = (handle as unknown as { attach?: (app: TvisionApp) => void }).attach
  const size = terminal.size()
  const app = new TvisionApp({
    terminal: {
      get columns(): number { return terminal.columns },
      get rows(): number { return terminal.rows },
      write: (data: string) => terminal.write(data),
    },
    host: handle.host,
    info: {
      name: 'tvision',
      version: VERSION,
      sessionId: String(agent.id),
      cwd: agent.session.header.cwd ?? process.cwd(),
    },
    skin: resolveSkin(config, input.settings.read?.()),
  })
  attach?.(app)
  // Credential state flows one way: the seam pushes, the app displays. The
  // seam may have read the service before this effect ran, so attach the sink
  // and replay whatever it already knows.
  const credentialSeam = input.credentials as MountInput['credentials'] & {
    last?: { configured: boolean; source?: string }
    push?: (state: { configured: boolean; source?: string } | undefined) => void
  }
  credentialSeam.push = (state) => { app.setCredentialState(state) }
  if (credentialSeam.last !== undefined) app.setCredentialState(credentialSeam.last)
  input.credentials.sync = credentialSeam.sync

  // The settings user layer resolves after this effect runs on a cold boot, so
  // the remembered skin can arrive one frame late; watch keeps it honest.
  input.settings.watch?.((next) => {
    if (config.skin === undefined && next.skin !== undefined) {
      app.setSkin(skinOrDefault(next.skin))
    }
  })

  // 1. The conversation: one subscription, folded into the document. A tool that
  //    touched the filesystem also invalidates the project index, which is why
  //    the fold reports that rather than the view guessing at it.
  const invalidateContext = (handle as unknown as { invalidateContext?: () => void }).invalidateContext
  const offSession = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    // A new advertised context window rides this event and nothing else; the
    // host's memoised value dies with it. The cast mirrors the event's own shape.
    if ((event as { type?: string }).type === 'request/context') invalidateContext?.()
    void app.applyEvent(event as unknown as { type: string; seq: number; time: number; data?: unknown })
      .then(() => {
        if (isFileMutatingTool(event)) void refreshProject()
      })
  })

  // 2. Agent lifecycle keeps the running indicator honest when a turn is
  //    cancelled without a closing event.
  const offStatus = ctx.on('agent/status', () => {
    app.windows.requestRender()
  })

  // 3. Approvals: claim the waterfall for our own agent, delegate otherwise.
  //    Returning an outcome is what makes gated tools work at all; with no
  //    answerer the harness fails closed and denies every one of them.
  const offApproval = ctx.on('approval/request', async (request, next) => {
    if (request.agent !== agent) return next()
    return app.askApproval({
      toolName: request.toolName,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  })

  // 4. Structured questions, including plan review, which arrives as one.
  const offQuestions = ctx.on('user-questions/request', async (request, next) => {
    const answer = await app.askQuestions(request)
    return answer ?? next()
  })

  // 5. The window contents the host owns. Both are populated once at mount and
  //    refreshed on the events that can change them, never on the frame loop.
  void app.refreshProject()
  void refreshSessions()
  const offCreated = ctx.on('agent/created', () => { void refreshSessions() })

  // 7. The workspace watcher: external edits land in the Project window too.
  //    It rides the same coalescing refresh the tool trigger uses, so a burst
  //    of editor saves costs one walk, and its own debounce absorbs the
  //    write-settle churn chokidar reports per file.
  const stopWatcher = createProjectWatcher(
    (handle as unknown as { projectRoot?: string }).projectRoot ?? process.cwd(),
    () => { void refreshProject() },
    error => { ctx.logger.warn(`tvision: workspace watcher failed: ${String(error)}`) },
  )

  // 6. Background jobs: a service subscription, not session events — a job
  //    outlives the turn that started it. The callback only runs when a
  //    registry exists, so a composition without one keeps the empty window.
  void ctx.inject(['jobs'], () => {
    const registry = ctx.get('jobs') as unknown as {
      list: (caller: unknown) => unknown[]
      kill: (id: string, caller: unknown, reason?: string) => void
      onJobsChanged: (listener: () => void) => () => void
    }
    input.jobsSlot.list = (caller) => registry.list(caller)
    input.jobsSlot.kill = (id: string, caller: unknown, reason?: string) => { registry.kill(id, caller, reason) }
    const sync = (): void => {
      app.setJobs(registry.list(agent) as readonly import('./app/jobs.ts').JobSummary[])
    }
    sync()
    return registry.onJobsChanged(sync)
  })

  let projectTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Re-index the workspace. Coalesced: a turn can run a dozen shell commands and
   * each one would otherwise trigger a full walk.
   * @returns A promise that settles when the re-index has been scheduled.
   */
  async function refreshProject(): Promise<void> {
    if (projectTimer !== undefined) clearTimeout(projectTimer)
    projectTimer = setTimeout(() => {
      projectTimer = undefined
      void app.refreshProject()
    }, PROJECT_REINDEX_DEBOUNCE_MS)
  }

  /**
   * Load the resumable sessions into the Sessions window.
   * @returns A promise that settles when the list has been applied.
   */
  async function refreshSessions(): Promise<void> {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return
    try {
      const records = await query.listSessions()
      // Titles cost a log read each, so only the visible page is asked for.
      const page = records.slice(0, SESSION_TITLE_LIMIT)
      const titles = new Map<string, string>()
      if (page.length > 0) {
        const snapshots = await query.readTitleSnapshots(page.map(record => record.header.id))
        for (const observation of snapshots) {
          // A rejected observation is isolated to its session: leave that row
          // untitled and keep the rest of the list.
          if (observation.status !== 'fulfilled') continue
          const title = observation.value.title?.title
          if (typeof title === 'string' && title !== '') {
            titles.set(String(observation.sessionId), title)
          }
        }
      }
      app.setSessions(records.map(record => ({
        id: String(record.header.id),
        createdAt: record.header.createdAt,
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        live: record.live,
        persisted: record.persisted,
        ...(titles.get(String(record.header.id)) === undefined
          ? {}
          : { title: titles.get(String(record.header.id)) }),
      })), homeDirectory())
    } catch (error) {
      // A query failure must not take the desktop down; the window simply says so.
      app.setWindowTitle(WINDOW_IDS.sessions, 'Sessions — unavailable')
      ctx.logger.warn(`tvision: could not list sessions: ${String(error)}`)
    }
  }

  const escapeFlush = (): void => app.flushInput()
  terminal.onEscapeTimeout = escapeFlush
  terminal.setTitle(`tvision — ${String(agent.id)}`)
  app.start()

  // 6. The repaint pump. Everything above only *marks* frames due; without this
  //    loop the desktop paints once at mount and never again, no matter what the
  //    agent streams or the user types. The demo has its own; this is the one
  //    the real profile runs on.
  const stopFrameLoop = app.startFrameLoop()

  // 5. Terminal input: raw mode in, decoded events out. The terminal owns the
  //    ESC timeout, because only it knows when input went quiet.
  terminal.start(
    chunk => app.feed(chunk),
    () => app.handle({ type: 'resize', columns: terminal.columns, rows: terminal.rows }),
  )

  return () => {
    // Stop the watcher first: an event landing after teardown would schedule
    // a refresh onto an app that no longer owns a terminal.
    stopWatcher()
    // Stop the pump first: a tick that lands after the alternate screen is
    // left paints a frame onto the shell the user just got back.
    stopFrameLoop()
    offSession()
    offStatus()
    offCreated()
    if (projectTimer !== undefined) clearTimeout(projectTimer)
    offApproval()
    offQuestions()
    terminal.onEscapeTimeout = undefined
    app.stop()
    terminal.stop()
    handle.dispose()
    void size
  }
}

/**
 * Cordis plugin entry point.
 *
 * Nothing mounts until the agent it drives exists, because a front end has no
 * meaning without one. The mount is owned by an effect, so disposing the plugin
 * releases the terminal — which matters more here than anywhere else, because
 * the resource being leaked is the user's shell.
 * @param ctx - Plugin context.
 * @param config - Plugin configuration from the profile patch.
 */
/**
 * The remembered-skin seam, filled when (and only when) a settings provider
 * exists. Registered under the plugin's own namespace in $DSH_HOME/settings.yaml
 * — the same file the web surface's preferences live in.
 */
function createSettingsSeam(ctx: Context): MountInput['settings'] {
  const seam: MountInput['settings'] = {}
  void ctx.inject(['settings'], () => {
    const service = ctx.get('settings') as unknown as {
      register: (ns: string, schema: unknown) => {
        get: () => { skin?: string }
        watch: (listener: (next: { skin?: string }) => void) => () => void
        update: (patch: { skin?: string }) => Promise<void>
      }
    }
    const scope = service.register('tvision', TVISION_SETTINGS)
    seam.read = () => scope.get().skin
    seam.save = (id) => { void scope.update({ skin: id }) }
    seam.watch = (listener) => scope.watch(listener)
  })
  return seam
}

/**
 * The credentials seam, filled when a credentials provider exists. The key's
 * resolved state (configured, source) is pushed into the app — describe is
 * async, so no pull-shaped seam could answer per frame — and saves go through
 * the provider's set, which persists to $DSH_HOME/.credentials.yaml.
 */
function createCredentialsSeam(ctx: Context): MountInput['credentials'] {
  // The seam caches the latest state: the service may resolve (and describe)
  // before mount attaches its sink, and that first read is exactly the one
  // that decides whether the desktop opens with a warning.
  const seam: MountInput['credentials'] & {
    last?: { configured: boolean; source?: string }
    push?: (state: { configured: boolean; source?: string } | undefined) => void
  } = {}
  const ref = credentialRef('DEEPSEEK_API_KEY')
  void ctx.inject(['credentials'], () => {
    const service = ctx.get('credentials') as unknown as {
      describe: (ref: unknown) => Promise<{ configured: boolean; source?: string; writable: boolean }>
      set: (ref: unknown, value: string) => Promise<void>
    }
    seam.sync = (state) => {
      seam.last = state
      seam.push?.(state)
    }
    seam.save = (key) => service.set(ref, key)
    const sync = (): void => {
      void service.describe(ref)
        .then(info => seam.sync?.({ configured: info.configured, source: info.source }))
        .catch(error => ctx.logger.warn(`tvision: could not read credential state: ${String(error)}`))
    }
    // Both the initial read and every change — the provider watches its file
    // and hot-publishes external edits — land in the same place.
    sync()
    ctx.on('credentials/reference-updated', sync)
  })
  return seam
}

export function apply(ctx: Context, config: Config = {}): void {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    // Not a terminal: nothing here can work, and frame-drawing into a pipe is
    // worse than saying so.
    ctx.logger.info('tvision: stdin/stdout is not a TTY; the desktop will not mount')
    return
  }
  const wanted = (config.sessionId ?? 'main') as SessionId
  const mountFor = (agent: Agent): void => {
    ctx.effect(() => {
      const terminal = new ProcessTerminal({ mouse: config.mouse ?? true })
      const disposer = mount({
        ctx,
        agent,
        config,
        terminal,
        jobsSlot: {},
        settings: createSettingsSeam(ctx),
        credentials: createCredentialsSeam(ctx),
        requestExit: () => {
          // Leave the alternate screen first, then let the tree unwind: a
          // process that exits from inside raw mode leaves the shell broken.
          disposer()
          void ctx.root.fiber.dispose()
          ctx.appExit?.(0)
        },
      })
      return disposer
    })
  }
  const existing = ctx.agents.roots().find(candidate => candidate.id === wanted)
  if (existing !== undefined) {
    mountFor(existing)
    return
  }
  const off = ctx.on('agent/created', (payload) => {
    if (payload.agent.id !== wanted) return
    off()
    mountFor(payload.agent)
  })
  ctx.effect(() => off)
}
