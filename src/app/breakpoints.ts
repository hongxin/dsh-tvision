/**
 * Tool breakpoints: the debugger's breakpoint, moved onto an agent.
 *
 * A rule names a tool — and optionally, in parentheses, what the tool was
 * called with — and what to do when the agent tries it: ask, or deny outright.
 * The pattern matches the same one-line label the transcript shows for the
 * call (`bash  npm test -- parser`), so a rule the user writes reads against
 * the screen they were looking at, not against a second, private rendering.
 *
 * The module is pure: rules in, match out. What a match *does* — open a
 * dialog, remember an "always this session" grant, count a hit — belongs to
 * the application, and the translation into a harness decision belongs to the
 * bridge in `src/index.ts`.
 * @module dsh-tvision/app/breakpoints
 */

import { summarizeArgs } from '../views/transcript.ts'

/**
 * One breakpoint rule.
 *
 * `pattern` is `tool` or `tool(glob)` — the tool name may itself be a glob.
 * Only `*` is a wildcard (it matches any run of characters); everything else
 * matches literally, case-sensitively. `bash` stops every shell call;
 * `bash(rm *)` stops removals; `*(curl*)` stops any tool ever handed a curl.
 */
export interface BreakpointRule {
  readonly pattern: string
  readonly action: 'ask' | 'deny'
  enabled: boolean
}

/** A pattern split into its two halves. */
export interface BreakpointPattern {
  /** The glob matched against the tool name. */
  readonly tool: string
  /** The glob matched against the call's one-line label, or undefined. */
  readonly args: string | undefined
}

/**
 * Parse a rule's pattern.
 * @param pattern - The pattern as typed.
 * @returns The halves, or undefined when the pattern cannot be read.
 */
export function parseBreakpointPattern(pattern: string): BreakpointPattern | undefined {
  const trimmed = pattern.trim()
  if (trimmed === '') return undefined
  const open = trimmed.indexOf('(')
  if (open === -1) return { tool: trimmed, args: undefined }
  if (open === 0 || !trimmed.endsWith(')')) return undefined
  const args = trimmed.slice(open + 1, -1)
  if (args.includes('(')) return undefined
  return { tool: trimmed.slice(0, open), args }
}

/**
 * Match text against a glob whose only wildcard is `*`.
 * @param pattern - The glob.
 * @param text - The text.
 * @returns Whether the whole text matches.
 */
export function globMatch(pattern: string, text: string): boolean {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\\*/gu, '.*')
  return new RegExp(`^${source}$`, 'u').test(text)
}

/** A tool call, as the pre-execute waterfall delivers it. */
export interface ToolCallLike {
  readonly name: string
  readonly arguments?: unknown
}

/** A rule matched and its action is due. */
export interface RuleMatch {
  readonly kind: 'rule'
  /** The rule that matched, action and all. */
  readonly rule: BreakpointRule
}

/** A rule matched that the user already granted for this session. */
export interface GrantMatch {
  readonly kind: 'grant'
  /** The rule whose pattern carries the grant. */
  readonly rule: BreakpointRule
}

/** Why a call was stopped. */
export type BreakpointMatch = RuleMatch | GrantMatch

/**
 * Find the first rule a call stops at.
 *
 * Disabled rules and unreadable patterns are skipped rather than argued with —
 * a bad pattern is reported when it is typed, not on every agent turn. A grant
 * outranks the dialog but not the match: it only applies while its rule still
 * exists and still matches, so disabling the rule disables the grant too.
 * @param rules - The rules, first-wins.
 * @param grants - The patterns granted "always this session".
 * @param call - The pending call.
 * @returns The match, or undefined when the call sails through.
 */
export function matchBreakpoint(
  rules: readonly BreakpointRule[],
  grants: ReadonlySet<string>,
  call: ToolCallLike,
): BreakpointMatch | undefined {
  const label = summarizeArgs(call.arguments)
  for (const rule of rules) {
    if (!rule.enabled) continue
    const pattern = parseBreakpointPattern(rule.pattern)
    if (pattern === undefined) continue
    if (!globMatch(pattern.tool, call.name)) continue
    if (pattern.args !== undefined && !globMatch(pattern.args, label)) continue
    return grants.has(rule.pattern)
      ? { kind: 'grant', rule }
      : { kind: 'rule', rule }
  }
  return undefined
}
