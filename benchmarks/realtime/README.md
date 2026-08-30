# Deterministic realtime preview benchmark

This free benchmark isolates presentation behavior from fal service variance. It
renders the same 12-second RGB source suite every time:

- `0–4 s`: card-grid scrolling with reversals and pauses;
- `4–8 s`: two-axis map panning with two zoom changes;
- `8–12 s`: cards, pseudo-text, icons, and a face under modest motion.

The baseline simulates the released latest-frame-wins policy at 10 source
samples/s, 4 native results/s, two returned presentation images per result, and
a 30 fps recording compositor. The video places the current source on the left
and the presented output on the right. `frames.jsonl` records source capture,
encode, queue, send, receive, decode, presentation, and recording-compositor
timestamps.

Run it from the repository root:

```bash
node benchmarks/realtime/run-preview-benchmark.mjs \
  --mode=baseline \
  --output-dir=output/realtime-rd/baseline
```

The result is a scheduler/presentation benchmark, not a model-quality result.
It makes no claim about live fal throughput, paid cost, or text fidelity. A
candidate must reuse the same source hash and timing before its metrics or video
can be compared with the baseline.
