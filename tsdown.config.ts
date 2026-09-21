import { defineConfig } from 'tsdown'

/**
 * Runtime bundles. `src/` uses explicit `.ts` specifiers so the source tree runs
 * directly under Node's type stripping, which is what the tests exercise; this
 * config produces the `lib/` artifacts a published install loads.
 *
 * `demo` is bundled too, so `node lib/demo.js` works from a plain checkout with
 * no build step beyond this one.
 */
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/startup.ts',
    'src/prompt.ts',
    'src/invariant.ts',
    'src/demo.ts',
  ],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: false,
  fixedExtension: false,
  external: [/^@deepseek-ai\//u, 'commander', 'get-east-asian-width'],
})
