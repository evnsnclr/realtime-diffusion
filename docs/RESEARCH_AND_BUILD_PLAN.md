# FLUX.2 realtime build notes

Research updated July 16, 2026.

## Reference and model choice

[Ryan Stephen's original demo](https://x.com/Ryan__Stephen/status/2066890410824528077)
shows a browser retaining its structure while every surface becomes tactile
clay. Ryan later reported
[using fal at around 20 fps](https://x.com/Ryan__Stephen/status/2066903429881208975).
The post does not publish its complete source or settings, so SurfaceShift is an
independent implementation.

SurfaceShift uses
[`fal-ai/flux-2/klein/realtime`](https://fal.ai/models/fal-ai/flux-2/klein/realtime/api).
The endpoint accepts an optimized 704×704 JPEG input at 50% quality, supports a
fixed seed and output feedback, and can return a RIFE interpolation frame plus
the current generated frame. The release uses three inference steps, seed 35,
schedule mu 2.3, square 768×768 output, interpolation, and 0.95 output feedback.

## Architecture

```text
browser-approved source
  ├─ Demo canvas
  ├─ captured browser tab
  ├─ camera
  └─ uploaded video
        │
        │ 704×704 JPEG sample every 100 ms
        ▼
latest-frame-wins pump
  ├─ one request in flight
  └─ one replaceable fresh frame waiting
        │
        ▼
direct fal realtime WebSocket
        │ RIFE pair
        ▼
evenly paced 768×768 output
        ├─ conservative source-translation warp between results
        ├─ live diagnostics
        ├─ Fullscreen output mode
        └─ 1080×1080 / 30 fps recording compositor

localhost FastAPI
  └─ validates access code + exact model
     and mints a short-lived token with the user's ignored FAL_KEY
```

The Python server never receives the captured images. There is no database,
account system, job queue, frontend build system, or hosted billing service.

## Findings from the failed and corrected pipelines

### Lockstep was too stale

The first version captured only after a cloud result. Its recording contained
2.61 native result bursts per second and 324–376 ms freezes. Scrolling usually
happened between samples, so the model never saw it.

### Unbounded concurrency was too latent

Submitting all 10 samples per second increased throughput to 4.4 native / 8.5
presented fps, but the service queue reached 1.66 seconds of frame age. That was
visually smoother but no longer responsive.

### Latest-frame-wins is the useful operating point

Sampling still runs at 10 fps, but only one inference request is active. New
source frames continually replace a single waiting frame. The final runs held
near 4 native / 8 presented fps, with a measured latest latency as low as 138
ms and p95 displayed-frame age of 292–449 ms including startup.

The presentation scheduler treats `[interpolated, current]` as one batch and
spaces the pair using an EWMA of native-result intervals. This removes the old
45 ms burst followed by a long freeze.

### Translation compensation improves the held intervals

The realtime R&D branch adds a bounded 48×48 luma translation search on each
source sample. When confidence clears the texture/error gate, the last model
image moves with the observed scroll or pan until the next RIFE/native image
arrives. Translation is clamped to 5.5% of a frame and exposed as `warp` fps;
it is never counted as a native or interpolated model result. Compare records
the disclosed warped view, while Lab retains the exact unwarped native pair.

On the identical 12-second free benchmark, genuinely changing output cadence
rose from 5.25 to 6.83 fps (+30.1%) at unchanged native throughput, queue depth,
and cost. A bounded real-FLUX run under slower service load measured 3.2 native,
6.4 native/interpolated model, 1.6 warp, and 8.20 independently changing output
frames/s. Its 549 ms p95 native-anchor age did not improve on the prior release
receipt, so the result supports presentation continuity rather than faster
inference. Edge clamping can briefly stretch border pixels; zoom/affine motion
remains a separate future experiment.

## Making motion visible to the model

The first validation source was effectively static. The release's built-in
source is intentionally model-friendly:

- one centered browser on a quiet warm stage;
- large colorful geometry instead of tiny text;
- a whole-map pan and slight zoom, including blocks and markers;
- a deliberate cut after 6.5 seconds;
- a gallery whose cards leave and enter the viewport at 172 pixels per second;
- a moving scrollbar as an unambiguous scroll cue.

Increasing output feedback from 0.90 to 0.95 reduced latent persistence and
allowed large motion while keeping a coherent clay palette.

## Captured-tab interaction

Desktop Chrome 136+ provides
[Captured Surface Control](https://developer.chrome.com/docs/web-platform/captured-surface-control).
SurfaceShift associates a `CaptureController` with `getDisplayMedia()`, checks
that the selected surface is a browser tab, and forwards wheel events from the
generated output to that tab. The app stays foreground, avoiding background-tab
timer throttling while the user scrolls the source.

Capture requests also exclude the current tab and monitor surfaces. This
prevents the hall-of-mirrors desktop capture seen in the failed recording. On
unsupported browsers, the honest fallback is two visible side-by-side windows.

References:

- [Captured Surface Control](https://developer.chrome.com/docs/web-platform/captured-surface-control)
- [`getDisplayMedia()` options](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Canvas capture behavior](https://developer.chrome.com/blog/capture-stream/)

## Production and billing boundary

- No hosted app is maintained; the README embeds a real recorded result.
- Live FLUX.2 runs only from localhost with each user's own ignored key.
- The exact realtime model is allowlisted server-side.
- Token and health responses use `Cache-Control: no-store`.
- A 10-second first-frame timeout and selected 15/45/90-second session deadline
  close the WebSocket and recording.
- Stop invalidates delayed captures, closes connecting fal sockets, clears
  pending request metadata, and prevents trailing sends.
- The local access code is a safety gate, not authentication or a hard budget.

At the rate listed July 16, 2026—$0.00194 per compute-second—the per-session
rate-times-cap estimate is about $0.029. Pricing and service behavior can
change; users should check the
[current endpoint page](https://fal.ai/models/fal-ai/flux-2/klein/realtime).

## Current result and honest limit

The retained validation take is 14 seconds, 1080×1080, constant 30 fps H.264.
Its generated image shows unmistakable map movement and gallery scrolling, and
post-warm-up holds average 129 ms instead of 353 ms. The README showcase was
updated on July 18 to a separate 22.89-second, 1920×1080 live-compare edit; its
purpose is presentation, while the retained take remains the measurement
artifact.

The clean framing and Create recording improve on the failed capture and
avoid exposing the user's whole desktop. Ryan's original still has finer map
detail and a substantially higher reported generated cadence. Reaching true
20 fps would require faster inference capacity or a different local/hosted
runtime; duplicating frames in a 60 fps export would not be equivalent.

## Primary references

- [FLUX.2 [klein] Realtime API](https://fal.ai/models/fal-ai/flux-2/klein/realtime/api)
- [fal realtime authentication](https://fal.ai/docs/documentation/model-apis/inference/real-time)
- [fal payload handling](https://fal.ai/docs/documentation/model-apis/inference/payloads)
- [fal JavaScript client](https://github.com/fal-ai/fal-js)
- [Black Forest Labs FLUX.2 repository](https://github.com/black-forest-labs/flux2)
