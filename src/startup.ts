/**
 * TUI command-line intake: parses the arguments the dsh launcher hands over,
 * fixes the session identity the `main` agent will bind to, and publishes the
 * presentation options the desktop's config expressions read.
 *
 * The launcher owns the flags before the app's first unrecognised token;
 * everything from there is this program's. On `--help` or a usage error nothing
 * is provided, so the dependent rows never activate and the process exits
 * through the launcher's own exit seam — which is what keeps
 * `dsh --profile tvision --help` from trying to open a terminal.
 * @module @dsh-tvision/dsh-tvision/startup
 */

import { randomUUID } from 'node:crypto'
import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CONFIGURED_AGENT_IDENTITIES_KEY } from '@deepseek-ai/dsh-agent-loop'
import { SKINS } from './kit/skin.ts'

/** Service key under which the parsed launch options are provided. */
export const TVISION_STARTUP_SERVICE = 'tvisionStartup'

/** Config `id` of the agent-loop entry the desktop drives. */
export const MAIN_AGENT_ID = 'main'

/** The parsed launch identity and presentation options. */
export interface TvisionStartup {
  /** Exact session id the `main` agent runs under, fresh or resumed. */
  readonly sessionId: SessionId
  /** Whether the session resumes persisted history. */
  readonly resume: boolean
  /** The skin id to start with. */
  readonly skin: string
  /** Whether mouse reporting is enabled. */
  readonly mouse: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tvisionStartup?: TvisionStartup
    /** Line the launcher wants printed once the terminal is released. */
    tvisionGoodbyeMessage?: string
  }
}

/** Plugin name. */
export const name = 'tvision-startup'

/** Services this plugin needs. */
export const inject = ['cmdlineArgs']

/**
 * Build the command grammar and publish the launch identity.
 * @param ctx - Plugin context with `cmdlineArgs` injected.
 */
export function apply(ctx: Context): void {
  const program = new Command()
    .name('dsh --profile tvision')
    .description('A character-cell window manager for DeepSeek Harness agents')
    .helpOption('-h, --help')
    .option('--resume <session>', 'resume a persisted session by id')
    .option('--skin <id>', `starting skin (${SKINS.map(skin => skin.id).join(', ')})`)
    .option('--no-mouse', 'disable mouse reporting')
  program.action(() => {
    const options = program.opts<{ resume?: string; skin?: string; mouse?: boolean }>()
    const resume = options.resume?.trim()
    if (options.resume !== undefined && (resume === undefined || resume === '')) {
      program.error('dsh --profile tvision: --resume requires a non-empty session id')
      return
    }
    const identity = resume === undefined
      ? { id: SessionId(`main-session-${randomUUID()}`), resume: false }
      : { id: SessionId(resume), resume: true }
    const goodbye = `To resume this session: dsh --profile tvision --resume=${identity.id}\n`
    // The identity is published before the agent exists, because the agent-loop
    // row injects this key rather than being patched afterwards.
    ctx.provide(CONFIGURED_AGENT_IDENTITIES_KEY, { [MAIN_AGENT_ID]: identity })
    ctx.provide('tvisionGoodbyeMessage', goodbye)
    ctx.provide(TVISION_STARTUP_SERVICE, {
      sessionId: identity.id,
      resume: identity.resume,
      skin: options.skin ?? 'tvision',
      mouse: options.mouse !== false,
    } satisfies TvisionStartup)
  })
  parseCmdline(ctx, program)
}
