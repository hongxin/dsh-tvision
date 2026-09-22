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
 * @module dsh-tvision/startup
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
  /**
   * The skin id to start with, present only when `--skin` was passed: an
   * explicit flag outranks the remembered choice, and the remembered choice
   * outranks the default — so an unflagged boot publishes nothing here.
   */
  readonly skin?: string
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

/** Context key a host reads to learn the line to print on exit. */
export const GOODBYE_KEY = 'tvisionGoodbyeMessage'

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
    ctx.provide(GOODBYE_KEY, goodbye)
    ctx.provide(TVISION_STARTUP_SERVICE, {
      sessionId: identity.id,
      resume: identity.resume,
      ...(options.skin === undefined ? {} : { skin: options.skin }),
      mouse: options.mouse !== false,
    } satisfies TvisionStartup)
    installResumeHost(ctx)
  })
  parseCmdline(ctx, program)
}

/**
 * Provide the in-place `/resume` handoff when the platform supports it.
 *
 * A session belongs to a workspace, and the tools resolve paths against the
 * process's working directory — so a handoff has to *enter* the target's
 * directory. That happens before teardown commits, so an unreachable directory
 * rejects while the caller can still restore the terminal.
 * @param ctx - Plugin context whose root fiber owns the whole app tree.
 */
function installResumeHost(ctx: Context): void {
  const entry = process.argv[1]
  const execve = process.execve?.bind(process)
  if (entry === undefined || execve === undefined) return
  // The launcher arguments minus every `--resume`, so the replacement keeps the
  // invoking profile and overlays while swapping only the session.
  const baseArgs: string[] = []
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === undefined || arg.startsWith('--resume=')) continue
    if (arg === '--resume') {
      index++
      continue
    }
    baseArgs.push(arg)
  }
  ctx.provide('tvisionResumeHost', {
    async handoff(sessionId: string, cwd: string | undefined): Promise<never> {
      if (cwd !== undefined && cwd !== '') {
        try {
          process.chdir(cwd)
        } catch (error) {
          throw new Error(`tvision: cannot resume in "${cwd}": ${String(error)}`)
        }
      }
      try {
        // Release the terminal first: the replacement draws its own first frame,
        // and two writers on one alternate screen is a corrupt screen.
        await ctx.root.fiber.dispose()
        execve(
          process.execPath,
          [process.execPath, ...process.execArgv, entry, ...baseArgs, `--resume=${sessionId}`],
          process.env,
        )
        throw new Error('process replacement returned unexpectedly')
      } catch (error) {
        process.stderr.write(`tvision: resume handoff failed after terminal release: ${String(error)}\n`)
        process.exit(1)
      }
    },
  })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host that can replace this process with a resumed session. */
    tvisionResumeHost?: {
      handoff(sessionId: string, cwd?: string): Promise<never>
    }
  }
}
