/**
 * Credential onboarding tests.
 *
 * The seam is push-shaped (the harness's describe is async), so these pin the
 * app's half: the status cell that names the missing key, the Tools ▸ API key
 * dialog that collects one without ever echoing it back, and the host hook
 * that stores it. The service wiring itself is L2/L3 — index.ts is exercised
 * by the profile boot and the wire run.
 */
import { describe, expect, it } from 'vitest'
import { TvisionApp } from '../src/app/app.ts'
import type { AppHost } from '../src/app/app.ts'
import { findSkin } from '../src/kit/skin.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

/** An app with the save hook recorded. */
function build(saved?: string[]): { app: TvisionApp; saved: string[] } {
  const terminal = new HeadlessTerminal(100, 30)
  const store = saved ?? []
  const host: AppHost = {
    send: () => {},
    quit: () => {},
    saveApiKey: async (key) => { store.push(key) },
  }
  const app = new TvisionApp({
    terminal: {
      get columns(): number { return 100 },
      get rows(): number { return 30 },
      write: (data) => terminal.write(data),
    },
    host,
    info: { name: 'tvision', version: '0', sessionId: 's', cwd: '/tmp' },
    skin: findSkin('tvision')!,
  })
  app.start()
  return { app, saved: store }
}

/** Open Tools ▸ API key through the accelerator path the menu defines. */
async function openKeyDialog(app: TvisionApp): Promise<void> {
  // The menu item is Tools ▸ "API &key…"; drive it through the menu bar.
  app.handle({ type: 'key', key: 'f10' })
  // Walk right to Tools, open, invoke by accelerator.
  for (const step of ['right', 'right', 'right']) app.handle({ type: 'key', key: step })
  app.handle({ type: 'key', key: 'down' })
  // The accelerator invokes the item and closes the menu in one step; an
  // escape here would land on the dialog that just opened.
  app.handle({ type: 'key', key: 'k' })
  await new Promise(resolve => setImmediate(resolve))
}

describe('the credential status cell', () => {
  it('names the missing key only when the harness says it is missing', () => {
    const { app } = build()
    app.frame()
    expect(app.windows.lastFrame()?.lines().join('\n')).not.toContain('no API key')
    app.setCredentialState({ configured: false })
    app.frame()
    expect(app.windows.lastFrame()?.lines().join('\n')).toContain('no API key')
    app.setCredentialState({ configured: true, source: 'managed' })
    app.frame()
    expect(app.windows.lastFrame()?.lines().join('\n')).not.toContain('no API key')
    // undefined (no service) shows nothing, as before the feature existed.
    app.setCredentialState(undefined)
    app.frame()
    expect(app.windows.lastFrame()?.lines().join('\n')).not.toContain('no API key')
  })
})

describe('the API key dialog', () => {
  it('collects the key, stores it, and never echoes it back', async () => {
    const { app, saved } = build()
    app.setCredentialState({ configured: false })
    await openKeyDialog(app)
    const dialog = app.windows.all().find(window => window.title === 'API key')
    expect(dialog).toBeDefined()
    app.feed('sk-test-12345')
    app.feed('\r')
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(saved).toEqual(['sk-test-12345'])
    app.frame()
    // The frame after the save names the outcome, never the value.
    const text = app.windows.lastFrame()?.lines().join('\n') ?? ''
    expect(text).not.toContain('sk-test-12345')
  })

  it('escape or an empty field makes no call', async () => {
    const { app, saved } = build()
    app.setCredentialState({ configured: false })
    await openKeyDialog(app)
    app.feed('\r') // empty field + Enter on Save: the guard rejects the blank
    await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(saved).toEqual([])
  })
})
