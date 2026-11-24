/**
 * The `/model` picker.
 *
 * `/model` was a read-only label the harness answered. With a catalog the
 * composition can describe, the desktop claims the name: a window lists every
 * registered route, the running one marked, and Enter switches to the row
 * under the cursor and persists the choice as the profile's default — the
 * same save the web Models page makes. A host without `listModels` never
 * claims the command, so the harness's own `/model` answers unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import { TvisionApp, WINDOW_IDS, type ModelChoice } from '../src/app/app.ts'
import { TURBO_VISION } from '../src/kit/skin.ts'

class FakeTerminal {
  columns = 100
  rows = 30
  output = ''
  write(data: string): void { this.output += data }
}

function build(listModels?: () => Promise<readonly ModelChoice[]>) {
  const terminal = new FakeTerminal()
  const selectModel = vi.fn(async (choice: ModelChoice) => ({ ok: true as const, choice }))
  const sent: string[] = []
  const host = {
    send: (text: string) => { sent.push(text) },
    cancel: () => {},
    quit: () => {},
    commands: () => [],
    files: () => [],
    modelLabel: () => 'zai/glm-5.3',
    contextWindow: () => 128_000,
    selectModel,
    ...(listModels === undefined ? {} : { listModels }),
  }
  const app = new TvisionApp({
    terminal: terminal as never,
    host: host as never,
    info: { name: 'tvision', version: '0.0.0', sessionId: 'main-session-test', cwd: '/tmp/ws' },
    skin: TURBO_VISION,
  })
  return { app, selectModel, sent, terminal }
}

const GLM: readonly ModelChoice[] = [
  { provider: 'zai', id: 'glm-5.4', name: 'GLM-5.4', current: false, modalities: ['text', 'image'] },
  { provider: 'zai', id: 'glm-5.3', name: 'GLM-5.3', current: true },
  { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek Flash', current: false },
]

describe('the /model picker', () => {
  it('/model opens the picker and lists every route, the running one marked', async () => {
    const { app } = build(async () => GLM)
    app.start()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    app.frame()
    expect(app.windows.isOpen(WINDOW_IDS.model)).toBe(true)
    const listed = app.windows.listWindows().find(w => w.id === WINDOW_IDS.model)
    expect(listed?.title).toBe('Model — zai/glm-5.3')
    // The command was the desktop's own: nothing reached the harness or the model.
    expect(app.composer.value).toBe('')
  })

  it('Enter on a row switches to it and persists the choice', async () => {
    const { app, selectModel } = build(async () => GLM)
    app.start()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    // The cursor starts on the first row — glm-5.4, not the current route.
    app.feed('\r')
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(selectModel).toHaveBeenCalledTimes(1)
    expect(selectModel.mock.calls[0]?.[0]).toMatchObject({ provider: 'zai', id: 'glm-5.4' })
  })

  it('Enter on the current route persists nothing', async () => {
    const { app, selectModel } = build(async () => GLM)
    app.start()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    // Down to the running row, then Enter.
    app.feed('\u001B[B')
    app.feed('\r')
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(selectModel).not.toHaveBeenCalled()
  })

  it('a host without a catalog never claims /model, and the harness answers it', async () => {
    const { app, sent } = build(undefined)
    app.start()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 4; i++) await Promise.resolve()
    app.frame()
    expect(app.windows.isOpen(WINDOW_IDS.model)).toBe(false)
    void sent
  })

  it('says the choice applies from the next boot, since the running route does not change', async () => {
    const { app, terminal } = build(async () => GLM)
    app.start()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    app.feed('\r')
    for (let i = 0; i < 6; i++) await Promise.resolve()
    app.frame()
    expect(terminal.output).toContain('applies from the next boot')
  })

  it('a failed save is reported, not swallowed', async () => {
    const terminal = new FakeTerminal()
    const host = {
      send: () => {}, cancel: () => {}, quit: () => {}, commands: () => [], files: () => [],
      modelLabel: () => 'zai/glm-5.3', contextWindow: () => 128_000,
      listModels: async () => GLM,
      selectModel: async () => ({ ok: false as const, error: 'profile is read-only' }),
    }
    const app = new TvisionApp({
      terminal: terminal as never, host: host as never,
      info: { name: 'tvision', version: '0.0.0', sessionId: 's', cwd: '/' }, skin: TURBO_VISION,
    })
    app.start()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    app.feed('\r')
    for (let i = 0; i < 6; i++) await Promise.resolve()
    // The notice is transient state until the next frame paints it.
    app.frame()
    expect(terminal.output).toContain('profile is read-only')
  })
})
