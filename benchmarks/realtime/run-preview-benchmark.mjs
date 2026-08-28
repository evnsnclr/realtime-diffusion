#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import process from "node:process";

import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  SCENARIO_DURATION_MS,
  SCENARIOS,
  blendFrames,
  joinFrames,
  meanAbsoluteDifference,
  renderScenarioFrame,
  stylizeFrame,
} from "./scenarios.mjs";
import {
  SourceMotionTracker,
  downsampleLuma,
  translateRgbFrameClamped,
} from "../../static/motion-compensation.js";

const ENCODED_FPS = 30;
const FRAME_INTERVAL_MS = 1_000 / ENCODED_FPS;
const SAMPLE_INTERVAL_MS = 100;
const NATIVE_ROUND_TRIP_MS = 250;
const DECODE_MS = 4;
const INTERPOLATION_DELAY_MS = NATIVE_ROUND_TRIP_MS / 2;
const CHANGE_THRESHOLD = 0.6;

function parseArguments(argv) {
  const values = { mode: "baseline", outputDir: "output/realtime-rd/baseline" };
  for (const argument of argv) {
    if (argument.startsWith("--mode=")) values.mode = argument.slice("--mode=".length);
    if (argument.startsWith("--output-dir=")) values.outputDir = argument.slice("--output-dir=".length);
  }
  if (!["baseline", "motion-translation-v1"].includes(values.mode)) {
    throw new Error(`Unsupported preview mode: ${values.mode}`);
  }
  return values;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function rounded(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function blankOutput() {
  const output = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 3);
  for (let offset = 0; offset < output.length; offset += 3) {
    output[offset] = 45;
    output[offset + 1] = 42;
    output[offset + 2] = 39;
  }
  return output;
}

function startEncoder(filename, width, height) {
  const encoder = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pixel_format", "rgb24",
    "-video_size", `${width}x${height}`,
    "-framerate", String(ENCODED_FPS), "-i", "pipe:0",
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
    "-pix_fmt", "yuv420p", "-movflags", "+faststart", filename,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  encoder.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    encoder.on("error", reject);
    encoder.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim()}`));
    });
  });
  return { encoder, completed };
}

async function writeFrame(stream, pixels) {
  if (!stream.write(pixels)) await once(stream, "drain");
}

function eventRecord(type, scenario, data = {}) {
  return { type, scenario, ...data };
}

function simulateScenario(name, mode) {
  const records = [];
  const ages = [];
  const roundTrips = [];
  const encodeDurations = [];
  const motionResponseAges = [];
  const renderedFrames = [];
  let nextSampleAt = 0;
  let inFlight = null;
  let waiting = null;
  let previousNative = null;
  let display = null;
  let displayCapturedAt = null;
  let presentationQueue = [];
  let nativeResults = 0;
  let presentationUpdates = 0;
  let interpolatedUpdates = 0;
  let replacedSamples = 0;
  let maxQueueDepth = 0;
  let changingEncodedFrames = 0;
  let previousEncodedOutput = null;
  let requestSequence = 0;
  let displayMotionAnchor = null;
  let motionCompensatedUpdates = 0;
  let previousMotionSignature = "0:0";
  const motionTracker = mode === "motion-translation-v1"
    ? new SourceMotionTracker({ sampleWidth: 48, sampleHeight: 48, maxShift: 6 })
    : null;

  const dispatch = (sample, sentAt) => {
    const requestId = `${name}-request-${++requestSequence}`;
    inFlight = {
      ...sample,
      requestId,
      sentAt,
      responseAt: sentAt + NATIVE_ROUND_TRIP_MS,
    };
    records.push(eventRecord("request-sent", name, {
      request_id: requestId,
      source_capture_start_ms: sample.captureStart,
      source_capture_complete_ms: sample.captureComplete,
      encode_start_ms: sample.encodeStart,
      encode_end_ms: sample.encodeEnd,
      request_queued_ms: sample.queuedAt,
      request_sent_ms: sentAt,
      queue_depth: Number(Boolean(waiting)) + 1,
    }));
    maxQueueDepth = Math.max(maxQueueDepth, Number(Boolean(waiting)) + 1);
  };

  const captureSample = (timeMs) => {
    const source = renderScenarioFrame(name, timeMs);
    let motionSnapshot = null;
    let motionEstimate = null;
    if (motionTracker) {
      const sample = downsampleLuma(source.pixels, FRAME_WIDTH, FRAME_HEIGHT, {
        channels: 3,
        sampleWidth: motionTracker.sampleWidth,
        sampleHeight: motionTracker.sampleHeight,
      });
      const observation = motionTracker.observe(sample.luma, timeMs);
      motionSnapshot = { x: observation.x, y: observation.y, capturedAt: timeMs };
      motionEstimate = observation.estimate;
    }
    const captureStart = timeMs;
    const captureComplete = timeMs + 0.8;
    const encodeStart = captureComplete;
    const encodeEnd = encodeStart + 1.5;
    const sample = {
      sourcePixels: source.pixels,
      sourceMotion: source.motion,
      capturedAt: timeMs,
      captureStart,
      captureComplete,
      encodeStart,
      encodeEnd,
      queuedAt: encodeEnd,
      motionSnapshot,
    };
    encodeDurations.push(encodeEnd - encodeStart);
    records.push(eventRecord("source-sampled", name, {
      source_capture_start_ms: captureStart,
      source_capture_complete_ms: captureComplete,
      encode_start_ms: encodeStart,
      encode_end_ms: encodeEnd,
      request_queued_ms: sample.queuedAt,
      motion_estimate: motionEstimate ? {
        dx: motionEstimate.dx,
        dy: motionEstimate.dy,
        accepted: motionEstimate.accepted,
        improvement: rounded(motionEstimate.improvement, 4),
        error: rounded(motionEstimate.error, 3),
      } : null,
    }));
    if (!inFlight) dispatch(sample, encodeEnd);
    else {
      if (waiting) replacedSamples += 1;
      waiting = sample;
      maxQueueDepth = Math.max(maxQueueDepth, 2);
    }
  };

  const receiveResult = () => {
    const request = inFlight;
    const responseReceived = request.responseAt;
    const decodeComplete = responseReceived + DECODE_MS;
    const native = stylizeFrame(request.sourcePixels);
    const interpolated = blendFrames(previousNative, native, 0.5);
    const latency = responseReceived - request.sentAt;
    nativeResults += 1;
    roundTrips.push(latency);
    records.push(eventRecord("native-result", name, {
      request_id: request.requestId,
      source_capture_start_ms: request.captureStart,
      source_capture_complete_ms: request.captureComplete,
      encode_start_ms: request.encodeStart,
      encode_end_ms: request.encodeEnd,
      request_queued_ms: request.queuedAt,
      request_sent_ms: request.sentAt,
      response_received_ms: responseReceived,
      image_decode_complete_ms: decodeComplete,
      native_round_trip_ms: latency,
    }));
    presentationQueue.push({
      at: decodeComplete,
      pixels: interpolated,
      capturedAt: request.capturedAt,
      requestId: request.requestId,
      interpolated: true,
      motionAnchor: request.motionSnapshot,
    });
    presentationQueue.push({
      at: decodeComplete + INTERPOLATION_DELAY_MS,
      pixels: native,
      capturedAt: request.capturedAt,
      requestId: request.requestId,
      interpolated: false,
      motionAnchor: request.motionSnapshot,
    });
    presentationQueue.sort((first, second) => first.at - second.at);
    previousNative = native;
    inFlight = null;
    if (waiting) {
      const next = waiting;
      waiting = null;
      dispatch(next, responseReceived + 0.5);
    }
  };

  const present = () => {
    const presentation = presentationQueue.shift();
    display = presentation.pixels;
    displayCapturedAt = presentation.capturedAt;
    displayMotionAnchor = presentation.motionAnchor;
    presentationUpdates += 1;
    if (presentation.interpolated) interpolatedUpdates += 1;
    const age = presentation.at - presentation.capturedAt;
    ages.push(age);
    records.push(eventRecord("presentation", name, {
      request_id: presentation.requestId,
      presentation_time_ms: presentation.at,
      source_capture_start_ms: presentation.capturedAt,
      displayed_frame_age_ms: age,
      frame_kind: presentation.interpolated ? "interpolated" : "native",
    }));
  };

  const processUntil = (timeMs) => {
    while (true) {
      const responseAt = inFlight?.responseAt ?? Infinity;
      const presentationAt = presentationQueue[0]?.at ?? Infinity;
      const eventAt = Math.min(nextSampleAt, responseAt, presentationAt);
      if (eventAt > timeMs || !Number.isFinite(eventAt)) break;
      if (eventAt === responseAt) receiveResult();
      else if (eventAt === presentationAt) present();
      else {
        captureSample(nextSampleAt);
        nextSampleAt += SAMPLE_INTERVAL_MS;
      }
    }
  };

  const frameCount = Math.round((SCENARIO_DURATION_MS / 1_000) * ENCODED_FPS);
  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const timeMs = frameIndex * FRAME_INTERVAL_MS;
    processUntil(timeMs);
    const source = renderScenarioFrame(name, timeMs).pixels;
    let output = display || blankOutput();
    let motionDelta = { x: 0, y: 0 };
    let motionCompensated = false;
    if (display && motionTracker && displayMotionAnchor) {
      motionDelta = motionTracker.deltaFrom(displayMotionAnchor);
      const dx = Math.round(motionDelta.x * FRAME_WIDTH);
      const dy = Math.round(motionDelta.y * FRAME_HEIGHT);
      motionCompensated = dx !== 0 || dy !== 0;
      if (motionCompensated) output = translateRgbFrameClamped(display, FRAME_WIDTH, FRAME_HEIGHT, dx, dy);
      const signature = `${dx}:${dy}`;
      if (motionCompensated && signature !== previousMotionSignature) {
        motionCompensatedUpdates += 1;
        const motionAge = timeMs - motionTracker.lastCapturedAt;
        motionResponseAges.push(motionAge);
        records.push(eventRecord("motion-compensated-presentation", name, {
          presentation_time_ms: timeMs,
          source_capture_start_ms: motionTracker.lastCapturedAt,
          native_anchor_capture_ms: displayCapturedAt,
          motion_response_age_ms: motionAge,
          translation_x_fraction: rounded(motionDelta.x, 5),
          translation_y_fraction: rounded(motionDelta.y, 5),
          frame_kind: "motion-compensated",
        }));
      }
      previousMotionSignature = signature;
    }
    if (previousEncodedOutput && meanAbsoluteDifference(previousEncodedOutput, output) > CHANGE_THRESHOLD) {
      changingEncodedFrames += 1;
    }
    previousEncodedOutput = new Uint8Array(output);
    const recordingCompositorStart = timeMs + 0.15;
    const recordingCompositorEnd = recordingCompositorStart + 0.65;
    records.push(eventRecord("recording-frame", name, {
      presentation_time_ms: timeMs,
      source_capture_start_ms: displayCapturedAt,
      recording_compositor_start_ms: recordingCompositorStart,
      recording_compositor_end_ms: recordingCompositorEnd,
      displayed_frame_age_ms: displayCapturedAt === null ? null : timeMs - displayCapturedAt,
      motion_compensated: motionCompensated,
      encoded_frame_index: frameIndex,
    }));
    renderedFrames.push({ source, output: new Uint8Array(output) });
  }

  const seconds = SCENARIO_DURATION_MS / 1_000;
  return {
    records,
    renderedFrames,
    metrics: {
      scenario: name,
      mode,
      duration_seconds: seconds,
      native_result_fps: rounded(nativeResults / seconds),
      genuinely_changing_displayed_fps: rounded(changingEncodedFrames / seconds),
      displayed_update_fps: rounded(presentationUpdates / seconds),
      interpolated_fps: rounded(interpolatedUpdates / seconds),
      motion_compensated_fps: rounded(motionCompensatedUpdates / seconds),
      encoded_fps: ENCODED_FPS,
      median_end_to_end_output_age_ms: rounded(percentile(ages, 0.5)),
      p95_end_to_end_output_age_ms: rounded(percentile(ages, 0.95)),
      median_native_round_trip_ms: rounded(percentile(roundTrips, 0.5)),
      p95_native_round_trip_ms: rounded(percentile(roundTrips, 0.95)),
      median_motion_response_age_ms: rounded(percentile(motionResponseAges, 0.5)),
      p95_motion_response_age_ms: rounded(percentile(motionResponseAges, 0.95)),
      skipped_or_replaced_source_samples: replacedSamples,
      maximum_queue_depth: maxQueueDepth,
      mean_encode_ms: rounded(encodeDurations.reduce((sum, value) => sum + value, 0) / encodeDurations.length),
      main_thread_long_tasks: null,
      approximate_paid_cost_usd: 0,
      session_failures: 0,
    },
    ages,
    roundTrips,
    motionResponseAges,
    totals: {
      nativeResults,
      presentationUpdates,
      interpolatedUpdates,
      changingEncodedFrames,
      motionCompensatedUpdates,
    },
  };
}

function aggregate(results, mode) {
  const seconds = (SCENARIO_DURATION_MS * results.length) / 1_000;
  const totals = results.reduce((combined, result) => ({
    nativeResults: combined.nativeResults + result.totals.nativeResults,
    presentationUpdates: combined.presentationUpdates + result.totals.presentationUpdates,
    interpolatedUpdates: combined.interpolatedUpdates + result.totals.interpolatedUpdates,
    changingEncodedFrames: combined.changingEncodedFrames + result.totals.changingEncodedFrames,
    motionCompensatedUpdates: combined.motionCompensatedUpdates + result.totals.motionCompensatedUpdates,
  }), {
    nativeResults: 0,
    presentationUpdates: 0,
    interpolatedUpdates: 0,
    changingEncodedFrames: 0,
    motionCompensatedUpdates: 0,
  });
  const ages = results.flatMap((result) => result.ages);
  const roundTrips = results.flatMap((result) => result.roundTrips);
  const motionResponseAges = results.flatMap((result) => result.motionResponseAges);
  return {
    scenario: "all",
    mode,
    duration_seconds: seconds,
    native_result_fps: rounded(totals.nativeResults / seconds),
    genuinely_changing_displayed_fps: rounded(totals.changingEncodedFrames / seconds),
    displayed_update_fps: rounded(totals.presentationUpdates / seconds),
    interpolated_fps: rounded(totals.interpolatedUpdates / seconds),
    motion_compensated_fps: rounded(totals.motionCompensatedUpdates / seconds),
    encoded_fps: ENCODED_FPS,
    median_end_to_end_output_age_ms: rounded(percentile(ages, 0.5)),
    p95_end_to_end_output_age_ms: rounded(percentile(ages, 0.95)),
    median_native_round_trip_ms: rounded(percentile(roundTrips, 0.5)),
    p95_native_round_trip_ms: rounded(percentile(roundTrips, 0.95)),
    median_motion_response_age_ms: rounded(percentile(motionResponseAges, 0.5)),
    p95_motion_response_age_ms: rounded(percentile(motionResponseAges, 0.95)),
    skipped_or_replaced_source_samples: results.reduce((sum, result) => sum + result.metrics.skipped_or_replaced_source_samples, 0),
    maximum_queue_depth: Math.max(...results.map((result) => result.metrics.maximum_queue_depth)),
    mean_encode_ms: rounded(results.reduce((sum, result) => sum + result.metrics.mean_encode_ms, 0) / results.length),
    main_thread_long_tasks: null,
    approximate_paid_cost_usd: 0,
    session_failures: 0,
  };
}

async function main() {
  const { mode, outputDir } = parseArguments(process.argv.slice(2));
  const absoluteOutput = path.resolve(outputDir);
  await mkdir(absoluteOutput, { recursive: true });
  const comparisonPath = path.join(absoluteOutput, `${mode}-comparison.mp4`);
  const sourcePath = path.join(absoluteOutput, "source-suite.mp4");
  const comparisonEncoder = startEncoder(comparisonPath, FRAME_WIDTH * 2, FRAME_HEIGHT);
  const sourceEncoder = startEncoder(sourcePath, FRAME_WIDTH, FRAME_HEIGHT);
  const results = SCENARIOS.map((scenario) => simulateScenario(scenario, mode));
  const sourceHash = createHash("sha256");

  for (const result of results) {
    for (const rendered of result.renderedFrames) {
      sourceHash.update(rendered.source);
      await writeFrame(sourceEncoder.encoder.stdin, rendered.source);
      await writeFrame(comparisonEncoder.encoder.stdin, joinFrames(rendered.source, rendered.output));
    }
  }
  sourceEncoder.encoder.stdin.end();
  comparisonEncoder.encoder.stdin.end();
  await Promise.all([sourceEncoder.completed, comparisonEncoder.completed]);

  const metrics = {
    schema_version: 1,
    benchmark: "surfaceshift-deterministic-preview",
    mode,
    simulated: true,
    source_sha256: sourceHash.digest("hex"),
    assumptions: {
      encoded_fps: ENCODED_FPS,
      sample_interval_ms: SAMPLE_INTERVAL_MS,
      native_round_trip_ms: NATIVE_ROUND_TRIP_MS,
      decode_ms: DECODE_MS,
      interpolation_delay_ms: INTERPOLATION_DELAY_MS,
      note: "The deterministic preview isolates scheduler and presentation behavior. It is not a paid FLUX quality or service-throughput measurement.",
    },
    overall: aggregate(results, mode),
    scenarios: results.map((result) => result.metrics),
  };
  const records = results.flatMap((result) => result.records);
  await writeFile(path.join(absoluteOutput, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  await writeFile(
    path.join(absoluteOutput, "frames.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
  await writeFile(path.join(absoluteOutput, "manifest.json"), `${JSON.stringify({
    benchmark: metrics.benchmark,
    mode,
    source_sha256: metrics.source_sha256,
    scenarios: SCENARIOS.map((name, index) => ({
      name,
      start_seconds: index * (SCENARIO_DURATION_MS / 1_000),
      end_seconds: (index + 1) * (SCENARIO_DURATION_MS / 1_000),
    })),
    artifacts: {
      source_video: sourcePath,
      comparison_video: comparisonPath,
      metrics: path.join(absoluteOutput, "metrics.json"),
      frame_timestamps: path.join(absoluteOutput, "frames.jsonl"),
    },
  }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

await main();
