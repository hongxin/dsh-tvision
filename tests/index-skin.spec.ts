/**
 * Skin-resolution precedence tests.
 *
 * The choice of skin has three sources — the `--skin` flag, the remembered
 * setting, the shipped default — and their order is a product decision the
 * user made explicitly: a flag is a one-off look and must not be buried by a
 * remembered preference. These tests pin the order at the pure function.
 */
import { describe, expect, it } from 'vitest'
import { resolveSkin, type Config } from '../src/index.ts'
import { DEFAULT_SKIN_ID, SKINS } from '../src/kit/skin.ts'

const config = (skin?: string): Config => (skin === undefined ? {} : { skin })

describe('resolveSkin precedence', () => {
  it('flag beats the remembered choice', () => {
    expect(resolveSkin(config('amber'), 'slate').id).toBe('amber')
  })

  it('the remembered choice beats the default', () => {
    expect(resolveSkin(config(), 'slate').id).toBe('slate')
  })

  it('with neither, the shipped default', () => {
    expect(resolveSkin(config()).id).toBe(DEFAULT_SKIN_ID)
  })

  it('an unknown id anywhere falls back to the catalogue, not a crash', () => {
    // The catalogue's first entry (the F9 cycle's start), not the default —
    // an unusable remembered value should land somewhere cycable, not boot-fail.
    expect(resolveSkin(config('nope')).id).toBe(SKINS[0]?.id)
    expect(resolveSkin(config(), 'nope').id).toBe(SKINS[0]?.id)
  })
})
