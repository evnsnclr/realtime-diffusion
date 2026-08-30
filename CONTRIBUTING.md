# Contributing to SurfaceShift

Thanks for your interest. This is a local-first research demo: every clone
runs against its own fal key, there is no hosted backend, and honesty about
cost and model behavior is a feature. Contributions should preserve that.

## Getting started

```bash
git clone https://github.com/evnsnclr/realtime-diffusion.git
cd realtime-diffusion
./setup.sh        # venv, dependencies, .env.local (key optional)
./run_demo.sh     # http://127.0.0.1:7860
```

The free interface preview needs no key. Cloud FLUX.2 needs your own fal key
and never runs in CI.

## Development

```bash
source .venv/bin/activate
pip install -r requirements-dev.txt
npm ci
pytest -q          # server + UI-contract tests
npm run check      # syntax pass over static/*.js
npm test           # node --test tests/*.mjs
```

All three must pass before a PR. CI runs them with `FAL_KEY` unset — tests
must never perform paid inference or require credentials.

## Ground rules

- **No secrets, ever.** Keys live in `.env.local` (gitignored). The server
  mints short-lived, endpoint-scoped tokens; the browser never sees the key.
  Never put credentials in URLs.
- **Cost honesty.** Anything that spends money needs a visible ceiling before
  it starts and honest labeling while it runs. Estimates must be labeled as
  estimates.
- **Disclosure over smoothness.** Interpolated and motion-compensated frames
  are always counted and labeled separately from native model output, and Lab
  mode stays exact and unwarped. Do not blur that line to make demos look
  better.
- **Plain modules, no build step.** Shipped JS is dependency-free ES modules
  under `static/`. New DOM-heavy code follows the factory pattern used by
  `sources.js` / `recording-studio.js` (dependencies in, no document-level
  lookups inside).
- Commit messages: `type: description` (feat, fix, refactor, docs, test,
  chore, perf, ci).

## Good first contributions

Style presets (a prompt + preview filter pair), macOS/Chrome quirk fixes,
and documentation corrections are all welcome. Open an issue first for
anything architectural.
