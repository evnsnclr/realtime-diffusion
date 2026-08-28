# Validation receipt

Release receipt updated July 18, 2026. Realtime R&D appendix added August 17,
2026.

## Release verdict

SurfaceShift now follows meaningful motion and is ready for a public recorded
demo. It is no longer equivalent to the original broken clip, which processed
isolated screenshots and froze for roughly a third of a second between bursts.

It is not an exact performance clone of Ryan Stephen's demo. The current fal
session returned about 4 native FLUX.2 results per second and about 8 presented
frames per second with RIFE; Ryan reported roughly 20 fps. The release is
described as a convincing independent implementation, not frame-rate parity.

## Realtime R&D branch appendix — August 17

Branch `codex/surfaceshift-realtime-rd` adds conservative source-translation
compensation between model results. It is an evaluated candidate, not a merged
release or replacement public demo. FLUX settings remain unchanged.

The implementation downsamples each sampled source to 48×48 luma, searches a
bounded global translation, and moves the last model image when confidence
clears the variance/error gate. Warp distance is clamped to 5.5% of a frame and
new border area is edge-filled. These frames are labeled and measured as
`warp`; they are not native or interpolated model frames. Compare records the
disclosed view, while Lab preserves the exact unwarped native pair.

### Identical-input free benchmark

The deterministic 12-second source contains three four-second scenarios: card
grid scrolling with pauses/reversals, two-axis map pan with two zoom changes,
and a structure/fidelity layout. Baseline and candidate source MP4s have the
same SHA-256:

```text
a5076432e82909772aca4ecc9a734835c0a69bbfefcecdaa3433594ca8f8d78e
```

| Signal | Released presentation simulation | Translation v1 |
|---|---:|---:|
| Native result fps | 3.75 | 3.75 |
| Native/interpolated presentation fps | 7.50 | 7.50 |
| Motion-compensated fps | 0.00 | 2.42 |
| Genuinely changing displayed fps | 5.25 | 6.83 |
| p95 native-anchor age | 436.8 ms | 436.8 ms |
| p95 motion-response age | n/a | 66.67 ms |
| Replaced samples / max queue | 69 / 2 | 69 / 2 |
| Paid cost | $0.00 | $0.00 |

The +30.1% genuinely changing cadence clears the required 20% free gate. Blind
normal-speed A/B review found correct scroll/pan direction and no blank seams.
The structure lane reported zero warp frames, as intended. Brief border-pixel
stretching remains visible during some larger translations, so this is not a
free quality improvement in every scene.

### Bounded paid confirmation

Two 15-second real-FLUX sessions were run. At the documented rate, their
combined rate-times-cap ceiling is:

```text
2 × 15 × $0.00194 = $0.0582
```

This is a maximum estimate, not a billing-dashboard receipt. The first session
is rejected evidence: it reached the deadline before recording was armed and
reported 2.0 native, 4.0 model, 0.7 warp fps, and 2002 ms p95 native-anchor age.

The second session armed Compare before the first result and produced:

- 10.0 sampled fps, 3.2 native FLUX fps, 6.4 native/interpolated model fps,
  and 1.6 separately labeled warp fps.
- 549 ms p95 native-anchor age.
- A 1920×1080 VP9 WebM with 421 decoded frames across 14.027 seconds, or
  approximately 30.01 encoded fps.
- 115 changing frames in the cropped generated panel after `mpdecimate`, or
  8.20 genuinely changing output frames/s.
- Normal-speed browser playback with 421 total frames, 2 dropped playback
  frames, and 0 corrupted frames.

The result remained attractive and structurally recognizable across the map
and gallery phases. Pseudo-text still mutated, and edge fill can briefly
stretch. Service throughput was slower than the v0.4 receipt and 549 ms p95 age
was worse than the prior 292–438 ms range. This run therefore validates the
presentation technique under genuine FLUX output; it does not establish faster
inference, replace the v0.4 baseline, or claim parity with the reported 20 fps
reference.

The local evidence paths are:

- `output/realtime-rd/paid-motion-v1-live-compare.webm`
- `output/realtime-rd/paid-motion-v1-contact.jpg`
- `output/realtime-rd/paid-motion-v1-output-changing.mp4`
- `output/realtime-rd/experiments.jsonl`
- `output/realtime-rd/SUMMARY.md`

### Rejected async JPEG experiment

A 40-iteration Chromium probe compared the current synchronous 704×704 JPEG
0.5 `toDataURL()` path with `toBlob()` plus FileReader serialization. The async
path reduced p95 event-loop delay from 5.5 to 0.8 ms but increased p95
capture-to-data-URL wall time from 3.3 to 9.9 ms. It cleared no 15% latency,
20% cadence, or visible-artifact gate, so the encoder change was not retained.

## Direct video comparison

The measurements below refer to the retained 14-second output-only validation
take. The README now leads with a separate 22.89-second showcase assembled from
the strongest live-compare and generated-only recordings; it is not used to
claim a new native inference cadence.

| Signal | Original user recording | Validated output-only take | Ryan Stephen demo |
|---|---:|---:|---:|
| Duration | 9.954 s inferred | 14.000 s | 14.000 s |
| Public master | 768×768 VP9 WebM | 1080×1080 H.264 MP4 | 2156×2160 H.264 MP4 |
| Encoded cadence | 51 frames, 5.12 fps | 420 frames, constant 30 fps | 840 frames, constant 60 fps |
| Native generated cadence | about 2.61 results/s | about 4.0 results/s | about 20 fps reported by creator |
| Presented generated cadence | about 5.12 fps | about 8.0 fps with RIFE | not independently instrumented |
| Post-warm-up holds | 352.8 ms mean, 376 ms max | 129 ms mean, 167 ms max | not measured from internal frames |
| One-second SSIM | 0.902 | 0.807 | 0.699 |
| Motion | nested desktop barely changes | whole-map pan/zoom and gallery scroll | detailed map pan/zoom and gallery scroll |

The one-second SSIM is used only as a coarse motion signal: a lower value means
more visible structural change across one second, not better image quality. The
release is materially closer to the original's motion range while preserving a
stable tactile composition.

The original user WebM arrived in 26 two-frame bursts. The short gaps averaged
45.3 ms, but each pair was followed by a 324–376 ms freeze averaging 352.8 ms;
those long gaps occupied 88.6% of the timeline. The final release recording has
no encoded gap above 68 ms. Pixel-level freeze detection after its first warm-up
frame found 78 holds averaging 129 ms and topping out at 167 ms.

## Compare recorder fix

The first side-by-side recorder was an audit view, not a showcase view. Although
its WebM contained about 30 encoded frames per second, both panels advanced only
when a native source/result pair arrived. In the checked Google Earth take, the
source had 26 distinct frames (2.14 fps) and the result had 31 (2.55 fps) across
12.14 seconds. Repeated holds made the download look much worse than the app.

The default **Compare · live source + output** mode now records the continuously framed
source beside the actual displayed output canvas, including RIFE frames. The
original behavior remains available as **Lab · exact native pairs** and stores the
unblended native result.

One capped real-FLUX recording of the corrected path produced:

- 384 VP9 frames over 12.804 seconds: 1920×1080 at 29.91 effective encoded fps.
- 384 distinct source-panel frames and 102 distinct generated-panel frames.
- About 7.97 visible generated updates per second versus 3.8 native results per
  second in the end-of-run diagnostics.
- A normalized H.264 master with 385 frames at constant 30/1 fps, 12.833 seconds,
  and a 4.48 MB file size.

The motion probe crops each panel before running `mpdecimate`; measuring the
whole compositor would let a moving source hide a frozen result. The generated
side cleared the acceptance gate of at least 6 visible updates per second and
at least 1.5× the measured native cadence.

## Final paid run

The tracked public artifacts are:

- [`assets/clay-screen-demo.mp4`](assets/clay-screen-demo.mp4): 22.889 s,
  1920×1080, H.264, 30000/1001 fps, 686 frames, fast-start showcase MP4.
- [`assets/clay-screen-output-only-demo.mp4`](assets/clay-screen-output-only-demo.mp4): 14.000 s,
  1080×1080, H.264, 30/1 fps, 420 frames, fast-start MP4.
- [`assets/clay-screen-demo.gif`](assets/clay-screen-demo.gif): reduced animated
  preview of the new showcase for the README.
- [`assets/flux2-smoke-result.jpg`](assets/flux2-smoke-result.jpg): still from
  the gallery-scroll phase.

The retained output-only source recording was produced automatically from the
first real result to the 15-second safety cap:

- Browser WebM: 14.124 s inferred, 1080×1080 VP9, 424 frames, 29.95 effective
  fps, maximum encoded frame gap 68 ms.
- Live diagnostics at the end: 10.0 sampled fps, 4.0 native FLUX.2 fps, 8.0
  presented fps, 438 ms p95 displayed-frame age including startup.
- A second run of the same latest-frame-wins pipeline reported 138 ms latest
  latency and 292 ms p95 displayed-frame age. Across the final two runs, the
  steady pipeline stayed near 4 native and 8 presented frames per second.
- The 0.95 output-feedback setting allowed the map and cards to move while the
  fixed seed and RIFE pair retained visual continuity.

Six bounded 15-second iterations were purchased while diagnosing queueing,
validating the latest-frame-wins scheduler, increasing source motion, and
capturing the output-only and live-compare takes. At the listed rate of $0.00194 per compute-second,
their combined rate-times-cap ceiling is:

```text
6 × 15 × $0.00194 = $0.1746
```

This is a conservative maximum estimate, not a billing-dashboard receipt. No
more paid combinations were run.

## Why the scroll bug is fixed

The old browser loop contained an `inFlight` lock and captured the next source
frame only after the previous response. Scrolling that happened during the
request was absent from the next model input. Sending unbounded 10 fps fixed
sampling but created a 1.66-second server backlog.

The release uses a tested middle path:

1. Capture remains independent at a 100 ms interval.
2. One FLUX.2 request is allowed in flight.
3. While it runs, new samples replace one waiting frame in memory.
4. When the response arrives, only that freshest waiting frame is dispatched.
5. The returned RIFE pair is paced using the observed native-result interval.
6. A separate 30 fps presentation canvas records the latest visible state.

This keeps motion observable without purchasing or displaying stale work.

## Current gates

| Gate | Result |
|---|---|
| Python tests | pass; 12 tests |
| JavaScript syntax and tests | pass; 27 tests on the R&D branch |
| Independent capture before result | pass |
| Latest-frame-wins dispatch | pass |
| Out-of-order request correlation | pass |
| Bounded pending storage | pass |
| Stop after delayed capture or WebSocket handshake | pass |
| Selectable 15/45/90-second deadline | pass; default 45 seconds |
| Free Chrome UI pass | pass; Demo, Start/Stop, fullscreen output, Create/Compare/Lab selection, rapid-stop gate, and save |
| Real FLUX.2 moving-source run | pass |
| Manual recording | pass; 1920×1080 live compare at 29.91 encoded fps and 7.97 generated updates/s |
| Missing key and wrong code | fail closed |
| Exact fal model allowlist | pass |
| Token response caching | disabled with `Cache-Control: no-store` |
| `FAL_KEY` in frontend or tracked env files | absent |
| Public owner-funded endpoint | absent by design |
| GitHub Pages or Vercel dependency | absent |
| Captured-tab scroll implementation | present with feature detection; Chrome permission chooser remains a manual browser gate |
| Translation estimation / static rejection / edge fill | pass; deterministic tests |
| Identical-input preview gate | pass; same source hash, +30.1% changing cadence |
| Separate native/model/warp labels | pass in diagnostics and Compare recording |
| R&D browser mock | pass; desktop/mobile, fullscreen, recording, delayed-token rapid stop, 0 console errors |
| R&D paid confirmation | pass for presentation behavior; 3.2 native, 6.4 model, 1.6 warp, 8.20 changing output fps; 549 ms p95 age does not beat release baseline |

## Remaining limitations

- Small generated text is pseudo-text and can mutate.
- Generated cadence depends on fal load, network path, and hardware. The 4/8
  fps receipt is evidence from these runs, not a service guarantee.
- Chrome's captured-surface scroll forwarding works only for a captured browser
  tab on supported desktop Chrome. Other surfaces need side-by-side windows.
- The selectable cutoff limits one session; it does not stop a local user from
  starting another and is not an account-level budget.
- The in-browser WebM may lack duration metadata. The tracked MP4 is normalized
  to seekable constant-frame-rate H.264 with `ffmpeg`.

## Optional Mac fallback receipt

The earlier private fallback remains validated on an Apple Silicon Mac
(`Mac16,5`, 48 GB) with warm model calls of 103–136 ms. It uses SD-Turbo and
TAESD at 512×288 and is less faithful than FLUX.2, but capture and inference stay
on the device. This release did not rerun or purchase anything for that path.

## Free verification commands

```bash
pytest -q
npm run check
npm test
git diff --check
git check-ignore -q .env.local
```

CI leaves `FAL_KEY` unset and never performs paid inference.
