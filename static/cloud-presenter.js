/**
 * Cloud presenter: everything between a FLUX.2 result and the output canvas.
 *
 * Owns the latest-batch-wins drain loop, RIFE pair pacing, the effect blend,
 * and the global-translation warp presentation (motion tracker included).
 * Dependencies arrive through the factory, and the bitmap loader and timers
 * are injectable, so this pipeline is unit-testable without a browser.
 */

import {
  SourceMotionTracker,
  downsampleLuma,
  drawTranslatedWithEdgeFill,
} from "./motion-compensation.js?v=0.6.0";

async function fromDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  return createImageBitmap(await response.blob());
}

async function fromRaw(image) {
  if (image?.content instanceof Uint8Array) {
    return createImageBitmap(new Blob([image.content], { type: image.content_type || "image/jpeg" }));
  }
  if (image?.content instanceof ArrayBuffer) {
    return createImageBitmap(new Blob([image.content], { type: image.content_type || "image/jpeg" }));
  }
  if (typeof image?.content !== "string") throw new Error("FLUX.2 returned unreadable image bytes");
  const dataUrl = image.content.startsWith("data:")
    ? image.content
    : `data:${image.content_type || "image/jpeg"};base64,${image.content}`;
  return fromDataUrl(dataUrl);
}

export const defaultBitmapLoader = { fromRaw, fromDataUrl };

export function createCloudPresenter({
  state,
  timers,
  isCurrentRun,
  getEffectStrength,
  publishMatchedPair,
  markGeneratedFrame,
  updatePerformanceBadge,
  onError,
  elements: { outputCanvas, cloudOutputCanvas, captureCanvas, motionSampleCanvas },
  motionTracker = new SourceMotionTracker({ sampleWidth: 48, sampleHeight: 48 }),
  bitmapLoader = defaultBitmapLoader,
}) {
  const outputContext = outputCanvas.getContext("2d");
  const cloudOutputContext = cloudOutputCanvas.getContext("2d");
  const motionSampleContext = motionSampleCanvas.getContext("2d", { willReadFrequently: true });

  function motionDeltaPixels(anchor) {
    const delta = motionTracker.deltaFrom(anchor);
    return {
      x: Math.round(delta.x * outputCanvas.width),
      y: Math.round(delta.y * outputCanvas.height),
    };
  }

  function presentCloudBase({ motionOnly = false } = {}) {
    const base = state.cloudBaseFrame;
    if (!base) return false;
    const delta = motionDeltaPixels(base.motionAnchor);
    const signature = `${delta.x}:${delta.y}`;
    if (motionOnly && (signature === state.lastMotionSignature || (delta.x === 0 && delta.y === 0))) {
      state.lastMotionSignature = signature;
      return false;
    }

    drawTranslatedWithEdgeFill(
      outputContext,
      cloudOutputCanvas,
      outputCanvas.width,
      outputCanvas.height,
      delta.x,
      delta.y,
    );
    const displayedAt = performance.now();
    state.lastMotionSignature = signature;
    state.displayFrame = {
      ...base.displayFrame,
      displayedAt,
      motionCompensated: delta.x !== 0 || delta.y !== 0,
      motionCapturedAt: motionTracker.lastCapturedAt,
      translationX: delta.x,
      translationY: delta.y,
    };
    if (motionOnly) {
      state.stats.motionCompensatedFrames += 1;
      state.stats.displayedAges.push(Math.max(0, displayedAt - base.displayFrame.capturedAt));
      state.stats.motionResponseAges.push(
        Math.max(0, displayedAt - (motionTracker.lastCapturedAt || displayedAt)),
      );
      if (state.stats.displayedAges.length > 120) state.stats.displayedAges.shift();
      if (state.stats.motionResponseAges.length > 120) state.stats.motionResponseAges.shift();
      updatePerformanceBadge();
    }
    return true;
  }

  function observeCloudMotion(generation, capturedAt = performance.now()) {
    motionSampleContext.clearRect(0, 0, motionSampleCanvas.width, motionSampleCanvas.height);
    motionSampleContext.drawImage(
      captureCanvas,
      0,
      0,
      motionSampleCanvas.width,
      motionSampleCanvas.height,
    );
    const imageData = motionSampleContext.getImageData(
      0,
      0,
      motionSampleCanvas.width,
      motionSampleCanvas.height,
    );
    const sample = downsampleLuma(
      imageData.data,
      motionSampleCanvas.width,
      motionSampleCanvas.height,
      {
        channels: 4,
        sampleWidth: motionTracker.sampleWidth,
        sampleHeight: motionTracker.sampleHeight,
        insetFraction: 0,
      },
    );
    const observation = motionTracker.observe(sample.luma, capturedAt);
    if (observation.estimate.accepted && isCurrentRun(generation)) {
      presentCloudBase({ motionOnly: true });
    }
    return { x: observation.x, y: observation.y, capturedAt };
  }

  function closeActiveOutput() {
    if (!state.activeOutput) return;
    for (const bitmap of state.activeOutput.bitmaps || []) bitmap.close?.();
    state.activeOutput.source?.close?.();
    state.activeOutput = null;
  }

  function finishOutputBatch(generation) {
    closeActiveOutput();
    state.outputBusy = false;
    if (isCurrentRun(generation)) drainOutputBatch();
  }

  function drainOutputBatch() {
    if (state.outputBusy || !state.latestOutputBatch) return;
    const batch = state.latestOutputBatch;
    state.latestOutputBatch = null;
    state.outputBusy = true;
    void prepareOutputBatch(batch);
  }

  async function prepareOutputBatch(batch) {
    try {
      const [bitmaps, source] = await Promise.all([
        Promise.all(batch.images.map((image) => bitmapLoader.fromRaw(image))),
        bitmapLoader.fromDataUrl(batch.sourceDataUrl),
      ]);
      if (!isCurrentRun(batch.generation)) {
        bitmaps.forEach((bitmap) => bitmap.close());
        source?.close();
        state.outputBusy = false;
        return;
      }

      state.activeOutput = { bitmaps, source };
      paintCloudBitmap(bitmaps[0], source, batch, { publishPair: bitmaps.length === 1 });
      if (bitmaps.length === 1) {
        finishOutputBatch(batch.generation);
        return;
      }

      const delay = Math.max(45, Math.min(190, state.stats.nativeIntervalEwma / 2));
      state.outputTimer = timers.setTimeout(() => {
        state.outputTimer = null;
        if (isCurrentRun(batch.generation)) {
          paintCloudBitmap(bitmaps.at(-1), source, batch, { publishPair: true });
        }
        finishOutputBatch(batch.generation);
      }, delay);
    } catch (error) {
      finishOutputBatch(batch.generation);
      onError(error, batch.generation);
    }
  }

  function paintCloudBitmap(generated, source, batch, { publishPair = false } = {}) {
    const effect = getEffectStrength();
    cloudOutputContext.save();
    cloudOutputContext.clearRect(0, 0, cloudOutputCanvas.width, cloudOutputCanvas.height);
    if (source) {
      cloudOutputContext.drawImage(source, 0, 0, cloudOutputCanvas.width, cloudOutputCanvas.height);
      cloudOutputContext.globalAlpha = effect;
    }
    cloudOutputContext.drawImage(generated, 0, 0, cloudOutputCanvas.width, cloudOutputCanvas.height);
    cloudOutputContext.restore();
    if (publishPair) {
      publishMatchedPair(source, generated, {
        requestId: batch.requestId,
        capturedAt: batch.capturedAt,
        latencyMs: batch.latencyMs,
        style: batch.style,
      });
    }

    const displayAge = performance.now() - batch.capturedAt;
    state.cloudBaseFrame = {
      motionAnchor: batch.motionSnapshot || motionTracker.snapshot(),
      displayFrame: {
        capturedAt: batch.capturedAt,
        latencyMs: batch.latencyMs,
        displayedAt: performance.now(),
        interpolated: !publishPair,
        motionCompensated: false,
      },
    };
    presentCloudBase();
    state.stats.displayedFrames += 1;
    state.stats.displayedAges.push(displayAge);
    if (state.stats.displayedAges.length > 120) state.stats.displayedAges.shift();
    markGeneratedFrame(`FLUX.2 · ${Math.round(batch.latencyMs)}ms`);
    updatePerformanceBadge();
  }

  function submit(batch) {
    state.latestOutputBatch = batch;
    drainOutputBatch();
  }

  function discardPending() {
    state.latestOutputBatch = null;
    state.outputBusy = false;
    closeActiveOutput();
  }

  function resetMotion() {
    motionTracker.reset();
  }

  return {
    observeMotion: observeCloudMotion,
    presentBase: presentCloudBase,
    submit,
    discardPending,
    resetMotion,
  };
}
