import assert from "node:assert/strict";
import test from "node:test";

import {
  SourceMotionTracker,
  downsampleLuma,
  estimateTranslation,
  translateRgbFrameClamped,
} from "../static/motion-compensation.js";

function texturedLuma(width, height) {
  const output = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      output[y * width + x] = (x * 37 + y * 61 + ((x * y) % 17) * 9) % 256;
    }
  }
  return output;
}

function translateLuma(previous, width, height, dx, dy) {
  const output = new Float32Array(previous.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(width - 1, x - dx));
      const sourceY = Math.max(0, Math.min(height - 1, y - dy));
      output[y * width + x] = previous[sourceY * width + sourceX];
    }
  }
  return output;
}

test("global translation estimation recovers horizontal and vertical motion", () => {
  const width = 48;
  const height = 32;
  const previous = texturedLuma(width, height);
  const current = translateLuma(previous, width, height, 3, -2);
  const estimate = estimateTranslation(previous, current, width, height, { maxShift: 5 });

  assert.equal(estimate.accepted, true);
  assert.equal(estimate.dx, 3);
  assert.equal(estimate.dy, -2);
  assert.ok(estimate.improvement > 0.8);
});

test("static and textureless frames do not invent compensated motion", () => {
  const flat = new Float32Array(48 * 32).fill(120);
  const estimate = estimateTranslation(flat, flat, 48, 32);
  assert.deepEqual({ dx: estimate.dx, dy: estimate.dy, accepted: estimate.accepted }, {
    dx: 0,
    dy: 0,
    accepted: false,
  });
});

test("motion tracker accumulates accepted steps and resets cleanly", () => {
  const width = 48;
  const height = 32;
  const tracker = new SourceMotionTracker({ sampleWidth: width, sampleHeight: height, maxShift: 5 });
  const first = texturedLuma(width, height);
  const second = translateLuma(first, width, height, 2, 1);
  const third = translateLuma(second, width, height, -1, 2);

  const anchor = tracker.observe(first, 0);
  tracker.observe(second, 100);
  const latest = tracker.observe(third, 200);
  const delta = tracker.deltaFrom(anchor, { maximumWarpFraction: 0.2 });

  assert.equal(latest.estimate.accepted, true);
  assert.ok(Math.abs(delta.x - (1 / width)) < 1e-6);
  assert.ok(Math.abs(delta.y - (3 / height)) < 1e-6);
  tracker.reset();
  assert.deepEqual(tracker.snapshot(), { x: 0, y: 0, capturedAt: null });
});

test("RGB translation clamps edge pixels instead of exposing blank seams", () => {
  const pixels = new Uint8Array([
    10, 0, 0, 20, 0, 0, 30, 0, 0,
    40, 0, 0, 50, 0, 0, 60, 0, 0,
  ]);
  const shifted = translateRgbFrameClamped(pixels, 3, 2, 1, 0);
  assert.deepEqual([...shifted], [
    10, 0, 0, 10, 0, 0, 20, 0, 0,
    40, 0, 0, 40, 0, 0, 50, 0, 0,
  ]);
});

test("RGBA downsampling returns stable luma dimensions", () => {
  const rgba = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
  ]);
  const sample = downsampleLuma(rgba, 2, 2, {
    channels: 4,
    sampleWidth: 2,
    sampleHeight: 2,
    insetFraction: 0,
  });
  assert.equal(sample.luma.length, 4);
  assert.equal(sample.width, 2);
  assert.equal(sample.height, 2);
  assert.ok(sample.luma[3] > sample.luma[0]);
});
