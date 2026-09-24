/**
 * The breakpoint surface as one desktop: the window, the keys, the local
 * command, and — the part the pre-execute seam will stand on — the dialog's
 * three answers and what each leaves behind.
 */
import { describe, expect, it, vi } from 'vitest'

import { TvisionApp, WINDOW_IDS, type AppHost } from '../src/app/app.ts'
import type { BreakpointRule } from '../src/app/breakpoints.ts'
import { findSkin } from '../src/kit/skin.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

function build(overrides: Partial<AppHost> = {}) {
  const terminal = new HeadlessTerminal(100, 30)
  const host: AppHost = { send: () => {}, quit: () => {}, ...overrides }
  const app = new TvisionApp({
    terminal: { get columns() { return 100 }, get rows() { return 30 }, write: (data) => terminal.write(data) },
    host,
    info: { name: 'tvision', version: '0.1.0', sessionId: 's', cwd: '/tmp/ws' },
    skin: findSkin('tvision')!,
  })
  const frame = (): string => app.windows.paint().lines().join('\n')
  return { app, terminal, frame }
}

const rmCall = { name: 'bash', arguments: { command: 'rm -rf build' } }

describe('the /breakpoint command', () => {
  it('adds an asking rule and reports it to the settings seam', () => {
    const saveSettings = vi.fn()
    const view = build({ saveSettings })
    view.app.start()
    view.app.feed('/breakpoint bash(rm *)\r')
    expect(view.app.breakpoints.map(rule => rule.pattern)).toEqual(['bash(rm *)'])
    expect(saveSettings).toHaveBeenCalledWith({ breakpoints: [expect.objectContaining({ action: 'ask' })] })
  })

  it('honours a trailing --deny', () => {
    const view = build()
    view.app.start()
    view.app.feed('/breakpoint bash --deny\r')
    expect(view.app.breakpoints[0]).toMatchObject({ pattern: 'bash', action: 'deny' })
  })

  it('rejects unreadable patterns and duplicates without adding them', () => {
    const view = build()
    view.app.start()
    view.app.feed('/breakpoint bash(rm (\r')
    view.app.feed('/breakpoint bash\r')
    view.app.feed('/breakpoint bash\r')
    expect(view.app.breakpoints).toHaveLength(1)
    expect(view.frame()).toContain('already a rule')
  })

  it('opens the window when called without arguments', () => {
    const view = build()
    view.app.start()
    view.app.feed('/breakpoint\r')
    expect(view.app.windows.isOpen(WINDOW_IDS.breakpoints)).toBe(true)
  })

  it('never reaches the host: a host without runCommand must not see the text', () => {
    const send = vi.fn()
    const view = build({ send })
    view.app.start()
    view.app.feed('/breakpoint fs(src/*)\r')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('the Breakpoints window', () => {
  it('opens on Ctrl+B and lists rules with their state', () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([
      { pattern: 'bash(rm *)', action: 'ask', enabled: true },
      { pattern: 'fs', action: 'deny', enabled: false },
    ])
    view.app.feed('\u0002')
    expect(view.app.windows.isOpen(WINDOW_IDS.breakpoints)).toBe(true)
    const text = view.frame()
    expect(text).toContain('bash(rm *)')
    expect(text).toContain('ask')
    expect(text).toContain('deny')
  })

  it('toggles a rule on Enter', () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash', action: 'ask', enabled: true }])
    view.app.openWindow(WINDOW_IDS.breakpoints)
    view.app.feed('\r')
    expect(view.app.breakpoints[0]?.enabled).toBe(false)
  })

  it('deletes the selected rule on d, after a confirmation', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash', action: 'ask', enabled: true }])
    view.app.openWindow(WINDOW_IDS.breakpoints)
    view.app.feed('d')
    // Cancel first: a guard must not come off with a slip of the hand.
    view.app.feed('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.app.breakpoints).toHaveLength(1)
    view.app.feed('d')
    view.app.feed('\u001b[D\r')   // left, Enter — choose Delete
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.app.breakpoints).toHaveLength(0)
  })
})

describe('checking a call', () => {
  it('lets unmatched calls through without a dialog', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash(rm *)', action: 'ask', enabled: true }])
    await expect(view.app.checkBreakpoint({ name: 'fs', arguments: { path: 'a' } })).resolves.toBe('allow')
    expect(view.frame()).not.toContain('Breakpoint')
  })

  it('denies outright on a deny rule, with no dialog', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash', action: 'deny', enabled: true }])
    await expect(view.app.checkBreakpoint(rmCall)).resolves.toBe('deny')
    expect(view.frame()).not.toContain('Breakpoint')
  })

  it('asks, and y runs the call once', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash(rm *)', action: 'ask', enabled: true }])
    const pending = view.app.checkBreakpoint(rmCall)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.frame()).toContain('Breakpoint')
    view.app.feed('y')
    await expect(pending).resolves.toBe('allow')
    // Asking once means asking again: a second call still stops.
    const second = view.app.checkBreakpoint(rmCall)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.frame()).toContain('Breakpoint')
    view.app.feed('\u001b')
    view.app.flushInput()
    await expect(second).resolves.toBe('deny')
  })

  it('a grants the rule for the session; deleting the rule drops the grant', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash(rm *)', action: 'ask', enabled: true }])
    const first = view.app.checkBreakpoint(rmCall)
    await new Promise(resolve => setTimeout(resolve, 0))
    view.app.feed('a')
    await expect(first).resolves.toBe('allow')
    await expect(view.app.checkBreakpoint(rmCall)).resolves.toBe('allow')
    expect(view.frame()).not.toContain('Breakpoint')
    // A disabled rule is no stop at all: the call passes without asking.
    view.app.setBreakpoints([{ pattern: 'bash(rm *)', action: 'ask', enabled: false }])
    await expect(view.app.checkBreakpoint(rmCall)).resolves.toBe('allow')
    // The grant dies with the rule: once the rule is gone, re-adding it asks
    // again — here answered with Escape, which refuses.
    view.app.setBreakpoints([])
    view.app.setBreakpoints([{ pattern: 'bash(rm *)', action: 'ask', enabled: true }])
    const third = view.app.checkBreakpoint(rmCall)
    await new Promise(resolve => setTimeout(resolve, 0))
    view.app.feed('\u001b')
    view.app.flushInput()
    await expect(third).resolves.toBe('deny')
  })

  it('queues parallel asks instead of preempting them', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash', action: 'ask', enabled: true }])
    const first = view.app.checkBreakpoint({ name: 'bash', arguments: { command: 'make -j8' } })
    const second = view.app.checkBreakpoint({ name: 'bash', arguments: { command: 'npm test' } })
    await new Promise(resolve => setTimeout(resolve, 0))
    // One dialog up: the first call's. Answering it admits the second's.
    view.app.feed('y')
    await expect(first).resolves.toBe('allow')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(view.frame()).toContain('Breakpoint')
    view.app.feed('y')
    await expect(second).resolves.toBe('allow')
  })

  it('counts hits per rule for the window', async () => {
    const view = build()
    view.app.start()
    view.app.setBreakpoints([{ pattern: 'bash', action: 'deny', enabled: true }])
    await view.app.checkBreakpoint(rmCall)
    await view.app.checkBreakpoint(rmCall)
    view.app.openWindow(WINDOW_IDS.breakpoints)
    expect(view.frame()).toContain('2 hits')
  })
})

describe('settings round-trip', () => {
  it('carries rules through saveSettings patches without touching the skin', async () => {
    const patches: unknown[] = []
    const view = build({ saveSettings: (patch) => { patches.push(patch) } })
    view.app.start()
    const rules: BreakpointRule[] = [{ pattern: 'bash', action: 'ask', enabled: true }]
    view.app.setBreakpoints(rules)
    view.app.feed('\u001b[20~')
    // cycleSkin resolves the catalogue through a lazy import, so its patch
    // lands a tick later.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(patches).toEqual([
      { breakpoints: [expect.anything()] },
      expect.objectContaining({ skin: expect.any(String) }),
    ])
    const breakpointPatch = patches[0] as { breakpoints: BreakpointRule[] }
    expect(breakpointPatch.breakpoints).toEqual(rules)
  })
})
