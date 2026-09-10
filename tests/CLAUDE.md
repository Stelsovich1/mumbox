# Tests

## Three test tiers, three configs

`webServer` is a top-level Playwright field and cannot be scoped per project, so the tiers are
separate config files rather than separate projects.

| Tier | Config | Contents |
| --- | --- | --- |
| unit | `playwright.unit.config.ts` | `tests/unit/` — pure modules imported from `src/`, no `page` fixture, so no browser and no server start. Modules reachable from here must stay free of `import.meta.env`, CSS and JSX: the Playwright loader transpiles TypeScript but runs no Vite plugins. |
| e2e | `playwright.config.ts` | `tests/e2e/` |
| perf | `playwright.perf.config.ts` | `tests/perf/` — port 4174, `workers: 1`, `reuseExistingServer: false`, service workers blocked. Never part of `test:e2e`. |

`tests/support/` holds the shared helpers: `audioFixtures.ts` (pure-JS WAV writer),
`seedProject.ts` (seeds the IndexedDB media blobs plus the IndexedDB layout record in one
navigation — never the legacy localStorage key, or every seeded test would be exercising the
migration path instead of the steady state),
`audioMock.ts` (the opt-in Web Audio mock that exercises the buffer route), `diag.ts` (typed access
to `window.__mumboxDiag`).

Two mocks exist on purpose. `installAudioMock` in `app-shell.spec.ts` defines no
`createBufferSource`, so everything using it drives `startMediaElementFallback`.
`installBufferAudioMock` in `tests/support/audioMock.ts` drives `startBufferRoute` — the path every
real browser takes — and gives the audio clock to the test (`advanceAudioClock`), because a loop
restart on a wall-clock timer either makes tests ten seconds slow or recurses synchronously inside
`onended`.

`tests/perf/baseline.json` is committed so a performance regression shows up as a reviewable diff.
Record a new one with `PERF_UPDATE_BASELINE=1 npm run test:perf`. There are four gate kinds
(`tests/perf/support/baseline.ts`): `hard` is an absolute ceiling that needs no baseline — time to
first sound is one, because the constraint is perceptual and against a sub-millisecond baseline a
ratio gate cries wolf; `exact` asserts equality and is used for decoded byte counts and decode
COUNTS, which are facts about the code rather than about the machine; `soft` fails only when a 30 %
ratio **and** an absolute floor are both exceeded; `record` is stored and never asserted, for
numbers whose spread is not known yet. The `exact` gates only hold because `perfGoto` pins
`?rate=44100` — every fixture is a 44.1 kHz WAV, and at another rate they leave the byte-range path
entirely.

`tests/MUTATION-PROTOCOL.md` describes the manual mutation-testing round used to find holes in these
tests. There is no mutation framework and none may be added.

