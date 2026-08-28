import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  SCENARIOS,
  blendFrames,
  joinFrames,
  meanAbsoluteDifference,
  renderScenarioFrame,
  stylizeFrame,
} from "../benchmarks/realtime/scenarios.mjs";

test("all realtime scenarios render deterministic RGB frames", () => {
  const hashes = [];
  for (const scenario of SCENARIOS) {
    const first = renderScenarioFrame(scenario, 1_234).pixels;
    const second = renderScenarioFrame(scenario, 1_234).pixels;
    assert.equal(first.length, FRAME_WIDTH * FRAME_HEIGHT * 3);
    assert.deepEqual(first, second);
    hashes.push(createHash("sha256").update(first).digest("hex"));
  }
  assert.equal(new Set(hashes).size, SCENARIOS.length);
});

test("each scenario contains measurable deterministic motion", () => {
  for (const scenario of SCENARIOS) {
    const early = renderScenarioFrame(scenario, 500).pixels;
    const late = renderScenarioFrame(scenario, 3_500).pixels;
    assert.ok(meanAbsoluteDifference(early, late) > 1, `${scenario} should move`);
  }
});

test("preview stylization and interpolation preserve dimensions without aliasing", () => {
  const source = renderScenarioFrame("structure", 1_000).pixels;
  const later = renderScenarioFrame("structure", 2_000).pixels;
  const stylized = stylizeFrame(source);
  const interpolated = blendFrames(stylized, stylizeFrame(later));
  const comparison = joinFrames(source, interpolated);

  assert.equal(stylized.length, source.length);
  assert.equal(interpolated.length, source.length);
  assert.equal(comparison.length, source.length * 2);
  assert.notEqual(stylized, source);
  assert.ok(meanAbsoluteDifference(source, stylized) > 1);
});
