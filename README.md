# SurfaceShift

**Restyle any live screen.** Turn a browser tab, camera, or video into a
responsive visual world with
[FLUX.2 [klein] Realtime](https://fal.ai/models/fal-ai/flux-2/klein/realtime).
Clay Screen is the signature material preset; the repository now lives at
`realtime-diffusion` (GitHub redirects old `clay-screen` links and clones).

[Watch the 23-second MP4](assets/clay-screen-demo.mp4) ·
[Validation receipt](docs/VALIDATION.md) ·
[Research notes](docs/RESEARCH_AND_BUILD_PLAN.md)

SurfaceShift intentionally has no hosted AI app. Clone it, run it on localhost,
and supply your own fal key. There is no Vercel deployment, GitHub Pages demo,
or owner-funded public inference endpoint.

## Real FLUX.2 demo

[![SurfaceShift transforming live maps and a scrolling gallery](assets/clay-screen-demo.gif)](assets/clay-screen-demo.mp4)

This is an actual FLUX.2 run recorded by SurfaceShift—not a design mockup. The
video opens in **Compare · live source + output** so the moving source and
displayed output remain visible together across a scrolling gallery and several
map zooms, then finishes with a clean generated-only clay interface.

The showcase is a 22.89-second, 1920×1080 H.264 MP4 at a constant 29.97 fps.
It preserves the recorded timing: no speed ramp or post-production optical-flow
frames were added. This is an edited showcase rather than a Lab exact-pair audit
or an inference-fps benchmark; see the [validation receipt](docs/VALIDATION.md) for
the measured recorder evidence and the retained output-only validation take.

## What it is for

- **Create:** clean stylized footage for launches, social posts, title
  sequences, and product stories.
- **Direct:** audition a material or visual language over a real interface,
  camera, map, or reference video before committing to production.
- **Perform:** use **Fullscreen output** for a projector, presentation, or OBS
  window capture. SurfaceShift does not install a virtual-camera device.
- **Evaluate:** record **Lab · exact native pairs** to inspect fidelity, drift,
  and motion response without presentation interpolation.

SurfaceShift is an art-direction and visual-prototyping tool. Generated text is
often pseudo-text, and details can drift, so it is not a faithful browser
replacement, an accessibility transform, or a tool for high-stakes content.

## Run locally

Requirements:

- Python 3.10 or newer
- macOS or Linux shell; native Windows is not currently tested
- a [fal API key](https://fal.ai/dashboard/keys) with a small available balance
- current Chrome for captured-tab scroll control; other modern browsers can use
  Demo, Camera, Video, or a side-by-side capture workflow

```bash
git clone https://github.com/evnsnclr/realtime-diffusion.git
cd realtime-diffusion
./setup.sh
```

`setup.sh` creates the virtualenv, installs dependencies, prompts for your fal
key, and generates a local access code for you (printed at the end and stored
in `.env.local`). Prefer manual setup? Copy `.env.example` to `.env.local`
(mode 600) and fill in both values yourself:

```dotenv
FAL_KEY=your_api_scoped_fal_key
SURFACESHIFT_ACCESS_CODE=choose_a_private_local_code
```

Then run:

```bash
./run_demo.sh
```

Open [http://127.0.0.1:7860](http://127.0.0.1:7860). The fal key stays on the
local Python server; the browser receives only an endpoint-scoped, short-lived
realtime token.

## Get a good demo immediately

1. Choose **Demo** and **Clay** at 100%.
2. Enter the access code from `.env.local`.
3. Choose the **45-second / about $0.09** session limit, then press **Start
   transforming**. The limit is a ceiling, so stopping earlier costs less.
4. Leave **Workspace** on **Compare · live source + output**, then press
   **Record**. It captures the continuously moving source beside the same
   native, interpolated, and motion-compensated output visible in the app.
5. Open the saved 1920×1080 comparison, or choose **Create · clean output**
   before recording for a 1080×1080 generated-only take. Use **Lab · exact
   native pairs** only when you need the precise source/result pairs.

Recording is a manual toggle inside the selected 15, 45, or 90-second cloud
limit. It uses a dedicated
presentation canvas targeting 30 fps and requests up to 16 Mbps for landscape
modes. Compare records the moving source and every displayed output update,
including RIFE interpolation and separately disclosed global-motion warps; its
footer shows native-anchor age so the model delay is explicit. Lab instead
pairs the precise JPEG sent to FLUX.2 with its unblended native result. That
audit mode intentionally excludes RIFE and warp frames and will therefore look
less fluid. Normalize the browser WebM below before posting to guarantee a
constant-frame-rate master.

## Float the output over your desktop

On Chrome or Edge 116+, press **Float output** once frames are flowing. The
generated view moves into a small always-on-top window (Chrome's Document
Picture-in-Picture), so you can keep working in other apps while the restyled
mirror floats beside them. Frame sampling is driven by a Web Worker, so the
session keeps running at full cadence even while the SurfaceShift tab is
covered or hidden. Two macOS caveats: the floating window does not follow
full-screen Spaces (keep work apps as regular windows), and closing the
SurfaceShift tab closes the overlay.

## Stream it with OBS (stage mode)

Add `http://127.0.0.1:7860/?stage=1` as an OBS **browser source**. Stage mode
strips the page down to the generated output on a transparent background; the
controls appear on hover, so drive them from OBS's Interact window. During a
cloud session a spend-ceiling readout stays on the frame (elapsed time at the
listed per-compute-second rate — actual billing counts compute seconds only).

## Transform and scroll a real browser tab

On desktop Chrome 136 or newer:

1. Choose **Browser tab** and select the tab you want to transform. SurfaceShift
   excludes the current tab and whole-monitor capture to prevent recursion.
2. Start transforming, then click **Scroll captured tab**.
3. Grant Chrome's one-time captured-surface permission.
4. Keep the pointer over the generated output and scroll. Chrome forwards those
   wheel events to the captured tab while SurfaceShift stays visible and keeps
   sampling.

This uses Chrome's
[Captured Surface Control API](https://developer.chrome.com/docs/web-platform/captured-surface-control).
If it is unavailable, keep SurfaceShift and the source visible side by side.
Switching away can throttle browser timers and reduce responsiveness.

## Why scrolling now works

The first implementation waited for FLUX.2 to return before taking another
screenshot. Most scroll motion happened between requests and was never sent.
The current pipeline separates capture from inference:

```text
moving source
  → sample at 10 fps
  → estimate conservative global source translation
  → retain only the newest waiting frame
  → one low-latency FLUX.2 request at a time
  → evenly pace the RIFE pair
  → warp the latest model image between results when motion is reliable
  → generated canvas + 30 fps recording compositor
```

This latest-frame-wins design avoids both failure modes: it does not miss all
motion while waiting, and it does not build a costly queue of stale cloud work.
A bounded 48×48 luma search now estimates scroll/pan translation and immediately
moves the last model image in the same direction. It does not invent new model
content: the diagnostics and Compare recording label these updates as `warp`,
separate from native/interpolated `model` updates. Lab remains unwarped.

The diagnostics badge reports sampled fps, native result fps,
native/interpolated model presentation fps, motion-compensated warp fps, and
p95 native-anchor age during each live run.

## Normalize a browser recording

Chrome normally saves VP9 WebM with browser timestamps. Convert the default
1920×1080 live comparison to a constant-frame-rate, seekable MP4 before posting:

```bash
ffmpeg -i surfaceshift-live.webm \
  -vf "fps=30,scale=1920:1080:flags=lanczos" \
  -c:v libx264 -crf 18 -preset slow -pix_fmt yuv420p \
  -movflags +faststart -an surfaceshift-live.mp4
```

For **Create · clean output**, change both dimensions back to `1080:1080`.

Do not use frame-rate conversion to hide a poor live run. The built-in badge
and the validation receipt distinguish encoded cadence from actual generated
cadence.

## Privacy and cost boundary

FLUX.2 mode sends the selected JPEG frames directly to fal over a realtime
WebSocket. The local FastAPI server supplies the short-lived token; it does not
receive, proxy, or intentionally store the frames. Share only content you are
comfortable sending to a third-party processor.

Choose a 15, 45, or 90-second ceiling before each cloud session. At the price
confirmed on July 20, 2026—$0.00194 per compute-second—the rate-times-limit
estimates are about **$0.03, $0.09, or $0.18**. Stopping early closes the
connection. These controls and the access code are local safety rails, not
account-level spending limits; a user can start another session. Keep a small
fal balance and recheck the
[current model page](https://fal.ai/models/fal-ai/flux-2/klein/realtime).

Every clone supplies its own credentials. Never deploy this token endpoint
publicly with your personal key unless you add real authentication, rate
limits, and an account-level budget.

## Optional private Mac fallback

The existing SD-Turbo fallback runs entirely on Apple Silicon. It is slower and
less faithful than FLUX.2, but sends no frames off-device:

```bash
./setup_mac.sh
./run_mac.sh
```

It requires macOS 14+, Apple Silicon, and about 6 GB for the one-time model
download. Leave `FAL_KEY` and `SURFACESHIFT_ACCESS_CODE` blank when using it.
The old `CLAY_SCREEN_*` variable names are still read for one release.

## Development

```bash
pip install -r requirements-dev.txt
npm ci
pytest -q
npm run check
npm test
```

CI uses mocks, leaves `FAL_KEY` unset, and never performs paid inference.

## License and attribution

SurfaceShift code is Apache-2.0 licensed. FLUX.2 mode uses the MIT-licensed,
pinned `@fal-ai/client`, fal's hosted service, and FLUX.2 [klein] from Black
Forest Labs; their terms apply separately. See [NOTICE](NOTICE).

The visual direction was inspired by
[Ryan Stephen's realtime diffusion UI experiment](https://x.com/Ryan__Stephen/status/2066890410824528077).
SurfaceShift is an independent implementation and does not reproduce the
original project's unpublished code or configuration.
