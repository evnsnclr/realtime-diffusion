import assert from "node:assert/strict";
import test from "node:test";

import { createCloudPresenter } from "../static/cloud-presenter.js";

const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function recordingContext() {
  const calls = [];
  const record = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    globalAlpha: 1,
    clearRect: record("clearRect"),
    drawImage: record("drawImage"),
    save: record("save"),
    restore: record("restore"),
    getImageData: (...args) => {
      calls.push({ name: "getImageData", args });
      return { data: new Uint8ClampedArray(48 * 48 * 4) };
    },
  };
}

function fakeCanvas(width, height) {
  const context = recordingContext();
  return { width, height, getContext: () => context, context };
}

function fakeBitmap(label) {
  return { label, closed: false, close() { this.closed = true; } };
}

function freshState() {
  return {
    latestOutputBatch: null,
    outputBusy: false,
    outputTimer: null,
    activeOutput: null,
    cloudBaseFrame: null,
    lastMotionSignature: "0:0",
    displayFrame: null,
    stats: {
      startedAt: 0,
      nativeResults: 0,
      displayedFrames: 0,
      motionCompensatedFrames: 0,
      lastNativeAt: 0,
      nativeIntervalEwma: 320,
      latencies: [],
      displayedAges: [],
      motionResponseAges: [],
    },
  };
}

function harness({ currentRun = () => true, bitmapLoader } = {}) {
  const state = freshState();
  const timers = {
    scheduled: [],
    setTimeout(callback, delayMs) {
      this.scheduled.push({ callback, delayMs });
      return this.scheduled.length;
    },
    clearTimeout() {},
  };
  const tracker = {
    sampleWidth: 48,
    sampleHeight: 48,
    lastCapturedAt: 0,
    resets: 0,
    delta: { x: 0, y: 0 },
    observation: { estimate: { accepted: false }, x: 0, y: 0 },
    deltaFrom() { return this.delta; },
    observe(_luma, capturedAt) {
      this.lastCapturedAt = capturedAt;
      return this.observation;
    },
    snapshot() { return "tracker-snapshot"; },
    reset() { this.resets += 1; },
  };
  const spies = { published: [], marked: [], badge: 0, errors: [] };
  const outputCanvas = fakeCanvas(768, 768);
  const presenter = createCloudPresenter({
    state,
    timers,
    isCurrentRun: currentRun,
    getEffectStrength: () => 0.95,
    publishMatchedPair: (source, output, pair) => spies.published.push(pair),
    markGeneratedFrame: (label) => spies.marked.push(label),
    updatePerformanceBadge: () => { spies.badge += 1; },
    onError: (error, generation) => spies.errors.push({ error, generation }),
    elements: {
      outputCanvas,
      cloudOutputCanvas: fakeCanvas(768, 768),
      captureCanvas: fakeCanvas(704, 704),
      motionSampleCanvas: fakeCanvas(48, 48),
    },
    motionTracker: tracker,
    bitmapLoader: bitmapLoader ?? {
      fromRaw: async (image) => fakeBitmap(image.id),
      fromDataUrl: async () => fakeBitmap("source"),
    },
  });
  return { presenter, state, timers, tracker, spies, outputCanvas };
}

function batch(overrides = {}) {
  return {
    images: [{ id: "native" }],
    sourceDataUrl: "data:image/jpeg;base64,xx",
    requestId: "req-1",
    capturedAt: performance.now(),
    latencyMs: 140,
    style: "clay",
    generation: 1,
    motionSnapshot: "anchor-1",
    ...overrides,
  };
}

test("a single native image paints, publishes the exact pair, and finishes", async () => {
  const { presenter, state, spies } = harness();
  presenter.submit(batch());
  await flush();

  assert.equal(spies.published.length, 1);
  assert.equal(spies.published[0].style, "clay");
  assert.deepEqual(spies.marked, ["FLUX.2 · 140ms"]);
  assert.equal(state.stats.displayedFrames, 1);
  assert.equal(state.outputBusy, false);
  assert.equal(state.activeOutput, null);
  assert.equal(state.cloudBaseFrame.motionAnchor, "anchor-1");
  assert.equal(state.displayFrame.motionCompensated, false);
});

test("a RIFE pair paces the second frame through the injected timer", async () => {
  const { presenter, state, timers, spies } = harness();
  presenter.submit(batch({ images: [{ id: "interp" }, { id: "native" }] }));
  await flush();

  assert.equal(spies.published.length, 0);
  assert.equal(spies.marked.length, 1);
  assert.equal(timers.scheduled.length, 1);
  const { callback, delayMs } = timers.scheduled[0];
  assert.ok(delayMs >= 45 && delayMs <= 190, `delay ${delayMs}`);
  assert.equal(state.displayFrame.interpolated, true);

  callback();
  await flush();
  assert.equal(spies.published.length, 1);
  assert.equal(state.stats.displayedFrames, 2);
  assert.equal(state.displayFrame.interpolated, false);
  assert.equal(state.activeOutput, null);
});

test("submitting while busy keeps only the newest batch, then drains it", async () => {
  const { presenter, state, spies } = harness();
  presenter.submit(batch({ latencyMs: 100 }));
  presenter.submit(batch({ latencyMs: 200, requestId: "req-2" }));
  assert.equal(state.latestOutputBatch.requestId, "req-2");
  await flush();

  assert.deepEqual(spies.marked, ["FLUX.2 · 100ms", "FLUX.2 · 200ms"]);
  assert.equal(state.stats.displayedFrames, 2);
  assert.equal(state.latestOutputBatch, null);
});

test("a stale generation closes its bitmaps without painting", async () => {
  const created = [];
  const { presenter, state, spies } = harness({
    currentRun: () => false,
    bitmapLoader: {
      fromRaw: async (image) => { const b = fakeBitmap(image.id); created.push(b); return b; },
      fromDataUrl: async () => { const b = fakeBitmap("source"); created.push(b); return b; },
    },
  });
  presenter.submit(batch());
  await flush();

  assert.equal(spies.published.length, 0);
  assert.equal(spies.marked.length, 0);
  assert.equal(state.outputBusy, false);
  assert.equal(state.activeOutput, null);
  assert.equal(created.length, 2);
  assert.ok(created.every((bitmap) => bitmap.closed), "stale bitmaps must be closed");
});

test("observeMotion presents a deduplicated warp frame when the tracker accepts", async () => {
  const { presenter, state, tracker, spies, outputCanvas } = harness();
  presenter.submit(batch());
  await flush();
  const drawsAfterNative = outputCanvas.context.calls.filter((c) => c.name === "drawImage").length;

  tracker.observation = { estimate: { accepted: true }, x: 0.02, y: 0 };
  tracker.delta = { x: 0.02, y: 0 };
  presenter.observeMotion(1, 1000);

  assert.equal(state.stats.motionCompensatedFrames, 1);
  assert.equal(state.displayFrame.motionCompensated, true);
  assert.equal(state.displayFrame.translationX, Math.round(0.02 * 768));
  assert.ok(outputCanvas.context.calls.filter((c) => c.name === "drawImage").length > drawsAfterNative);

  presenter.observeMotion(1, 1100);
  assert.equal(state.stats.motionCompensatedFrames, 1, "same delta must dedupe");
});

test("presentBase without a base frame is a safe no-op", () => {
  const { presenter } = harness();
  assert.equal(presenter.presentBase({ motionOnly: true }), false);
});

test("discardPending closes active bitmaps and clears the queue", async () => {
  const { presenter, state } = harness();
  presenter.submit(batch({ images: [{ id: "interp" }, { id: "native" }] }));
  await flush();
  const held = state.activeOutput;
  assert.ok(held && held.bitmaps.length === 2);

  presenter.discardPending();
  assert.equal(state.activeOutput, null);
  assert.equal(state.outputBusy, false);
  assert.ok(held.bitmaps.every((bitmap) => bitmap.closed));
  assert.equal(held.source.closed, true);
});

test("a loader failure reports through onError and frees the pipeline", async () => {
  const { presenter, state, spies } = harness({
    bitmapLoader: {
      fromRaw: async () => { throw new Error("decode failed"); },
      fromDataUrl: async () => fakeBitmap("source"),
    },
  });
  presenter.submit(batch({ generation: 9 }));
  await flush();

  assert.equal(spies.errors.length, 1);
  assert.equal(spies.errors[0].generation, 9);
  assert.match(spies.errors[0].error.message, /decode failed/);
  assert.equal(spies.published.length, 0);
  assert.equal(state.outputBusy, false, "pipeline must be free for the next batch");
});
