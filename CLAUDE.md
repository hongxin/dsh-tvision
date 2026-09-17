# CLAUDE.md — verifying tvision without spending tokens

This repo has a five-level verification ladder. **Pick the lowest level that
can answer your question**; each level costs roughly an order of magnitude
more than the one below it, and only the last costs anything at all.

Read `AGENTS.md` for the code rules and `BRIEF.md` for the architecture map
first; this file is only about verifying changes cheaply.

## The ladder

| Level | Command | What runs | Cost | Catches |
|---|---|---|---|---|
| L0 | `npm test` | units, whole-desktop tests with a fake host, snapshots, **golden-log replay** (`tests/golden-replay.spec.ts`) | ~1 s, free | fold bugs against real event shapes, width/color/rendering invariants, regressions of everything below |
| L1 | `npm run sweep:pty && npm test` | demo under a real pty, 18 scenarios, invariant assertions on the captures | ~2 min, free | real-terminal rendering drift, teardown modes, scroll/overflow |
| L2 | `npm run verify:profile` | boots `dsh --profile tvision` for real; no key needed | ~15 s, free | profile install, dependency closure, patch composition, mount/teardown |
| L3 | `npm run verify:wire` | real profile + `scripts/mock-llm.mjs` scripted endpoint: a reasoner turn, a CJK turn, a tool round trip (approval answered with Enter) | ~30 s, free | adapter contract drift, waterfall/approval end-to-end, streaming shapes |
| L4 | manual | one real model turn: cheapest model, `max_tokens` low, one short prompt | ~cents | the only unmockable residue — whether real DeepSeek matches the mock's wire assumptions |

`npm run verify:all` = L0 + L2 + L3 and prints one line per check.

## Which level answers which bug class

- Fold/event shapes (reasoning blocks, tool pairing, echoes, sources) → **L0**.
  The golden fixtures pin the exact shapes real logs carry.
- Rendering (width, clusters, kinsoku, skins, colors) → **L0** (snapshots) and
  **L1** (what a real terminal agrees to).
- Boot/install/profile wiring → **L2**. Run it after any `package.json` or
  `cordis.patch.yml` change.
- Anything the harness does between HTTP and our event subscription → **L3**.
  The mock speaks the adapter's verified protocol; add a scenario to `TURNS`
  in `scripts/mock-llm.mjs`, type its keyword, assert on the replayed screen.
- Provider drift after a dsh/`@deepseek-ai/*` upgrade → run
  `python3 scripts/golden-extract.py <fresh session log> <scenario>` and diff
  against `tests/golden/*.jsonl` to see exactly which event shapes moved, then
  update fixtures by hand. **Never commit real transcripts** — fixtures are
  hand-written shapes with synthetic content.

## Rules that keep it cheap

- The mock endpoint is authoritative for shapes, not for truth: if L3 passes
  and reality disagrees, refresh the corpus (one L4 turn), don't guess.
- A change that only touches `src/` still deserves L1 when it touches the
  renderer, the palette, or input routing — the emulator suite cannot see
  what a real terminal does with the bytes (AGENTS.md tells the story).
- Claude-side economy: run the ladder, read the one-line summaries, and grep
  before reading whole files. The brief (`npm run review:brief`) maps the
  modules; `BRIEF.md` names the invariants that look removable and are not.
