/**
 * The dependency-consistency guard.
 *
 * Every `@deepseek-ai/*` pin must agree across `dependencies`,
 * `peerDependencies`, and `devDependencies`. The sections drift apart the day
 * someone bumps one of them by hand — and when they drift, `legacy-peer-deps`
 * resolves the conflict by silently installing the OLDER version for the
 * overlapping set, so the tree boots, typechecks against stale types, and the
 * first symptom is a missing export inside a nested package at profile boot.
 * Diagnosing that cost an afternoon; this test costs two milliseconds.
 *
 * `@deepseek-ai/dsh` itself (the runtime) is not a dependency and is not
 * checked here; `engines.dsh` bounds it and the boot rungs cover it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

type Section = 'dependencies' | 'peerDependencies' | 'devDependencies'

describe('the @deepseek-ai dependency set', () => {
  it('agrees on one version across every section', () => {
    const versions = new Map<string, Set<{ section: Section; spec: string }>>()
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (!name.startsWith('@deepseek-ai/')) continue
        const entry = versions.get(name) ?? new Set()
        entry.add({ section, spec })
        versions.set(name, entry)
      }
    }
    expect(versions.size, 'the manifest declares no @deepseek-ai packages').toBeGreaterThan(0)
    const drifted = [...versions.entries()]
      .filter(([, specs]) => new Set([...specs].map(s => s.spec)).size > 1)
      .map(([name, specs]) => `${name}: ${[...specs].map(s => `${s.section}=${s.spec}`).join(', ')}`)
    expect(drifted, `pins drift across sections — bump every section or npm resolves to the older silently:\n${drifted.join('\n')}`).toEqual([])
  })

  it('pins the dsh family exactly, so a prerelease cannot float under a range', () => {
    // Only the version-coupled family: @deepseek-ai/dsh* moves in lockstep
    // with dsh releases, so an exact pin is the only spec that says what we
    // verified. schemastery and cordis are stable libraries where a range is
    // the convention and the runtime supplies its own.
    const loose: string[] = []
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
      for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
        if (!/^@deepseek-ai\/dsh/.test(name)) continue
        if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(spec)) loose.push(`${section} ${name} ${spec}`)
      }
    }
    expect(loose, `ranges where exact pins belong:\n${loose.join('\n')}`).toEqual([])
  })
})
