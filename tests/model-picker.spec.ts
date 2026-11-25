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

  it('keeps the pending default on screen after the notice has gone', async () => {
    const { app, selectModel } = build(async () => GLM)
    app.start()
    app.frame()
    app.composer.insert('/model')
    app.composer.onKey({ type: 'key', key: 'enter' })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    app.feed('\r')
    // The save resolves asynchronously and the status closure reads the
    // pending default at paint time; settle the promise chain fully.
    await vi.waitFor(() => { expect(selectModel).toHaveBeenCalledTimes(1) })
    for (let i = 0; i < 12; i++) await Promise.resolve()
    // frame() is a no-op while the manager is clean, so ask for the frame
    // explicitly: the standing reminder must survive a *fresh* paint, which
    // is what a reader sees seconds later, after the notice is gone.
    // The compositor repaints only changed cells and a fake terminal keeps
    // every run, so the painted bytes are a poor oracle here. The contract is
    // in the status model itself: with a pending default set, a fresh status
    // build names what runs and what the next boot runs.
    const cells = (app as unknown as { buildStatus(): readonly { text: string }[] }).buildStatus()
    const modelCell = cells.find(cell => cell.text.includes('glm'))
    expect(modelCell?.text).toBe('zai/glm-5.3 →glm-5.4↻')
    // The picker agrees: the title carries the pending default.
    expect(app.windows.listWindows().find(w => w.id === WINDOW_IDS.model)?.title)
      .toBe('Model — zai/glm-5.3 →glm-5.4 on restart')
    // Once the restart has applied it, the running route *is* the default and
    // the reminder retires itself rather than outliving its news.
    const afterRestart = build(async () => GLM.map(row => ({ ...row, current: row.id === 'glm-5.4' })))
    afterRestart.app.start()
    afterRestart.app.windows.requestRender()
    afterRestart.terminal.output = ''
    afterRestart.app.frame()
    expect(afterRestart.terminal.output.replace(/\u001B\[[0-9;?]*[a-zA-Z]/gu, '')).not.toContain('↻')
  })

  it('a notice that expires gives the row back to the metric cells', async () => {
    // The status line charged the notice's width to the cells, and a notice
    // that never expired evicted them for good — so the model cell vanished
    // behind every notify() until the next one replaced it.
    vi.useFakeTimers()
    try {
      const { app } = build(async () => GLM)
      app.start()
      app.frame()
      app.notify('a long notice that occupies most of the status row for a while', 'info', 8000)
      app.windows.requestRender()
      app.frame()
      const statusOf = (): string[] =>
        (app as unknown as { buildStatus(): readonly { text: string }[] }).buildStatus().map(cell => cell.text)
      // With the notice live, the message getter reports it.
      const message = (app as unknown as { transientNotice(): { text: string } | undefined }).transientNotice()
      expect(message?.text).toContain('a long notice')
      // Past its expiry the getter reports nothing — without waiting for the
      // timer's turn, which is what a frame landing in between would see.
      vi.setSystemTime(Date.now() + 9000)
      expect((app as unknown as { transientNotice(): { text: string } | undefined }).transientNotice()).toBeUndefined()
      expect(statusOf().some(text => text.includes('glm'))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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
