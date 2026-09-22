/**
 * Generate a review brief: the map of this codebase that a reviewer needs.
 *
 * Written for an outside reviewer — a person or an agent — that has not read the
 * design document and cannot afford to. It prints what each module is for, how
 * big it is, what it exports, which of its exports nothing calls, and what the
 * test suite does and does not cover.
 *
 * The point of generating it rather than describing it in prose is that the
 * numbers cannot go stale. A brief that drifts from the code is worse than no
 * brief, because it makes a reviewer confident about something untrue.
 *
 * Usage:
 *   npm run review:brief                 # the whole thing
 *   npm run review:brief -- --module wm  # one module
 *
 * @module dsh-tvision/scripts/review-brief
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** One source file's facts. */
interface ModuleFacts {
  readonly path: string
  readonly lines: number
  /** Exported symbol names, in source order. */
  readonly exports: readonly string[]
  /** Exported class/function names that appear in no test and no other module. */
  readonly unreferenced: readonly string[]
}

/** One test file's facts. */
interface TestFacts {
  readonly path: string
  readonly lines: number
  readonly cases: number
}

/**
 * Every `.ts` file under a directory, recursively.
 * @param directory - The directory to walk.
 * @returns Absolute paths.
 */
function walk(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * The names a source file exports.
 *
 * A deliberately shallow scan — `export` at the start of a line, plus
 * `export { … }` — because the alternative is a TypeScript parser, and the point
 * is to find symbols worth questioning rather than to be exact.
 * @param source - The file's text.
 * @returns Exported names.
 */
function exportedNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/gmu)) {
    if (match[1] !== undefined) names.push(match[1])
  }
  for (const match of source.matchAll(/^export\s*\{([^}]*)\}/gmu)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part.trim().split(/\s+as\s+/u).pop()?.trim()
      if (name !== undefined && name !== '' && !name.startsWith('type ')) names.push(name)
    }
  }
  return names
}

/**
 * Count `it(`/`test(` cases in a test file.
 * @param source - The file's text.
 * @returns The number of cases.
 */
function testCases(source: string): number {
  return [...source.matchAll(/\b(?:it|test)(?:\.\w+)?\s*\(/gu)].length
}

/**
 * Gather the facts for every module.
 * @returns Source and test facts.
 */
function gather(): { modules: ModuleFacts[]; tests: TestFacts[]; allText: string } {
  const sourceFiles = walk(join(ROOT, 'src')).sort()
  const testFiles = walk(join(ROOT, 'tests')).filter(file => file.endsWith('.spec.ts')).sort()
  // Every line of every source and test file, for the reference check.
  const allText = [...sourceFiles, ...walk(join(ROOT, 'tests'))]
    .map(file => readFileSync(file, 'utf8'))
    .join('\n')
  const modules = sourceFiles.map((file) => {
    const source = readFileSync(file, 'utf8')
    const names = exportedNames(source)
    return {
      path: relative(ROOT, file),
      lines: source.split('\n').length,
      exports: names,
      // A symbol mentioned exactly once — at its own definition — is referenced
      // by nothing. Counting occurrences is crude but finds the real cases.
      unreferenced: names.filter((name) => {
        const occurrences = allText.split(new RegExp(`\\b${name}\\b`, 'gu')).length - 1
        return occurrences <= 1
      }),
    }
  })
  const tests = testFiles.map((file) => {
    const source = readFileSync(file, 'utf8')
    return {
      path: relative(ROOT, file),
      lines: source.split('\n').length,
      cases: testCases(source),
    }
  })
  return { modules, tests, allText }
}

/**
 * The purpose of each directory, for a reader who has not opened it.
 *
 * Recorded here rather than inferred, because a directory listing can tell you
 * that `views/` exists but not that it may not import from `app/`.
 */
const LAYERS: readonly { readonly path: string; readonly purpose: string }[] = [
  { path: 'src/kit', purpose: 'The character-cell substrate. Imports nothing above it; knows nothing about agents.' },
  { path: 'src/session', purpose: 'The retained document: session events folded into entries.' },
  { path: 'src/views', purpose: 'Agent-shaped widgets: the transcript and the dialogs.' },
  { path: 'src/widgets', purpose: 'Reusable chrome: frame, menu bar, status bar.' },
  { path: 'src/app', purpose: 'The desktop: windows, keys, composer, questions, the host seam.' },
  { path: 'src/term', purpose: 'The real terminal: raw mode and the byte stream.' },
  { path: 'src', purpose: 'The DSH plugin itself, plus the standalone demo.' },
]

/**
 * Print the brief.
 */
function main(): void {
  const filter = process.argv.includes('--module')
    ? process.argv[process.argv.indexOf('--module') + 1]
    : undefined
  const { modules, tests } = gather()
  const sourceLines = modules.reduce((sum, module) => sum + module.lines, 0)
  const testLines = tests.reduce((sum, test) => sum + test.lines, 0)
  const cases = tests.reduce((sum, test) => sum + test.cases, 0)

  const out: string[] = []
  out.push('# tvision — review brief')
  out.push('')
  out.push(`${modules.length} source files, ${sourceLines} lines. ${tests.length} test files, ${testLines} lines, ${cases} cases.`)
  out.push('')
  out.push('Generated by `npm run review:brief`. Regenerate rather than trusting these numbers.')
  out.push('')
  out.push('## Layers, and the rule between them')
  out.push('')
  for (const layer of LAYERS) out.push(`- **${layer.path}/** — ${layer.purpose}`)
  out.push('')
  out.push('## Modules')
  out.push('')
  out.push('`unreferenced` lists exported symbols that appear nowhere but their own')
  out.push('definition. Each is either dead code or an API with no caller yet — worth')
  out.push('a reviewer\'s judgement rather than an automatic delete.')
  out.push('')
  for (const module of modules) {
    if (filter !== undefined && !module.path.includes(filter)) continue
    out.push(`### ${module.path} (${module.lines} lines)`)
    out.push('')
    out.push(`exports: ${module.exports.length === 0 ? '(none)' : module.exports.join(', ')}`)
    if (module.unreferenced.length > 0) out.push(`unreferenced: ${module.unreferenced.join(', ')}`)
    out.push('')
  }
  out.push('## Tests')
  out.push('')
  for (const test of tests) {
    out.push(`- ${test.path} (${test.lines} lines, ${test.cases} cases)`)
  }
  process.stdout.write(`${out.join('\n')}\n`)
}

main()
