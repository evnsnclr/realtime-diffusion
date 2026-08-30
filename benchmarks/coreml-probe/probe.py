"""Core ML go/no-go probe for a local SurfaceShift inference tier.

Times one denoising step (the UNet forward pass) of the prebuilt
keijiro-tk/coreml-sd-turbo conversion on this machine, per compute unit.
The decision rule, from docs/RESEARCH_AND_BUILD_PLAN.md follow-up research:
a median UNet forward under ~125 ms supports an 8+ fps local tier that
matches the cloud path's presented rate at zero cost; anything slower means
the cloud path stays strictly better and local work stops here.

Note: this conversion is batch-2 (classifier-free-guidance layout), so one
predict does two frames' worth of UNet work. Judging the batch-2 time
against the single-frame threshold is deliberately conservative.

Pure helpers live at module top so tests can import them without
coremltools installed; heavy imports happen inside main().
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import subprocess
import time
from pathlib import Path

REPO_ID = "keijiro-tk/coreml-sd-turbo"
UNET_SUBPATH = "original/compiled/Unet.mlmodelc"
THRESHOLD_MS = 125.0
WARMUP_RUNS = 3
TIMED_RUNS = 15
DEFAULT_UNITS = ("CPU_AND_GPU", "ALL")

NUMPY_DTYPES = {
    "Float16": "float16",
    "Float32": "float32",
    "Int32": "int32",
}


def parse_input_schema(metadata: list) -> list[dict]:
    """Extract [{name, dtype, shape}] from an .mlmodelc metadata.json blob."""
    if not metadata or "inputSchema" not in metadata[0]:
        raise ValueError("metadata.json has no inputSchema")
    inputs = []
    for entry in metadata[0]["inputSchema"]:
        dtype = NUMPY_DTYPES.get(entry["dataType"])
        if dtype is None:
            raise ValueError(f"Unsupported input dtype {entry['dataType']!r}")
        shape = json.loads(entry["shape"])
        if not shape or not all(isinstance(d, int) and d > 0 for d in shape):
            raise ValueError(f"Bad shape for {entry['name']!r}: {entry['shape']!r}")
        inputs.append({"name": entry["name"], "dtype": dtype, "shape": shape})
    return inputs


def verdict(best_median_ms: float, threshold_ms: float = THRESHOLD_MS) -> dict:
    projected_fps = 1000.0 / best_median_ms if best_median_ms > 0 else 0.0
    go = best_median_ms <= threshold_ms
    message = (
        f"GO — {best_median_ms:.1f} ms/UNet step ({projected_fps:.1f} steps/s) is under "
        f"the {threshold_ms:.0f} ms bar: a local Core ML tier is worth building."
        if go
        else f"NO-GO — {best_median_ms:.1f} ms/UNet step is over the {threshold_ms:.0f} ms "
        "bar: the cloud path stays strictly better on this machine."
    )
    return {"go": go, "median_ms": best_median_ms, "projected_fps": projected_fps, "message": message}


def machine_summary() -> str:
    try:
        chip = subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        chip = platform.processor() or "unknown"
    return f"{chip} · macOS {platform.mac_ver()[0]} · {platform.machine()}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--units", nargs="+", default=list(DEFAULT_UNITS),
        choices=["CPU_AND_GPU", "ALL", "CPU_AND_NE", "CPU_ONLY"],
        help="Compute units to benchmark (CPU_AND_NE can take minutes to compile on first load)",
    )
    parser.add_argument("--runs", type=int, default=TIMED_RUNS)
    args = parser.parse_args()

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        print("This probe needs an Apple Silicon Mac.")
        return 1

    import coremltools as ct
    import numpy as np
    from huggingface_hub import snapshot_download

    print(f"Machine: {machine_summary()}")
    weights_dir = Path(__file__).resolve().parent / "weights"
    print(f"Fetching {REPO_ID} UNet (~1.7 GB, cached after the first run) ...")
    try:
        snapshot_download(
            repo_id=REPO_ID,
            allow_patterns=[f"{UNET_SUBPATH}/*"],
            local_dir=weights_dir,
        )
    except Exception as error:
        raise SystemExit(
            f"Could not download {REPO_ID} from Hugging Face"
            f" ({type(error).__name__}). Check the repo still exists and retry."
        ) from error
    unet_path = weights_dir / UNET_SUBPATH
    try:
        metadata = json.loads((unet_path / "metadata.json").read_text())
    except (OSError, ValueError) as error:
        raise SystemExit(
            f"{UNET_SUBPATH}/metadata.json is missing or unreadable — the repo"
            f" layout may have changed ({type(error).__name__})."
        ) from error
    inputs_spec = parse_input_schema(metadata)
    print("UNet inputs:", ", ".join(f"{i['name']}{i['shape']}" for i in inputs_spec))

    rng = np.random.default_rng(35)
    feed = {
        spec["name"]: rng.standard_normal(spec["shape"]).astype(spec["dtype"])
        for spec in inputs_spec
    }

    results = {}
    for unit_name in args.units:
        unit = getattr(ct.ComputeUnit, unit_name)
        print(f"\n[{unit_name}] loading compiled model ...")
        load_start = time.perf_counter()
        model = ct.models.CompiledMLModel(str(unet_path), compute_units=unit)
        load_seconds = time.perf_counter() - load_start
        warmup = WARMUP_RUNS * 3 if unit_name == "CPU_AND_NE" else WARMUP_RUNS
        for _ in range(warmup):
            model.predict(feed)
        timings = []
        for _ in range(args.runs):
            start = time.perf_counter()
            model.predict(feed)
            timings.append((time.perf_counter() - start) * 1000.0)
        median = statistics.median(timings)
        results[unit_name] = median
        print(
            f"[{unit_name}] load {load_seconds:.1f}s · median {median:.1f} ms · "
            f"min {min(timings):.1f} · max {max(timings):.1f} ms over {args.runs} runs"
        )
        del model

    best_unit = min(results, key=results.get)
    outcome = verdict(results[best_unit])
    print(f"\nBest compute unit: {best_unit}")
    print(outcome["message"])
    print(
        "(Batch-2 model: one step covers two frames, so the honest per-frame "
        "cost is at or below this number. End-to-end adds ~13 ms of tiny-VAE.)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
