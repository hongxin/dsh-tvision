/**
 * Startup tests: the launch grammar and the identity it fixes.
 *
 * The plugin is wired into a Cordis tree, but everything `apply` does before
 * the tree mounts is plain decisions over the command line — which session the
 * agent binds to, which skin starts, whether the mouse reports. Those are
 * testable with a context that only records what was provided, which is the
 * cheapest place to pin the `--resume` contract the resume handoff depends on.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, GOODBYE_KEY, MAIN_AGENT_ID, TVISION_STARTUP_SERVICE } from '../src/startup.ts'
import { semverNewer } from '../src/app/app.ts'
import { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'

/** A context that records provides and answers the two services the parser reads. */
function fakeContext(argv: readonly string[]): Context & {
  provided: Record<string, unknown>
  exits: string[]
} {
  const provided: Record<string, unknown> = {}
  const exits: string[] = []
  return {
    provided,
    exits,
    provide: (key: string, value: unknown) => { provided[key] = value },
    get: (key: string) => {
      if (key === 'cmdlineArgs') return { get: () => argv }
      if (key === 'appExit') return (message: string) => { exits.push(message) }
      return undefined
    },
    on: () => () => {},
    effect: () => () => {},
  } as unknown as Context & { provided: Record<string, unknown>; exits: string[] }
}

describe('the launch grammar', () => {
  it('a bare boot binds a fresh session and publishes the goodbye line', () => {
    const ctx = fakeContext([])
    apply(ctx)
    const identity = (ctx.provided[CONFIGURED_AGENT_IDENTITIES_KEY] as Record<string, unknown>)[MAIN_AGENT_ID]
    expect(identity).toMatchObject({ resume: false })
    expect((identity as { id: string }).id).toMatch(/^main-session-/)
    const startup = ctx.provided[TVISION_STARTUP_SERVICE] as { resume: boolean; mouse: boolean }
    expect(startup.resume).toBe(false)
    expect(startup.mouse).toBe(true)
    expect(ctx.provided[GOODBYE_KEY]).toMatch(/--resume=main-session-/u)
  })

  it('--resume binds the given session exactly', () => {
    const ctx = fakeContext(['--resume', 'abc-123'])
    apply(ctx)
    const identity = (ctx.provided[CONFIGURED_AGENT_IDENTITIES_KEY] as Record<string, unknown>)[MAIN_AGENT_ID]
    expect(identity).toEqual({ id: 'abc-123', resume: true })
    const startup = ctx.provided[TVISION_STARTUP_SERVICE] as { sessionId: string; resume: boolean }
    expect(startup.sessionId).toBe('abc-123')
    expect(startup.resume).toBe(true)
  })

  it('an empty --resume is a usage error, not a fresh session', () => {
    const ctx = fakeContext(['--resume', '   '])
    apply(ctx)
    // The parser turns commander's error into an exit code; the message went
    // to stderr. What matters here is that nothing was half-bound.
    expect(ctx.exits).toHaveLength(1)
    expect(ctx.provided[CONFIGURED_AGENT_IDENTITIES_KEY]).toBeUndefined()
  })

  it('--skin and --no-mouse ride along as presentation options', () => {
    const ctx = fakeContext(['--skin', 'amber', '--no-mouse'])
    apply(ctx)
    const startup = ctx.provided[TVISION_STARTUP_SERVICE] as { skin?: string; mouse: boolean }
    expect(startup.skin).toBe('amber')
    expect(startup.mouse).toBe(false)
  })
})

describe('semverNewer', () => {
  it('orders plain triples and ignores a leading v', () => {
    expect(semverNewer('0.4.0', '0.3.0')).toBe(true)
    expect(semverNewer('v1.0.0', '0.9.9')).toBe(true)
    expect(semverNewer('0.3.0', '0.3.0')).toBe(false)
    expect(semverNewer('0.2.9', '0.3.0')).toBe(false)
  })

  it('a malformed candidate is never newer — the safe answer', () => {
    expect(semverNewer('latest', '0.3.0')).toBe(false)
    expect(semverNewer('', '0.3.0')).toBe(false)
    expect(semverNewer('1.2.x', '0.3.0')).toBe(false)
  })
})
