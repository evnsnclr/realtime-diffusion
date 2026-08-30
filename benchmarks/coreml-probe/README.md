# Core ML go/no-go probe

Decides whether this machine supports a fully local, $0 SurfaceShift
inference tier. Times the UNet forward pass of the prebuilt
[keijiro-tk/coreml-sd-turbo](https://huggingface.co/keijiro-tk/coreml-sd-turbo)
conversion (batch-2, so the reading is conservative) on each compute unit.

```bash
./run.sh
```

First run downloads ~1.7 GB of weights into `weights/` (gitignored, cached).
Decision rule: median UNet step **≤ 125 ms** → a local tier can hold ~8+ fps
and is worth building (SDXS-512 as the production target); slower → the
cloud path stays strictly better here. `--units CPU_AND_NE` adds a
Neural-Engine-only pass (first load can take minutes to compile).

## Measured results

| Date | Machine | CPU_AND_GPU | ALL | Verdict |
|---|---|---|---|---|
| 2026-08-30 | Apple M4 Max · 48 GB · macOS 15.6 | **131.6 ms** median (130.4–140.3, n=15) | 178.6 ms | **NO-GO** by the 125 ms rule |

Reading the number honestly: this conversion is batch-2, so 131.6 ms buys two
frames of UNet compute (~66 ms/frame of raw cost). Naive single-frame use lands
at ~7.6 fps — just under the bar, so the local tier stays out of v1. A batch-1
SDXS-512 conversion (~2.2× faster than SD-Turbo at equal backend) is the
promising v1.1 experiment.
