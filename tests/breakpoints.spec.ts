/**
 * The breakpoint rule core: pattern parsing, glob matching, and rule order.
 *
 * These are the semantics the window and the pre-execute claim both stand on,
 * so they are pinned here, table-driven, with no application around them.
 */
import { describe, expect, it } from 'vitest'

import {
  globMatch,
  matchBreakpoint,
  parseBreakpointPattern,
  type BreakpointRule,
} from '../src/app/breakpoints.ts'

const rule = (pattern: string, action: 'ask' | 'deny' = 'ask', enabled = true): BreakpointRule =>
  ({ pattern, action, enabled })

describe('parseBreakpointPattern', () => {
  it('splits a bare tool from a tool with an argument glob', () => {
    expect(parseBreakpointPattern('bash')).toEqual({ tool: 'bash', args: undefined })
    expect(parseBreakpointPattern('bash(rm *)')).toEqual({ tool: 'bash', args: 'rm *' })
    expect(parseBreakpointPattern(' fs(src/*) ')).toEqual({ tool: 'fs', args: 'src/*' })
  })

  it('rejects patterns that cannot be read', () => {
    expect(parseBreakpointPattern('')).toBeUndefined()
    expect(parseBreakpointPattern('   ')).toBeUndefined()
    expect(parseBreakpointPattern('(bash)')).toBeUndefined()
    expect(parseBreakpointPattern('bash(rm *)')).not.toBeUndefined()
    expect(parseBreakpointPattern('bash(rm (x))')).toBeUndefined()
    expect(parseBreakpointPattern('bash(rm *')).toBeUndefined()
  })
})

describe('globMatch', () => {
  it('matches literally without a star and prefix/suffix with one', () => {
    expect(globMatch('bash', 'bash')).toBe(true)
    expect(globMatch('bash', 'bashx')).toBe(false)
    expect(globMatch('rm *', 'rm -rf build')).toBe(true)
    expect(globMatch('rm *', 'make -j8')).toBe(false)
    expect(globMatch('*wire*', 'echo wire-tool-ok')).toBe(true)
    expect(globMatch('src/*', 'src/kit/frame.ts')).toBe(true)
    expect(globMatch('src/*', 'kit/frame.ts')).toBe(false)
  })

  it('treats everything but the star as literal', () => {
    expect(globMatch('a.b', 'axb')).toBe(false)
    expect(globMatch('a?b', 'a?b')).toBe(true)
    expect(globMatch('[abc]', '[abc]')).toBe(true)
  })
})

describe('matchBreakpoint', () => {
  const bashRm = { name: 'bash', arguments: { command: 'rm -rf build && make' } }

  it('stops at a bare tool rule whatever the arguments', () => {
    expect(matchBreakpoint([rule('bash')], new Set(), bashRm))
      .toMatchObject({ kind: 'rule', rule: { pattern: 'bash', action: 'ask' } })
    expect(matchBreakpoint([rule('bash')], new Set(), { name: 'fs', arguments: { path: 'a' } }))
      .toBeUndefined()
  })

  it('matches the argument glob against the call label the transcript shows', () => {
    expect(matchBreakpoint([rule('bash(rm *)')], new Set(), bashRm)).toMatchObject({ kind: 'rule' })
    expect(matchBreakpoint([rule('bash(make*)')], new Set(), bashRm)).toBeUndefined()
  })

  it('takes the first matching rule and skips disabled ones', () => {
    const rules = [rule('bash(make*)', 'ask', false), rule('bash(rm *)', 'deny'), rule('bash')]
    expect(matchBreakpoint(rules, new Set(), bashRm))
      .toMatchObject({ rule: { pattern: 'bash(rm *)', action: 'deny' } })
  })

  it('globs the tool name itself', () => {
    expect(matchBreakpoint([rule('*(*curl*)')], new Set(), { name: 'web', arguments: { url: 'https://x/curl' } }))
      .toMatchObject({ kind: 'rule' })
    expect(matchBreakpoint([rule('*')], new Set(), { name: 'anything' }))
      .toMatchObject({ kind: 'rule' })
  })

  it('reports a grant while its rule still matches', () => {
    expect(matchBreakpoint([rule('bash')], new Set(['bash']), bashRm)).toMatchObject({ kind: 'grant' })
    // The grant is keyed to the pattern: a different rule does not inherit it.
    expect(matchBreakpoint([rule('fs')], new Set(['bash']), { name: 'fs' })).toMatchObject({ kind: 'rule' })
    // Disabling the rule disables its grant.
    expect(matchBreakpoint([rule('bash', 'ask', false)], new Set(['bash']), bashRm)).toBeUndefined()
  })

  it('matches calls with no arguments by tool, and * spans the empty label', () => {
    expect(matchBreakpoint([rule('bash')], new Set(), { name: 'bash' })).toMatchObject({ kind: 'rule' })
    // A star is a whole-text glob, so it matches the empty label too — to
    // require content, name it.
    expect(matchBreakpoint([rule('bash(*)')], new Set(), { name: 'bash' })).toMatchObject({ kind: 'rule' })
    expect(matchBreakpoint([rule('bash(x*)')], new Set(), { name: 'bash' })).toBeUndefined()
  })

  it('skips rules whose pattern cannot be parsed rather than stopping the agent', () => {
    expect(matchBreakpoint([rule('bash(rm ('), rule('bash')], new Set(), bashRm))
      .toMatchObject({ rule: { pattern: 'bash' } })
  })
})
