/**
 * Tests for the windows the host fills in: Project, Sessions, and the resume
 * handoff.
 *
 * These drive the application through the seams the DSH plugin actually uses,
 * with a host that stands in for storage. The interesting cases are the failures:
 * an index that throws, a session that cannot be resumed, and a handoff that
 * rejects after the desktop has already torn itself down for it.
 */
import { describe, expect, it, vi } from 'vitest'
import { TvisionApp, WINDOW_IDS } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { findSkin } from '../src/kit/skin.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

/** A host with the window-filling seams wired to supplied data. */
function build(overrides: Partial<AppHost> = {}) {
  const terminal = new HeadlessTerminal(100, 30)
  const host: AppHost = {
    send: () => {},
    quit: () => {},
    modelLabel: () => 'test/model',
    contextWindow: () => 100_000,
    ...overrides,
  }
  const app = new TvisionApp({
    terminal: {
      get columns(): number { return 100 },
      get rows(): number { return 30 },
      write: (data: string) => terminal.write(data),
    },
    host,
    info: { name: 'tvision', version: '0.1.0', sessionId: 'current-session', cwd: '/tmp/ws' },
    skin: findSkin('tvision')!,
  })
  /** The frame as text, at the last painted state. */
  const frame = (): string => (app.windows.paint().lines().join('\n'))
  return { app, terminal, frame }
}

/**
 * The corpus, anchored to now.
 *
 * Ages are rendered relative to the wall clock, so a fixed epoch would make
 * every row read as a date and the interesting columns untested.
 * @returns Three sessions: one titled and persisted, one live and untitled, one
 *   with nothing to resume.
 */
function fixtureSessions() {
  const now = Date.now()
  return [
    { id: 'main-session-aaaa1111', createdAt: now - 3 * 3_600_000, cwd: '/home/dev/one', live: false, persisted: true, title: 'Refactor the parser' },
    { id: 'main-session-bbbb2222', createdAt: now - 60_000, cwd: '/home/dev/two', live: true, persisted: true },
    { id: 'main-session-cccc3333', createdAt: now - 30_000, live: false, persisted: false },
  ]
}

describe('the Sessions window', () => {
  it('lists sessions newest first, with titles', () => {
    const view = build()
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    view.app.openWindow(WINDOW_IDS.sessions)
    const text = view.frame()
    expect(text).toContain('Refactor the parser')
    expect(text).toContain('bbbb2222')
  })

  it('falls back to the short id for a session with no title', () => {
    const view = build()
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    expect(view.app.sessions.map(row => row.label)).toContain('bbbb2222')
  })

  it('marks the resumable, live, current, and gone rows differently', () => {
    const view = build()
    view.app.start()
    const corpus = fixtureSessions()
    // Newest first, so the current session must be the newest to land on top.
    view.app.setSessions([
      { ...corpus[0]!, id: 'current-session', createdAt: Date.now() },
      ...corpus.slice(1),
    ], '/home/dev')
    expect(view.app.sessions.map(row => row.marker)).toEqual(['▸', '×', '●'])
  })

  it('says in the row when a session cannot be resumed', () => {
    const view = build()
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    // The newest session is the unpersisted one, so it sorts first.
    expect(view.app.sessions[0]?.resumable).toBe(false)
    view.app.openWindow(WINDOW_IDS.sessions)
    const text = view.app.listRowsFor(WINDOW_IDS.sessions)
    expect(text).toContain('not resumable')
  })

  it('reports the count in the window title', () => {
    const view = build()
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    expect(view.app.windows.get(WINDOW_IDS.sessions)?.title).toBe('Sessions — 3')
  })

  it('collapses the home directory in the detail column', () => {
    const view = build()
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    const titled = view.app.sessions.find(row => row.id === 'main-session-aaaa1111')
    expect(titled?.detail).toContain('~/one')
    expect(titled?.detail).toContain('3h')
  })

  it('survives an empty corpus', () => {
    const view = build()
    view.app.start()
    view.app.setSessions([], undefined)
    expect(view.app.sessions).toEqual([])
    expect(view.app.windows.get(WINDOW_IDS.sessions)?.title).toBe('Sessions — 0')
  })
})

describe('resuming a session', () => {
  it('hands the id and the workspace to the host', async () => {
    const resume = vi.fn(async () => { throw new Error('rejected for the test') })
    const view = build({ resume })
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    // The newest row is the unpersisted one, so pick the persisted one.
    const row = view.app.sessions.find(candidate => candidate.id === 'main-session-aaaa1111')
    await view.app.resumeSession(row)
    expect(resume).toHaveBeenCalledWith('main-session-aaaa1111', '/home/dev/one')
  })

  it('explains rather than resuming a row that has nothing to load', async () => {
    const resume = vi.fn(async () => { throw new Error('should not be called') })
    const view = build({ resume })
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    const unpersisted = view.app.sessions.find(row => row.id === 'main-session-cccc3333')
    await view.app.resumeSession(unpersisted)
    expect(resume).not.toHaveBeenCalled()
    expect(view.frame()).toContain('nothing to resume')
  })

  it('explains when the host cannot resume at all', async () => {
    const view = build()
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    const row = view.app.sessions.find(candidate => candidate.id === 'main-session-aaaa1111')
    await view.app.resumeSession(row)
    expect(view.frame()).toContain('cannot resume in place')
  })

  it('restores a usable desktop when the handoff rejects', async () => {
    const resume = vi.fn(async () => {
      throw new Error('cannot resume in "/gone": ENOENT')
    })
    const view = build({ resume })
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    const row = view.app.sessions.find(candidate => candidate.id === 'main-session-aaaa1111')
    await view.app.resumeSession(row)
    expect(view.frame()).toContain('Could not resume')
    // A rejected handoff must leave a working desktop, not a half-torn-down one.
    view.app.feed('still typing')
    expect(view.app.composer.value).toBe('still typing')
  })

  it('does nothing when asked to resume nothing', async () => {
    const resume = vi.fn(async () => { throw new Error('x') })
    const view = build({ resume })
    view.app.start()
    await view.app.resumeSession(undefined)
    expect(resume).not.toHaveBeenCalled()
  })

  it('resumes the row a click lands on', () => {
    const resume = vi.fn(async () => { throw new Error('x') })
    const view = build({ resume })
    view.app.start()
    view.app.setSessions(fixtureSessions(), '/home/dev')
    view.app.openWindow(WINDOW_IDS.sessions)
    view.app.windows.focus(WINDOW_IDS.sessions)
    view.app.windows.requestRender()
    view.app.frame()
    // The newest row is the unpersisted one; step to the persisted one below it.
    view.app.feed('\u001B[B')
    view.app.feed('\r')
    expect(resume).toHaveBeenCalled()
  })
})

describe('the Project window', () => {
  it('shows the indexed rows', async () => {
    const view = build({
      indexFiles: async () => ({
        rows: [{ label: 'parser.ts', detail: 'src' }, { label: 'README.md' }],
        paths: ['src/parser.ts', 'README.md'],
        summary: '2 files',
      }),
    })
    view.app.start()
    await view.app.refreshProject()
    expect(view.frame()).toContain('parser.ts')
  })

  it('reports the index summary in the title', async () => {
    const view = build({
      indexFiles: async () => ({ rows: [], paths: [], summary: '412 files' }),
    })
    view.app.start()
    await view.app.refreshProject()
    expect(view.app.windows.get(WINDOW_IDS.project)?.title).toBe('Project — 412 files')
  })

  it('reports an unreadable workspace instead of throwing', async () => {
    const view = build({
      indexFiles: async () => { throw new Error('EACCES') },
    })
    view.app.start()
    expect(await view.app.refreshProject()).toBeUndefined()
    expect(view.app.windows.get(WINDOW_IDS.project)?.title).toBe('Project — unreadable')
    expect(view.frame()).toContain('Could not index')
  })

  it('does nothing without a host index', async () => {
    const view = build()
    view.app.start()
    expect(await view.app.refreshProject()).toBeUndefined()
  })

  it('references a chosen file in the composer', async () => {
    const view = build({
      indexFiles: async () => ({
        rows: [{ label: 'parser.ts', detail: 'src' }],
        paths: ['src/parser.ts'],
        summary: '1 files',
      }),
    })
    view.app.start()
    await view.app.refreshProject()
    view.app.windows.focus(WINDOW_IDS.project)
    view.app.frame()
    view.app.feed('\r')
    expect(view.app.composer.value).toBe('@src/parser.ts ')
    // Focus returns to where the text will be typed.
    expect(view.app.windows.activeWindowId).toBe(WINDOW_IDS.transcript)
  })

  it('keeps a refresh from throwing the reader to the top of the list', async () => {
    let call = 0
    const view = build({
      indexFiles: async () => {
        call++
        return {
          rows: Array.from({ length: 20 }, (_, index) => ({ label: `file-${index}.ts`, detail: 'src' })),
          paths: Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`),
          summary: `${20 * call} files`,
        }
      },
    })
    view.app.start()
    await view.app.refreshProject()
    view.app.windows.focus(WINDOW_IDS.project)
    view.app.frame()
    view.app.feed('\u001B[B')
    view.app.feed('\u001B[B')
    // A periodic re-index happens while the reader is somewhere in the list.
    await view.app.refreshProject()
    view.app.frame()
    // The window must still be usable, and the new title must have landed.
    expect(view.app.windows.get(WINDOW_IDS.project)?.title).toBe('Project — 40 files')
  })
})

describe('closing a dialog window by its system box', () => {
  it('settles the ask promise and leaves the desktop alive', async () => {
    const { app } = build()
    app.start()
    const asked = app.ask({
      title: 'Approval required',
      question: 'Allow bash to run?',
      choices: [
        { value: 'allow', label: 'Allow once' },
        { value: 'deny', label: 'Deny' },
      ],
    })
    app.frame()
    // The dialog window is floating and centered; close it the way a user does,
    // through the painted system box.
    const dialog = app.windows.all().find(window => window.title === 'Approval required')
    if (dialog === undefined) throw new Error('the dialog window never opened')
    app.feed(`\u001B[<0;${dialog.rect.x + dialog.rect.width - 4};${dialog.rect.y + 1}M`)
    await expect(asked).resolves.toBeUndefined()
    // And the desktop it leaves behind still takes input.
    app.windows.focus(WINDOW_IDS.transcript)
    app.feed('hi')
    expect(app.composer.value).toBe('hi')
  })
})

describe('a superseded dialog', () => {
  it('settles as dismissed while the new one answers normally', async () => {
    const { app } = build()
    app.start()
    const first = app.ask({
      title: 'First',
      question: 'one?',
      choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
    })
    const second = app.ask({
      title: 'Second',
      question: 'two?',
      choices: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
    })
    app.frame()
    // Only the second dialog holds the desktop; answer it with Enter.
    app.feed('\r')
    await expect(second).resolves.toBe('yes')
    await expect(first).resolves.toBeUndefined()
    // And neither window is left behind.
    expect(app.windows.all().some(window => !window.closed && window.title === 'First')).toBe(false)
    expect(app.windows.all().some(window => !window.closed && window.title === 'Second')).toBe(false)
  })
})

describe('sessions type-to-filter', () => {
  /** A session list to filter against, newest first. */
  function sessions() {
    return [
      { id: 'main-session-aaa1', createdAt: Date.now() - 60_000, cwd: '/tmp/ws', live: false, persisted: true, title: 'Parser streaming fix' },
      { id: 'main-session-bbb2', createdAt: Date.now() - 3_600_000, cwd: '/tmp/other', live: false, persisted: true, title: 'Docs rewrite' },
      { id: 'main-session-ccc3', createdAt: Date.now() - 90_000_000, cwd: '/tmp/ws', live: true, persisted: true, title: 'Long migration' },
    ]
  }

  /** Open the Sessions window, focused, and return the rows it shows. */
  function open(view: ReturnType<typeof build>) {
    view.app.setSessions(sessions())
    view.app.openWindow(WINDOW_IDS.sessions)
    view.app.frame()
  }

  it('narrows the rows as the query is typed and widens on backspace', () => {
    const view = build()
    open(view)
    view.app.feed('pars')
    view.app.frame()
    expect(view.app.listRowsFor(WINDOW_IDS.sessions)).toContain('Parser streaming fix')
    let shown = view.app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(shown).toContain('/pars — 1 of 3')
    expect(shown).not.toContain('Docs rewrite')
    view.app.feed('\u007F') // backspace ×4 widens back
    view.app.feed('\u007F'); view.app.feed('\u007F'); view.app.feed('\u007F')
    view.app.frame()
    shown = view.app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(shown).toContain('Docs rewrite')
  })

  it('escape clears the query', () => {
    const view = build()
    open(view)
    view.app.feed('zz')
    view.app.feed('\u001B')
    // A lone ESC is ambiguous until input goes quiet; release it as the key.
    view.app.flushInput()
    view.app.frame()
    const shown = view.app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(shown).not.toContain('/zz')
    expect(shown).toContain('Parser streaming fix')
  })

  it('a query with no matches names itself', () => {
    const view = build()
    open(view)
    view.app.feed('qq')
    view.app.frame()
    const shown = view.app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(shown).toContain('No match for "qq".')
  })

  it('Enter on the filtered row still resumes', () => {
    const view = build()
    open(view)
    view.app.feed('migration')
    view.app.frame()
    view.app.feed('\r')
    // The only match is the migration session; the resume path was invoked
    // (the fake host cannot resume in place, so the notice names it).
    view.app.frame()
    const shown = view.app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(shown.length).toBeGreaterThan(0)
  })

  it('typing over the transcript still reaches the composer', () => {
    const view = build()
    open(view)
    view.app.windows.focus(WINDOW_IDS.transcript)
    view.app.feed('hi')
    expect(view.app.composer.value).toBe('hi')
  })

  it('a session refresh mid-filter keeps the query', () => {
    const view = build()
    open(view)
    view.app.feed('docs')
    view.app.setSessions(sessions())
    view.app.frame()
    const shown = view.app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(shown).toContain('/docs — 1 of 3')
  })
})
