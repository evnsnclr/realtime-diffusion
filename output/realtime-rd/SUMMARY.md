# SurfaceShift realtime R&D evidence

## Baseline preserved

- Checkout: `dc8f67f` (`main`) before the feature branch; generation behavior was
  unchanged when this baseline was recorded.
- Feature branch: `codex/surfaceshift-realtime-rd`.
- JavaScript: `npm run check` passed; `npm test` passed 27/27 (release baseline
  was 19/19).
- Python: `uv run --with-requirements requirements-dev.txt pytest -q` passed
  12/12. The system interpreter and existing `.venv-mac` do not contain
  `pytest`, so the verified receipt uses the declared development requirements.
- Secret boundary: `.env.local` remains ignored. No secret value was read or
  printed.

Exact free benchmark command:

```bash
node benchmarks/realtime/run-preview-benchmark.mjs \
  --mode=baseline \
  --output-dir=output/realtime-rd/baseline
```

The deterministic preview uses the same 12-second source timing for every
candidate: 4 seconds each of card-grid scroll/reversal, two-axis map pan with
two zooms, and a structure/fidelity layout. It simulates the released 10 Hz
sampling, one active request, 250 ms native round trip, two returned images,
and 30 fps recorder. It is not a paid FLUX service or visual-quality result.

| Metric | Baseline preview |
|---|---:|
| Native result fps | 3.75 |
| Genuinely changing displayed fps | 5.25 |
| Displayed update fps | 7.50 |
| Returned interpolation fps | 3.75 |
| Motion-compensated fps | 0.00 |
| Encoded fps | 30.00 |
| Median output age | 312.8 ms |
| p95 output age | 436.8 ms |
| Median / p95 native round trip | 250 / 250 ms |
| Replaced source samples | 69 |
| Maximum queue depth | 2 |
| Approximate paid cost | $0.00 |

The source-suite SHA-256 is
`51b17effd53fedc25ea298c07c7495c5bfe7b2d0774424266addf758c0bfebb0`.
A candidate is comparable only if that hash and the scenario timing match.

Artifacts:

- `baseline/source-suite.mp4`: identical deterministic source input.
- `baseline/baseline-comparison.mp4`: source left, released presentation right.
- `baseline/contact-sheet.jpg`: one-second visual samples.
- `baseline/metrics.json`: aggregate and per-scenario metrics.
- `baseline/frames.jsonl`: capture, encode, queue, send, receive, decode,
  presentation, and recording-compositor timestamps.

## Prioritized experiment queue

| Rank | Experiment | Expected impact | Effort | Risk | Promotion signal |
|---:|---|---|---|---|---|
| 1 | Source-motion translation compensation between native results | High | Medium | Medium: border reveal or wrong-motion warp | >=20% changing cadence or a clearly removed hold, without distracting warp |
| 2 | Async JPEG encoding with `toBlob()` plus capture timing | Medium-high | Low | Low | Lower p95 encode/main-thread time without sampling regression |
| 3 | Motion-aware adaptive sampling and static-frame suppression | Medium | Medium | Medium | Lower replaced encodes/cost per meaningful change with unchanged response age |
| 4 | `requestAnimationFrame` recorder compositor | Medium | Low | Low | Stable encoded cadence with lower compositor time and no live slowdown |
| 5 | Controlled FLUX feedback / step / resolution A/B | Medium | Medium | High: paid and quality-sensitive | Visual fidelity/stability gain within the 25% cost guardrail |
| 6 | Text/UI preservation masks | Medium in structure mode | High | High: disclosure and seams | Better legibility/fidelity with clearly disclosed source-pixel compositing |

## Baseline visual verdict

The normal-speed comparison has the expected release behavior: layout and
identity remain stable, but scrolling and map motion advance in discrete
bursts. The 30 fps encoding is truthful only as recording cadence; the measured
content cadence is 5.25 genuinely changing output frames/s. Baseline rubric:
responsiveness 2/5, motion continuity 2/5, temporal stability 4/5, source
fidelity 4/5, artifact control 4/5, aesthetic quality 3/5, truthfulness 5/5.

At this baseline stage, no paid inference had been run. The two later bounded
real-FLUX confirmations are recorded below.

## Experiment 1 — global translation compensation — accepted

Hypothesis: a conservative global translation estimated from 48×48 source luma
can immediately move the last model image with scroll/pan motion while the next
FLUX result is pending. The model request settings, sampling interval, native
throughput, and cost were unchanged.

| Metric | Baseline | Translation v1 | Change |
|---|---:|---:|---:|
| Native result fps | 3.75 | 3.75 | 0% |
| Genuinely changing displayed fps | 5.25 | 6.83 | **+30.1%** |
| Native/interpolated presentation fps | 7.50 | 7.50 | 0% |
| Motion-compensated fps | 0.00 | 2.42 | +2.42 |
| p95 native-anchor age | 436.8 ms | 436.8 ms | 0% |
| p95 motion-response age | n/a | 66.67 ms | new |
| Replaced samples / max queue | 69 / 2 | 69 / 2 | unchanged |
| Paid cost | $0.00 | $0.00 | unchanged |

Per-scenario changing cadence moved from 6.25→8.00 fps for scroll and
5.75→8.75 fps for map motion. The modest structure lane stayed at 3.75 fps and
reported zero warp frames, which is the intended conservative behavior.

The baseline and candidate source MP4s have the identical SHA-256
`a5076432e82909772aca4ecc9a734835c0a69bbfefcecdaa3433594ca8f8d78e`.
Normal-speed blind A/B review showed correct motion direction and no blank
seams. Edge-clamped pixels can briefly stretch at the outer boundary, so
artifact control is 3/5 rather than 4/5; that artifact was less distracting
than the removed hold and remained bounded to 5.5% of a frame.

The app now exposes `sample`, `native`, native/interpolated `model`, and
motion-compensated `warp` fps separately. Compare recordings switch their
visible label between `MODEL VIEW` and `MODEL + WARP`, and report
`NATIVE-ANCHOR AGE`; Lab continues to store the unwarped exact native pair.

Free real-browser mock receipt:

- Demo → Start → selected 15-second deadline: pass.
- Separate warp diagnostic observed: pass (up to 4.0 warp fps in the mock run).
- Fullscreen enter/exit: pass.
- Rapid stop during a 900 ms token handshake: pass; idle state restored.
- Create/Compare/Lab selection: pass.
- Desktop and 390×844 mobile layout: pass.
- Browser-tab feature detection: `getDisplayMedia`, `CaptureController`, and
  `forwardWheel` present in the checked Chromium.
- Console errors/warnings: 0/0.
- Compare recording: 1920×1080 VP9, 191 decoded frames across 6.369 seconds,
  approximately 30.0 encoded fps. This is recorder cadence, not generation
  cadence.

Verdict: **keep**. This is genuine free-gate progress because changing cadence
improved by 30.1% without a source-fidelity regression, throughput/cost change,
or truthfulness violation. The bounded real-FLUX confirmation is recorded below.

## Experiment 2 — asynchronous JPEG encoding — rejected

A 40-iteration Chromium probe compared the current 704×704 JPEG 0.5
`toDataURL()` call with `toBlob()` followed by asynchronous FileReader
serialization. The async path cut p95 event-loop delay from 5.5 to 0.8 ms, but
its p95 capture-to-data-URL wall time rose from 3.3 to 9.9 ms. It did not clear
the required latency, cadence, or visible-artifact gate, so no encoder change
was retained.

## Bounded real-FLUX confirmation

Two 15-second sessions were run with unchanged FLUX parameters. Their combined
rate-times-cap ceiling is `2 × 15 × $0.00194 = $0.0582`; this is not a billing
dashboard receipt.

The first run is rejected: it reached the deadline before recording was armed,
with 2.0 native, 4.0 model, 0.7 warp fps, and a 2002 ms p95 native-anchor age.

The second run armed Compare before the first output and produced:

| Signal | Real run 2 |
|---|---:|
| Sampled fps | 10.0 |
| Native FLUX fps | 3.2 |
| Native/interpolated model fps | 6.4 |
| Motion-compensated warp fps | 1.6 |
| Independent changing output fps | 8.20 |
| p95 native-anchor age | 549 ms |
| Encoded cadence | 421 frames / 14.027 s = 30.01 fps |

The generated-panel-only `mpdecimate` probe retained 115 changing frames over
14.027 seconds. The normal-speed browser playback completed all 421 frames with
2 dropped and 0 corrupted playback frames. The material result stayed
attractive and the card/map structure remained recognizable. Small text still
mutated, and bounded edge stretching remains the warp tradeoff.

This paid run validates that separately labeled warp updates survive genuine
FLUX output. It does **not** establish a faster model: 3.2 native fps was below
the prior 4.0 receipt, and 549 ms p95 age was worse than the prior 292–438 ms
range. It therefore does not replace the v0.4 throughput baseline.

Paid artifacts:

- `paid-motion-v1-live-compare.webm`
- `paid-motion-v1-contact.jpg`
- `paid-motion-v1-output-changing.mp4`

Final real-run rubric: responsiveness 3/5, motion continuity 4/5, temporal
stability 4/5, source fidelity 4/5, artifact control 3/5, aesthetic quality
5/5, truthfulness 5/5.
