import {
  CLOUD_CAPTURE_INTERVAL_MS,
  CLOUD_PENDING_LIMIT,
  CLOUD_PENDING_TTL_MS,
  CLOUD_STARTUP_TIMEOUT_MS,
  DEFAULT_CLOUD_SESSION_LIMIT_MS,
  FAL_CLIENT_URL,
  FAL_MODEL,
  FLUX_INPUT_SIZE,
  FLUX_JPEG_QUALITY,
  FLUX_OUTPUT_SIZE,
  availableRealRuntimes,
  buildFluxInput,
  buildRecordingOptions,
  chooseRuntime,
  estimateCloudSessionCost,
  normalizeCloudSessionLimit,
} from "./flux-config.js?v=0.4.0";
import { CloudFramePump } from "./cloud-frame-pump.js?v=0.3.4";
import { startDemoSource } from "./demo-source.js?v=0.3.4";
import { installFalSocketGuard } from "./fal-socket-guard.js?v=0.3.4";
import {
  SourceMotionTracker,
  downsampleLuma,
  drawTranslatedWithEdgeFill,
} from "./motion-compensation.js?v=0.5.0";
import {
  containRect,
  recordingIsReady,
  recordingPreset,
  shouldPublishPair,
  shouldStartArmedRecording,
} from "./recording-layout.js?v=0.4.0";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const studio = $("#studio");
const inputVideo = $("#inputVideo");
const inputEmpty = $("#inputEmpty");
const demoCanvas = $("#demoCanvas");
const outputFrame = $("#outputFrame");
const outputCanvas = $("#outputCanvas");
const outputContext = outputCanvas.getContext("2d");
const cloudOutputCanvas = document.createElement("canvas");
const cloudOutputContext = cloudOutputCanvas.getContext("2d");
const motionSampleCanvas = document.createElement("canvas");
motionSampleCanvas.width = 48;
motionSampleCanvas.height = 48;
const motionSampleContext = motionSampleCanvas.getContext("2d", { willReadFrequently: true });
const sourceMotionTracker = new SourceMotionTracker({ sampleWidth: 48, sampleHeight: 48 });
const outputEmpty = $("#outputEmpty");
const captureCanvas = $("#captureCanvas");
const captureContext = captureCanvas.getContext("2d");
const liveSourceCanvas = $("#liveSourceCanvas");
const liveSourceContext = liveSourceCanvas.getContext("2d");
const matchedSourceCanvas = $("#matchedSourceCanvas");
const matchedSourceContext = matchedSourceCanvas.getContext("2d");
const matchedOutputCanvas = $("#matchedOutputCanvas");
const matchedOutputContext = matchedOutputCanvas.getContext("2d");
const recordingCanvas = $("#recordingCanvas");
const recordingContext = recordingCanvas.getContext("2d");
const videoFile = $("#videoFile");
const sourceStatus = $("#sourceStatus");
const outputStatus = $("#outputStatus");
const sessionMessage = $("#sessionMessage");
const startButton = $("#startButton");
const recordButton = $("#recordButton");
const scrollButton = $("#scrollButton");
const showcaseButton = $("#showcaseButton");
const exitShowcaseButton = $("#exitShowcaseButton");
const stopSharingButton = $("#stopSharingButton");
const liveIndicator = $("#liveIndicator");
const performanceBadge = $("#performanceBadge");
const runtimeBadge = $("#runtimeBadge");
const runtimeControl = $("#runtimeControl");
const runtimeSelect = $("#runtimeSelect");
const accessControl = $("#accessControl");
const accessCode = $("#accessCode");
const strength = $("#strength");
const strengthValue = $("#strengthValue");
const recordingMode = $("#recordingMode");
const budgetControl = $("#budgetControl");
const sessionBudget = $("#sessionBudget");

const STYLE_PROMPTS = {
  clay: "Material-only edit of this exact input frame in handmade polymer clay. Faithfully reconstruct the same frame; do not redesign it. Preserve camera view, crop, layout, tile positions and sizes, image subjects, people, poses, objects, colors, browser chrome, icons, text shapes, and scroll position. Every tile must show the same subject as the input. Never add, remove, replace, combine, or reinterpret content. Change only surfaces to matte clay with subtle fingerprints, shallow relief, imperfect edges, and soft contact shadows. No roads, markers, extra windows, devices, borders, or new objects.",
  felt: "Restyle this exact frame as one coherent layered hand-cut felt interface. Preserve the composition, controls, map structure, cards, large text placement, and scroll position. Use visible wool fibers, embroidered edges, stacked textile shapes, warm craft-table lighting, and soft dimensional shadows. Do not add another window or device.",
  ink: "Restyle this exact frame as an expressive India-ink interface on warm paper. Preserve the composition, controls, map structure, cards, large text placement, and scroll position. Use bold brush edges, restrained watercolor bleed, crisp editorial shapes, and subtle paper texture. Do not add another window or device.",
  dream: "Restyle this exact frame as one coherent surreal miniature interface. Preserve the composition, controls, map structure, cards, large text placement, and scroll position. Use pearlescent glass, soft luminous gradients, playful sculptural forms, and cinematic glow. Do not add another window or device.",
};

const PREVIEW_FILTERS = {
  clay: "saturate(1.28) contrast(1.05) sepia(.12)",
  felt: "saturate(.88) contrast(1.12) sepia(.18)",
  ink: "grayscale(.78) contrast(1.5) sepia(.22)",
  dream: "saturate(1.65) contrast(.94) hue-rotate(12deg)",
};

const state = {
  health: {},
  mode: "preview",
  running: false,
  generation: 0,
  generatedFrames: 0,
  firstOutput: false,
  inFlight: false,
  abortController: null,
  cloudConnection: null,
  cloudAccessCode: "",
  cloudPump: null,
  latestOutputBatch: null,
  outputBusy: false,
  outputTimer: null,
  activeOutput: null,
  previewAnimation: null,
  sessionTimer: null,
  startupTimer: null,
  recording: null,
  recordingArmed: null,
  matchedPairReady: false,
  matchedPair: null,
  displayFrame: null,
  cloudBaseFrame: null,
  lastMotionSignature: "0:0",
  captureController: null,
  forwardingWheel: false,
  demoStop: null,
  stats: null,
  sessionLimitMs: DEFAULT_CLOUD_SESSION_LIMIT_MS,
};

let sourceStream = null;
let sourceKind = null;
let sourceObjectUrl = null;
let selectedStyle = "clay";
let sessionId = null;
let falSocketGuard = null;

async function boot() {
  state.health = await loadHealth();
  populateRuntimeSelector();
  applyRuntime(state.health.default_runtime || chooseRuntime(state.health));
}

async function loadHealth() {
  try {
    const response = await fetch("api/health", { cache: "no-store" });
    if (response.ok) return await response.json();
  } catch {
    // The hard-coded fallback below is intentionally non-AI.
  }
  return { runtimes: { preview: { available: true } }, default_runtime: "preview" };
}

function populateRuntimeSelector() {
  const runtimes = availableRealRuntimes(state.health);
  runtimeSelect.replaceChildren();
  for (const mode of runtimes) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = mode === "cloud" ? "FLUX.2 Cloud" : "Local Mac";
    runtimeSelect.append(option);
  }
  runtimeControl.hidden = runtimes.length < 2;
}

function applyRuntime(mode, { announce = true } = {}) {
  const available = state.health.runtimes?.[mode]?.available;
  state.mode = available || mode === "preview" ? mode : chooseRuntime(state.health);
  studio.dataset.runtime = state.mode;
  runtimeSelect.value = state.mode;
  runtimeBadge.classList.remove("is-cloud", "is-local");
  accessControl.hidden = state.mode !== "cloud";
  budgetControl.hidden = state.mode !== "cloud";

  if (state.mode === "cloud") {
    captureCanvas.width = FLUX_INPUT_SIZE;
    captureCanvas.height = FLUX_INPUT_SIZE;
    outputCanvas.width = FLUX_OUTPUT_SIZE;
    outputCanvas.height = FLUX_OUTPUT_SIZE;
    cloudOutputCanvas.width = FLUX_OUTPUT_SIZE;
    cloudOutputCanvas.height = FLUX_OUTPUT_SIZE;
    resetMatchedPair(
      captureCanvas.width,
      captureCanvas.height,
      outputCanvas.width,
      outputCanvas.height,
    );
    runtimeBadge.textContent = "FLUX.2 · CLOUD READY";
    runtimeBadge.classList.add("is-cloud");
    if (announce) setMessage("FLUX.2 is ready. Choose Demo or a browser tab, then enter your local access code.");
    return;
  }

  captureCanvas.width = 512;
  captureCanvas.height = 288;
  outputCanvas.width = 832;
  outputCanvas.height = 480;
  cloudOutputCanvas.width = outputCanvas.width;
  cloudOutputCanvas.height = outputCanvas.height;
  resetMatchedPair(
    captureCanvas.width,
    captureCanvas.height,
    outputCanvas.width,
    outputCanvas.height,
  );
  performanceBadge.hidden = true;

  if (state.mode === "local") {
    const local = state.health.runtimes?.local || {};
    runtimeBadge.textContent = "MAC · MPS READY";
    runtimeBadge.classList.add("is-local");
    if (announce) {
      setMessage(local.model_loaded
        ? "Local diffusion is ready. Pick a source to begin."
        : "Local Mac mode is ready. The first frame downloads and warms the model.");
    }
    return;
  }

  runtimeBadge.textContent = "INTERFACE PREVIEW";
  if (announce) setMessage("No AI runtime is configured. Add your own fal key locally for live FLUX.2.");
}

function setMessage(message, tone = "normal") {
  sessionMessage.textContent = message;
  sessionMessage.dataset.tone = tone;
}

function getSourceMedia() {
  return sourceKind === "demo" ? demoCanvas : inputVideo;
}

function sourceIsReady() {
  if (sourceKind === "demo") return Boolean(demoCanvas.width && demoCanvas.height);
  return Boolean(inputVideo.videoWidth && inputVideo.readyState >= 2);
}

function setSourceSelected(kind) {
  sourceKind = kind;
  studio.dataset.source = kind;
  $$(".source-button").forEach((button) => {
    const active = button.dataset.source === kind;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const labels = {
    demo: "animated demo ready",
    screen: "screen selected",
    camera: "camera selected",
    video: "video loaded",
  };
  sourceStatus.textContent = labels[kind] || `${kind} selected`;
  inputEmpty.hidden = true;
  inputVideo.hidden = kind === "demo";
  demoCanvas.hidden = kind !== "demo";
  stopSharingButton.hidden = ["demo", "video"].includes(kind);
  setMessage(state.mode === "cloud"
    ? "Source ready. Start FLUX.2; capture will keep sampling while the source moves."
    : "Source ready. Choose a material and start transforming.");
}

function stopWheelForwarding() {
  if (state.forwardingWheel && state.captureController?.forwardWheel) {
    void state.captureController.forwardWheel(null).catch(() => {});
  }
  state.forwardingWheel = false;
  studio.classList.remove("is-scroll-forwarding");
  scrollButton.setAttribute("aria-pressed", "false");
  scrollButton.textContent = "Scroll captured tab";
  scrollButton.hidden = true;
}

function stopSourceTracks() {
  stopWheelForwarding();
  state.captureController = null;
  state.demoStop?.();
  state.demoStop = null;
  if (sourceStream) sourceStream.getTracks().forEach((track) => track.stop());
  sourceStream = null;
  inputVideo.pause();
  inputVideo.srcObject = null;
  if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  sourceObjectUrl = null;
  inputVideo.removeAttribute("src");
  inputVideo.load();
  demoCanvas.hidden = true;
}

function chooseDemo() {
  if (state.running) stopTransform();
  stopSourceTracks();
  state.demoStop = startDemoSource(demoCanvas);
  setSourceSelected("demo");
  setMessage("Animated map and gallery ready. This source is designed to make motion easy to judge.");
}

async function chooseScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing is unavailable in this browser.");
  if (state.running) stopTransform();
  stopSourceTracks();

  const targetRate = state.mode === "cloud" ? 30 : 16;
  const controller = typeof window.CaptureController === "function"
    ? new window.CaptureController()
    : null;
  const options = {
    video: { frameRate: { ideal: targetRate, max: targetRate } },
    audio: false,
    selfBrowserSurface: "exclude",
    preferCurrentTab: false,
    surfaceSwitching: "include",
    monitorTypeSurfaces: "exclude",
  };
  if (controller) options.controller = controller;

  sourceStream = await navigator.mediaDevices.getDisplayMedia(options);
  inputVideo.srcObject = sourceStream;
  await inputVideo.play();
  const track = sourceStream.getVideoTracks()[0];
  try {
    track.contentHint = "motion";
  } catch {
    // contentHint is an optimization hint and is not supported everywhere.
  }
  track.addEventListener("ended", () => {
    if (sourceStream?.getVideoTracks().includes(track)) stopAll();
  });
  state.captureController = controller;
  setSourceSelected("screen");

  const displaySurface = track.getSettings?.().displaySurface || "unknown";
  const canForwardWheel = displaySurface === "browser" && Boolean(controller?.forwardWheel);
  scrollButton.hidden = !canForwardWheel;
  if (canForwardWheel) {
    setMessage("Browser tab selected. Click “Scroll captured tab,” then scroll directly over the generated output.");
  } else if (displaySurface !== "browser") {
    setMessage("For a clean responsive demo, share one browser tab—not the whole monitor—and keep both windows visible.", "error");
  }
}

async function chooseCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access is unavailable in this browser.");
  if (state.running) stopTransform();
  stopSourceTracks();
  sourceStream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: state.mode === "cloud" ? 30 : 16 },
    },
    audio: false,
  });
  inputVideo.srcObject = sourceStream;
  await inputVideo.play();
  const track = sourceStream.getVideoTracks()[0];
  track.addEventListener("ended", () => {
    if (sourceStream?.getVideoTracks().includes(track)) stopAll();
  });
  setSourceSelected("camera");
}

function chooseVideo() {
  videoFile.value = "";
  videoFile.click();
}

async function loadVideoFile(file) {
  if (!file) return;
  if (state.running) stopTransform();
  stopSourceTracks();
  sourceObjectUrl = URL.createObjectURL(file);
  inputVideo.src = sourceObjectUrl;
  inputVideo.loop = true;
  await inputVideo.play();
  setSourceSelected("video");
}

function mediaDimensions(media, fallbackWidth, fallbackHeight) {
  return {
    width: media.videoWidth || media.naturalWidth || media.width || fallbackWidth,
    height: media.videoHeight || media.naturalHeight || media.height || fallbackHeight,
  };
}

function drawCover(context, media, width, height) {
  const mediaSize = mediaDimensions(media, width, height);
  const scale = Math.max(width / mediaSize.width, height / mediaSize.height);
  const drawWidth = mediaSize.width * scale;
  const drawHeight = mediaSize.height * scale;
  context.drawImage(media, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawFramedScreen(context, media, width, height) {
  const mediaSize = mediaDimensions(media, width, height);
  const margin = width * 0.055;
  const scale = Math.min((width - margin * 2) / mediaSize.width, (height - margin * 2) / mediaSize.height);
  const drawWidth = mediaSize.width * scale;
  const drawHeight = mediaSize.height * scale;
  const x = (width - drawWidth) / 2;
  const y = (height - drawHeight) / 2;
  const radius = Math.max(14, width * 0.026);

  context.fillStyle = "#d6c2b2";
  context.fillRect(0, 0, width, height);
  context.save();
  context.shadowColor = "rgba(58,35,21,.25)";
  context.shadowBlur = width * 0.035;
  context.shadowOffsetY = width * 0.018;
  context.fillStyle = "#f7eee3";
  context.beginPath();
  context.roundRect(x, y, drawWidth, drawHeight, radius);
  context.fill();
  context.restore();
  context.save();
  context.beginPath();
  context.roundRect(x, y, drawWidth, drawHeight, radius);
  context.clip();
  context.drawImage(media, x, y, drawWidth, drawHeight);
  context.restore();
}

function drawSourceFrame(context, canvas) {
  const media = getSourceMedia();
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (sourceKind === "screen" && state.mode === "cloud") {
    drawFramedScreen(context, media, canvas.width, canvas.height);
  } else {
    drawCover(context, media, canvas.width, canvas.height);
  }
}

function drawSourceToCapture() {
  drawSourceFrame(captureContext, captureCanvas);
}

function drawSourceToLiveRecording() {
  if (
    liveSourceCanvas.width !== captureCanvas.width
    || liveSourceCanvas.height !== captureCanvas.height
  ) {
    liveSourceCanvas.width = captureCanvas.width;
    liveSourceCanvas.height = captureCanvas.height;
  }
  drawSourceFrame(liveSourceContext, liveSourceCanvas);
}

function resetMatchedPair(
  sourceWidth = captureCanvas.width,
  sourceHeight = captureCanvas.height,
  outputWidth = outputCanvas.width,
  outputHeight = outputCanvas.height,
) {
  matchedSourceCanvas.width = sourceWidth;
  matchedSourceCanvas.height = sourceHeight;
  matchedOutputCanvas.width = outputWidth;
  matchedOutputCanvas.height = outputHeight;
  matchedSourceContext.clearRect(0, 0, sourceWidth, sourceHeight);
  matchedOutputContext.clearRect(0, 0, outputWidth, outputHeight);
  state.matchedPairReady = false;
  state.matchedPair = null;
}

function publishMatchedPair(source, output, pair = {}) {
  if (!shouldPublishPair(state.matchedPair?.capturedAt, pair.capturedAt)) return;
  matchedSourceContext.clearRect(0, 0, matchedSourceCanvas.width, matchedSourceCanvas.height);
  matchedOutputContext.clearRect(0, 0, matchedOutputCanvas.width, matchedOutputCanvas.height);
  matchedSourceContext.drawImage(source, 0, 0, matchedSourceCanvas.width, matchedSourceCanvas.height);
  matchedOutputContext.drawImage(output, 0, 0, matchedOutputCanvas.width, matchedOutputCanvas.height);
  state.matchedPairReady = true;
  state.matchedPair = pair;

  const armedMode = state.recordingArmed;
  if (shouldStartArmedRecording(armedMode, "matched-pair") && !state.recording) {
    state.recordingArmed = null;
    beginRecording(recordingPreset(armedMode).mode);
  }
}

function renderPreview() {
  if (!state.running || state.mode !== "preview") return;
  drawSourceToCapture();
  const capturedAt = performance.now();
  outputContext.save();
  outputContext.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
  outputContext.filter = PREVIEW_FILTERS[selectedStyle];
  drawCover(outputContext, captureCanvas, outputCanvas.width, outputCanvas.height);
  outputContext.filter = "none";
  outputContext.globalCompositeOperation = "soft-light";
  const alpha = Number(strength.value) / 500;
  const colors = { clay: "#f28a5b", felt: "#d9b68c", ink: "#1d2b32", dream: "#a586ff" };
  outputContext.fillStyle = `${colors[selectedStyle]}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`;
  outputContext.fillRect(0, 0, outputCanvas.width, outputCanvas.height);
  outputContext.restore();
  state.displayFrame = { capturedAt, latencyMs: 0, displayedAt: performance.now() };
  publishMatchedPair(captureCanvas, outputCanvas, {
    capturedAt,
    latencyMs: 0,
    style: selectedStyle,
  });
  state.previewAnimation = requestAnimationFrame(renderPreview);
}

async function readableError(response) {
  try {
    const payload = await response.json();
    return payload.detail || payload.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function requestFalToken(app, code, generation) {
  if (app !== FAL_MODEL) throw new Error("Unexpected fal endpoint");
  try {
    const response = await fetch("api/fal/realtime-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app, accessCode: code }),
    });
    if (!response.ok) throw new Error(await readableError(response));
    const payload = await response.json();
    if (!payload.token || typeof payload.token !== "string") throw new Error("The token endpoint returned an invalid response");
    if (generation === state.generation) accessCode.value = "";
    return payload.token;
  } catch (error) {
    if (generation === state.generation) handleCloudError(error, generation);
    throw error;
  }
}

function freshStats(startedAt = performance.now()) {
  return {
    startedAt,
    nativeResults: 0,
    displayedFrames: 0,
    motionCompensatedFrames: 0,
    lastNativeAt: 0,
    nativeIntervalEwma: 320,
    latencies: [],
    displayedAges: [],
    motionResponseAges: [],
  };
}

function motionDeltaPixels(anchor) {
  const delta = sourceMotionTracker.deltaFrom(anchor);
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
    motionCapturedAt: sourceMotionTracker.lastCapturedAt,
    translationX: delta.x,
    translationY: delta.y,
  };
  if (motionOnly) {
    state.stats.motionCompensatedFrames += 1;
    state.stats.displayedAges.push(Math.max(0, displayedAt - base.displayFrame.capturedAt));
    state.stats.motionResponseAges.push(
      Math.max(0, displayedAt - (sourceMotionTracker.lastCapturedAt || displayedAt)),
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
      sampleWidth: sourceMotionTracker.sampleWidth,
      sampleHeight: sourceMotionTracker.sampleHeight,
      insetFraction: 0,
    },
  );
  const observation = sourceMotionTracker.observe(sample.luma, capturedAt);
  if (observation.estimate.accepted && isCurrentRun(generation)) {
    presentCloudBase({ motionOnly: true });
  }
  return { x: observation.x, y: observation.y, capturedAt };
}

async function startCloudSession(generation) {
  state.cloudAccessCode = accessCode.value.trim();
  if (!state.cloudAccessCode) throw new Error("Enter your local access code before starting FLUX.2.");

  const sessionLimitMs = normalizeCloudSessionLimit(sessionBudget.value);
  const sessionSeconds = sessionLimitMs / 1_000;
  const estimatedCost = estimateCloudSessionCost(sessionLimitMs).toFixed(2);
  state.sessionLimitMs = sessionLimitMs;
  sessionBudget.disabled = true;
  const startedAt = performance.now();
  const deadlineAt = startedAt + sessionLimitMs;
  state.stats = freshStats(startedAt);
  performanceBadge.hidden = false;
  performanceBadge.textContent = "warming FLUX.2";
  outputStatus.textContent = "connecting to FLUX.2";
  setMessage(`Authorizing up to ${sessionSeconds} seconds of FLUX.2 (about $${estimatedCost} at the listed rate).`);
  falSocketGuard ||= installFalSocketGuard(window);
  const { fal } = await import(FAL_CLIENT_URL);
  if (!isCurrentRun(generation)) return;

  const provideToken = (app) => {
    const oneTimeCode = state.cloudAccessCode;
    state.cloudAccessCode = "";
    return requestFalToken(app, oneTimeCode, generation);
  };

  state.cloudConnection = fal.realtime.connect(FAL_MODEL, {
    connectionKey: `surfaceshift-${generation}-${crypto.randomUUID()}`,
    tokenProvider: provideToken,
    throttleInterval: 0,
    maxBuffering: 1,
    onResult: (result) => handleCloudResult(result, generation),
    onError: (error) => handleCloudError(error, generation),
  });

  state.cloudPump = new CloudFramePump({
    intervalMs: CLOUD_CAPTURE_INTERVAL_MS,
    pendingLimit: CLOUD_PENDING_LIMIT,
    pendingTtlMs: CLOUD_PENDING_TTL_MS,
    capture: async () => {
      if (!isCurrentRun(generation) || !sourceIsReady()) return null;
      const style = selectedStyle;
      drawSourceToCapture();
      const motionCapturedAt = performance.now();
      const motionSnapshot = observeCloudMotion(generation, motionCapturedAt);
      return {
        sourceDataUrl: captureCanvas.toDataURL("image/jpeg", FLUX_JPEG_QUALITY),
        style,
        prompt: STYLE_PROMPTS[style],
        motionSnapshot,
      };
    },
    send: ({ requestId, sourceDataUrl, prompt }) => {
      state.cloudConnection.send(buildFluxInput({
        imageUrl: sourceDataUrl,
        prompt,
        requestId,
      }));
    },
    onDeadline: () => {
      if (isCurrentRun(generation)) stopTransform(`The ${sessionSeconds}-second cloud session ended at its selected limit.`);
    },
    onError: (error) => handleCloudError(error, generation),
  });

  state.startupTimer = setTimeout(() => {
    if (isCurrentRun(generation) && !state.firstOutput) {
      handleCloudError(new Error("FLUX.2 did not return a frame in time."), generation);
    }
  }, CLOUD_STARTUP_TIMEOUT_MS);
  state.sessionTimer = setTimeout(() => {
    if (isCurrentRun(generation)) stopTransform(`The ${sessionSeconds}-second cloud session ended at its selected limit.`);
  }, sessionLimitMs);
  state.cloudPump.start({ generation, deadlineAt });
}

function handleCloudResult(result, generation) {
  if (!isCurrentRun(generation)) return;
  if (!Array.isArray(result?.images) || !result.images.length) {
    handleCloudError(new Error("FLUX.2 returned an empty frame."), generation);
    return;
  }

  const pending = state.cloudPump?.resolve(result);
  if (!pending) return;
  const stats = state.stats;
  if (stats.lastNativeAt) {
    const interval = pending.receivedAt - stats.lastNativeAt;
    stats.nativeIntervalEwma = stats.nativeIntervalEwma * 0.72 + interval * 0.28;
  }
  stats.lastNativeAt = pending.receivedAt;
  stats.nativeResults += 1;
  stats.latencies.push(pending.latencyMs);
  if (stats.latencies.length > 120) stats.latencies.shift();

  state.latestOutputBatch = {
    ...pending,
    images: result.images.slice(-2),
    generation,
  };
  updatePerformanceBadge();
  drainOutputBatch();
}

function handleCloudError(error, generation) {
  if (!isCurrentRun(generation)) return;
  const rawMessage = error?.message || "The FLUX.2 connection failed.";
  const message = rawMessage === "Unknown error"
    ? "FLUX.2 connection failed. Check the access code and try again."
    : rawMessage;
  stopTransform(message, "error");
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
      Promise.all(batch.images.map((image) => rawImageBitmap(image))),
      dataUrlBitmap(batch.sourceDataUrl),
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
    state.outputTimer = setTimeout(() => {
      state.outputTimer = null;
      if (isCurrentRun(batch.generation)) {
        paintCloudBitmap(bitmaps.at(-1), source, batch, { publishPair: true });
      }
      finishOutputBatch(batch.generation);
    }, delay);
  } catch (error) {
    finishOutputBatch(batch.generation);
    handleCloudError(error, batch.generation);
  }
}

function paintCloudBitmap(generated, source, batch, { publishPair = false } = {}) {
  const effect = Number(strength.value) / 100;
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
    motionAnchor: batch.motionSnapshot || sourceMotionTracker.snapshot(),
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

async function rawImageBitmap(image) {
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
  return dataUrlBitmap(dataUrl);
}

async function dataUrlBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  return createImageBitmap(await response.blob());
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * fraction))];
}

function updatePerformanceBadge() {
  if (!state.stats || state.mode !== "cloud") return;
  const elapsed = Math.max(0.1, (performance.now() - state.stats.startedAt) / 1000);
  const sampleFps = (state.cloudPump?.capturedCount || 0) / elapsed;
  const nativeFps = state.stats.nativeResults / elapsed;
  const modelViewFps = state.stats.displayedFrames / elapsed;
  const motionFps = state.stats.motionCompensatedFrames / elapsed;
  const p95 = percentile(state.stats.displayedAges, 0.95) || percentile(state.stats.latencies, 0.95);
  performanceBadge.textContent = `${sampleFps.toFixed(1)} sample · ${nativeFps.toFixed(1)} native · ${modelViewFps.toFixed(1)} model · ${motionFps.toFixed(1)} warp · ${Math.round(p95)}ms`;
  performanceBadge.title = "sampled fps · native FLUX.2 fps · native/interpolated presentation fps · motion-compensated presentation fps · p95 native-anchor age";
}

async function configureLocalSession() {
  if (!sessionId) sessionId = crypto.randomUUID();
  const response = await fetch("api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      prompt: STYLE_PROMPTS[selectedStyle],
      strength: Number(strength.value) / 100,
    }),
  });
  if (!response.ok) throw new Error("Could not configure the local session.");
}

async function sendMacFrame(generation) {
  if (!isCurrentRun(generation) || state.inFlight || !sourceIsReady()) return;
  state.inFlight = true;
  const style = selectedStyle;
  drawSourceToCapture();
  const capturedAt = performance.now();
  const blob = await new Promise((resolve) => captureCanvas.toBlob(resolve, "image/jpeg", 0.8));
  if (!isCurrentRun(generation)) return;
  const controller = new AbortController();
  state.abortController = controller;

  try {
    const response = await fetch("api/transform", {
      method: "POST",
      headers: { "X-Session-ID": sessionId },
      body: blob,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await readableError(response));
    const inferenceMs = Number(response.headers.get("X-Inference-Ms"));
    const [bitmap, sourceBitmap] = await Promise.all([
      createImageBitmap(await response.blob()),
      createImageBitmap(blob),
    ]);
    if (!isCurrentRun(generation)) {
      bitmap.close();
      sourceBitmap.close();
      return;
    }
    outputContext.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
    outputContext.drawImage(bitmap, 0, 0, outputCanvas.width, outputCanvas.height);
    state.displayFrame = {
      capturedAt,
      latencyMs: Number.isFinite(inferenceMs) ? inferenceMs : performance.now() - capturedAt,
      displayedAt: performance.now(),
    };
    publishMatchedPair(sourceBitmap, outputCanvas, {
      capturedAt,
      latencyMs: Number.isFinite(inferenceMs) ? inferenceMs : performance.now() - capturedAt,
      style,
    });
    bitmap.close();
    sourceBitmap.close();
    markGeneratedFrame(Number.isFinite(inferenceMs) ? `Mac · ${Math.round(inferenceMs)}ms` : "Mac · MPS");
  } catch (error) {
    if (error?.name !== "AbortError" && isCurrentRun(generation)) {
      stopTransform(error.message || "Local inference failed.", "error");
      return;
    }
  } finally {
    if (generation === state.generation) state.inFlight = false;
    if (state.abortController === controller) state.abortController = null;
  }
  if (isCurrentRun(generation)) requestAnimationFrame(() => sendMacFrame(generation));
}

async function startLocalSession(generation) {
  await configureLocalSession();
  outputStatus.textContent = state.health.runtimes?.local?.model_loaded ? "starting MPS" : "loading SD-Turbo";
  setMessage("Starting local AI. The first run may need to download model weights.");
  requestAnimationFrame(() => sendMacFrame(generation));
}

function markGeneratedFrame(label) {
  state.generatedFrames += 1;
  outputStatus.textContent = `${label} · ${state.generatedFrames} shown`;
  if (!state.firstOutput) {
    const armedMode = state.recordingArmed;
    state.firstOutput = true;
    clearTimeout(state.startupTimer);
    state.startupTimer = null;
    recordButton.disabled = false;
    showcaseButton.disabled = false;
    setMessage(state.mode === "cloud"
      ? "FLUX.2 is live. Global source motion is applied between results as separately counted warp frames; stale frames are discarded."
      : "The transformation is live. Only the newest source frame is processed.");
    if (shouldStartArmedRecording(armedMode, "display-frame")) {
      state.recordingArmed = null;
      beginRecording(armedMode);
    }
  }
}

async function waitForSource() {
  if (sourceIsReady()) return;
  await new Promise((resolve) => inputVideo.addEventListener("loadeddata", resolve, { once: true }));
}

async function startTransform() {
  if (state.running) {
    stopTransform();
    return;
  }
  if (state.recording?.stopping) {
    setMessage("Finish saving the current recording before starting another session.");
    return;
  }

  try {
    if (!sourceKind) chooseDemo();
    await waitForSource();
    if (state.mode === "cloud" && !accessCode.value.trim()) {
      accessCode.focus();
      throw new Error("Enter your local access code before starting FLUX.2.");
    }

    const generation = ++state.generation;
    state.running = true;
    state.generatedFrames = 0;
    state.firstOutput = false;
    state.inFlight = false;
    state.recordingArmed = null;
    state.displayFrame = null;
    state.cloudBaseFrame = null;
    state.lastMotionSignature = "0:0";
    sourceMotionTracker.reset();
    recordingMode.disabled = false;
    sessionBudget.disabled = false;
    resetMatchedPair();
    state.latestOutputBatch = null;
    state.outputBusy = false;
    studio.setAttribute("aria-busy", "true");
    startButton.querySelector("span").textContent = "Stop transforming";
    startButton.classList.add("is-running");
    outputEmpty.hidden = true;
    liveIndicator.hidden = false;
    recordButton.disabled = false;
    recordButton.textContent = "Record";
    recordButton.setAttribute("aria-pressed", "false");
    showcaseButton.disabled = true;
    outputStatus.textContent = "starting";

    if (state.mode === "cloud") await startCloudSession(generation);
    else if (state.mode === "local") await startLocalSession(generation);
    else {
      outputStatus.textContent = "interface preview · not AI";
      setMessage("Interface preview is running without AI. Clone the repo and add your own fal key for generated frames.");
      state.firstOutput = true;
      recordButton.disabled = false;
      showcaseButton.disabled = false;
      renderPreview();
    }
  } catch (error) {
    if (state.running) stopTransform(error.message || "The session could not start.", "error");
    else setMessage(error.message || "The session could not start.", "error");
  }
}

function isCurrentRun(generation) {
  return state.running && generation === state.generation;
}

function stopTransform(message = "Transformation stopped.", tone = "normal", { saveRecording = true } = {}) {
  state.running = false;
  state.generation += 1;
  state.inFlight = false;
  state.cloudAccessCode = "";
  state.recordingArmed = null;
  recordingMode.disabled = false;
  sessionBudget.disabled = false;
  state.cloudPump?.stop();
  state.cloudPump = null;
  state.cloudBaseFrame = null;
  state.lastMotionSignature = "0:0";
  sourceMotionTracker.reset();
  state.latestOutputBatch = null;
  state.outputBusy = false;
  state.abortController?.abort();
  state.abortController = null;
  state.cloudConnection?.close();
  state.cloudConnection = null;
  falSocketGuard?.closeAll();
  if (state.previewAnimation) cancelAnimationFrame(state.previewAnimation);
  state.previewAnimation = null;
  clearTimeout(state.outputTimer);
  clearTimeout(state.sessionTimer);
  clearTimeout(state.startupTimer);
  state.outputTimer = null;
  state.sessionTimer = null;
  state.startupTimer = null;
  closeActiveOutput();
  stopRecording(saveRecording, { terminalMessage: { message, tone } });
  studio.setAttribute("aria-busy", "false");
  liveIndicator.hidden = true;
  recordButton.disabled = true;
  recordButton.textContent = "Record";
  recordButton.setAttribute("aria-pressed", "false");
  showcaseButton.disabled = !state.firstOutput;
  startButton.classList.remove("is-running");
  startButton.querySelector("span").textContent = "Start transforming";
  outputStatus.textContent = "stopped";
  setMessage(message, tone);
}

function stopAll({ saveRecording = true } = {}) {
  if (state.running) stopTransform("Sharing stopped. Pick a source to begin again.", "normal", { saveRecording });
  else stopRecording(saveRecording);
  stopSourceTracks();
  sourceKind = null;
  sessionId = null;
  delete studio.dataset.source;
  inputVideo.hidden = true;
  inputEmpty.hidden = false;
  stopSharingButton.hidden = true;
  sourceStatus.textContent = "nothing selected";
  $$(".source-button").forEach((button) => {
    button.classList.remove("is-active");
    button.setAttribute("aria-pressed", "false");
  });
  setMessage("Sharing stopped. Pick a source to begin again.");
}

async function toggleWheelForwarding() {
  const controller = state.captureController;
  if (!controller?.forwardWheel) return;
  try {
    const enable = !state.forwardingWheel;
    await controller.forwardWheel(enable ? outputFrame : null);
    state.forwardingWheel = enable;
    studio.classList.toggle("is-scroll-forwarding", enable);
    scrollButton.setAttribute("aria-pressed", String(enable));
    scrollButton.textContent = enable ? "Stop scroll control" : "Scroll captured tab";
    setMessage(enable
      ? "Scroll over the generated output now; Chrome forwards the movement to the captured browser tab."
      : "Scroll forwarding stopped. The browser tab is still being captured.");
  } catch (error) {
    setMessage(error.message || "Chrome could not enable captured-tab scrolling.", "error");
  }
}

async function setShowcase(enabled) {
  if (enabled && outputFrame.requestFullscreen && document.fullscreenElement !== outputFrame) {
    try {
      await outputFrame.requestFullscreen({ navigationUI: "hide" });
    } catch {
      // The CSS presentation mode remains available when native fullscreen is blocked.
    }
  } else if (!enabled && document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
  studio.classList.toggle("is-showcase", enabled);
  document.body.classList.toggle("has-showcase", enabled);
  showcaseButton.setAttribute("aria-pressed", String(enabled));
  showcaseButton.textContent = enabled ? "Exit fullscreen" : "Fullscreen output";
  exitShowcaseButton.hidden = !enabled;
}

function supportedRecordingType() {
  const candidates = ["video/mp4;codecs=h264", "video/webm;codecs=vp9", "video/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function fillRecordingBackground(width, height) {
  const gradient = recordingContext.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#e5d5c8");
  gradient.addColorStop(0.55, "#d7c3b4");
  gradient.addColorStop(1, "#c7ae9d");
  recordingContext.fillStyle = gradient;
  recordingContext.fillRect(0, 0, width, height);
}

function drawContainedRecordingMedia(media, x, y, width, height) {
  const mediaSize = mediaDimensions(media, width, height);
  const rect = containRect(mediaSize.width, mediaSize.height, x, y, width, height);
  recordingContext.drawImage(
    media,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
  );
}

function drawCompareCard(media, x, y, size, label) {
  recordingContext.save();
  recordingContext.shadowColor = "rgba(54,34,21,.25)";
  recordingContext.shadowBlur = 30;
  recordingContext.shadowOffsetY = 18;
  recordingContext.fillStyle = "#f7eee4";
  recordingContext.beginPath();
  recordingContext.roundRect(x, y, size, size, 34);
  recordingContext.fill();
  recordingContext.restore();

  recordingContext.save();
  recordingContext.beginPath();
  recordingContext.roundRect(x, y, size, size, 34);
  recordingContext.clip();
  recordingContext.fillStyle = "#d8c6b8";
  recordingContext.fillRect(x, y, size, size);
  drawContainedRecordingMedia(media, x + 14, y + 14, size - 28, size - 28);
  recordingContext.restore();

  recordingContext.fillStyle = "rgba(20,20,18,.76)";
  recordingContext.beginPath();
  recordingContext.roundRect(x + 24, y + 24, 244, 44, 22);
  recordingContext.fill();
  recordingContext.fillStyle = "#fffaf3";
  recordingContext.font = "600 15px 'DM Mono', monospace";
  recordingContext.textAlign = "left";
  recordingContext.textBaseline = "middle";
  recordingContext.fillText(label, x + 45, y + 46);
}

function drawRecordingHeader(title, badge) {
  const width = recordingCanvas.width;
  recordingContext.fillStyle = "rgba(20,20,18,.84)";
  recordingContext.font = "700 25px 'DM Mono', monospace";
  recordingContext.textAlign = "left";
  recordingContext.textBaseline = "middle";
  recordingContext.fillText(title, 64, 62);

  const badgeWidth = 218;
  const badgeX = width - 64 - badgeWidth;
  recordingContext.fillStyle = "rgba(20,20,18,.68)";
  recordingContext.beginPath();
  recordingContext.roundRect(badgeX, 40, badgeWidth, 44, 22);
  recordingContext.fill();
  recordingContext.fillStyle = "#fffaf3";
  recordingContext.font = "600 15px 'DM Mono', monospace";
  recordingContext.fillText(badge, badgeX + 24, 62);
}

function drawLiveCompareRecordingFrame() {
  const width = recordingCanvas.width;
  const height = recordingCanvas.height;
  fillRecordingBackground(width, height);
  const motionCompensated = Boolean(state.displayFrame?.motionCompensated);
  drawRecordingHeader(
    "SURFACESHIFT / LIVE COMPARE",
    motionCompensated ? "●  MODEL + WARP" : "●  MODEL VIEW",
  );

  const margin = 64;
  const gap = 40;
  const size = (width - margin * 2 - gap) / 2;
  const y = 116;
  let liveSource = captureCanvas;
  if (sourceIsReady()) {
    drawSourceToLiveRecording();
    liveSource = liveSourceCanvas;
  }
  drawCompareCard(liveSource, margin, y, size, "SOURCE · LIVE");
  drawCompareCard(
    outputCanvas,
    margin + size + gap,
    y,
    size,
    motionCompensated ? "OUTPUT · MOTION-COMPENSATED" : "OUTPUT · MODEL VIEW",
  );

  const capturedAt = Number(state.displayFrame?.capturedAt);
  const outputAge = Number.isFinite(capturedAt) ? Math.max(0, performance.now() - capturedAt) : NaN;
  const presentationLabel = motionCompensated ? "MOTION-COMPENSATED VIEW" : "DISPLAYED MODEL VIEW";
  const liveLabel = Number.isFinite(outputAge)
    ? `LIVE SOURCE / ${presentationLabel} · ~${Math.round(outputAge)}MS NATIVE-ANCHOR AGE`
    : `LIVE SOURCE / ${presentationLabel}`;
  recordingContext.fillStyle = "rgba(20,20,18,.64)";
  recordingContext.font = "500 14px 'DM Mono', monospace";
  recordingContext.textAlign = "left";
  recordingContext.fillText(liveLabel, margin, 1038);
  recordingContext.textAlign = "right";
  recordingContext.fillText("1920 × 1080 · 30 FPS TARGET", width - margin, 1038);
}

function drawAuditRecordingFrame() {
  const width = recordingCanvas.width;
  const height = recordingCanvas.height;
  fillRecordingBackground(width, height);
  drawRecordingHeader("SURFACESHIFT / EXACT-PAIR AUDIT", "●  NATIVE PAIRS");

  const margin = 64;
  const gap = 40;
  const size = (width - margin * 2 - gap) / 2;
  const y = 116;
  const pairStyle = state.matchedPair?.style || selectedStyle;
  drawCompareCard(matchedSourceCanvas, margin, y, size, "SOURCE · EXACT INPUT");
  drawCompareCard(matchedOutputCanvas, margin + size + gap, y, size, `OUTPUT · ${pairStyle.toUpperCase()}`);

  const latency = Number(state.matchedPair?.latencyMs);
  const resultLabel = state.mode === "preview" ? "PREVIEW RESULT" : "NATIVE RESULT";
  const pairLabel = Number.isFinite(latency)
    ? `EXACT SOURCE / ${resultLabel} · ${Math.round(latency)}MS ROUND TRIP`
    : `EXACT SOURCE / ${resultLabel}`;
  recordingContext.fillStyle = "rgba(20,20,18,.64)";
  recordingContext.font = "500 14px 'DM Mono', monospace";
  recordingContext.textAlign = "left";
  recordingContext.fillText(pairLabel, margin, 1038);
  recordingContext.textAlign = "right";
  recordingContext.fillText("1920 × 1080", width - margin, 1038);
}

function drawOutputRecordingFrame() {
  const width = recordingCanvas.width;
  const height = recordingCanvas.height;
  const inset = 48;
  const size = width - inset * 2;
  fillRecordingBackground(width, height);

  recordingContext.save();
  recordingContext.shadowColor = "rgba(54,34,21,.28)";
  recordingContext.shadowBlur = 42;
  recordingContext.shadowOffsetY = 24;
  recordingContext.fillStyle = "#f4e9dc";
  recordingContext.beginPath();
  recordingContext.roundRect(inset, inset, size, size, 42);
  recordingContext.fill();
  recordingContext.restore();
  recordingContext.save();
  recordingContext.beginPath();
  recordingContext.roundRect(inset, inset, size, size, 42);
  recordingContext.clip();
  recordingContext.fillStyle = "#d6c2b2";
  recordingContext.fillRect(inset, inset, size, size);
  const outputAspect = outputCanvas.width / outputCanvas.height;
  const drawWidth = outputAspect >= 1 ? size : size * outputAspect;
  const drawHeight = outputAspect >= 1 ? size / outputAspect : size;
  const drawX = inset + (size - drawWidth) / 2;
  const drawY = inset + (size - drawHeight) / 2;
  recordingContext.drawImage(outputCanvas, drawX, drawY, drawWidth, drawHeight);
  recordingContext.restore();

  recordingContext.fillStyle = "rgba(20,20,18,.72)";
  recordingContext.beginPath();
  recordingContext.roundRect(74, 74, 246, 42, 21);
  recordingContext.fill();
  recordingContext.fillStyle = "#fffaf3";
  recordingContext.font = "600 16px 'DM Mono', monospace";
  recordingContext.textAlign = "left";
  recordingContext.textBaseline = "middle";
  recordingContext.fillText("●  SURFACESHIFT / LIVE", 94, 95);
}

function drawRecordingFrame(recording) {
  if (recording.mode === "live") drawLiveCompareRecordingFrame();
  else if (recording.mode === "audit" || recording.mode === "compare") drawAuditRecordingFrame();
  else drawOutputRecordingFrame();
  const elapsed = Math.floor((performance.now() - recording.startedAt) / 1000);
  recordButton.textContent = `Stop · ${elapsed}s`;
}

function resetRecordingControls(recording = null) {
  if (recording && state.recording !== recording) return false;
  if (recording) state.recording = null;
  state.recordingArmed = null;
  recordingMode.disabled = false;
  recordButton.disabled = !state.running;
  recordButton.textContent = "Record";
  recordButton.setAttribute("aria-pressed", "false");
  return true;
}

function startRecording() {
  if (state.recording) {
    if (!state.recording.stopping) stopRecording(true);
    return;
  }
  if (state.recordingArmed) {
    state.recordingArmed = null;
    recordingMode.disabled = false;
    recordButton.textContent = "Record";
    recordButton.setAttribute("aria-pressed", "false");
    setMessage("Recording is no longer armed.");
    return;
  }
  if (!state.running) return;

  const preset = recordingPreset(recordingMode.value);
  const ready = recordingIsReady(preset.mode, {
    firstOutput: state.firstOutput,
    matchedPairReady: state.matchedPairReady,
  });
  if (!ready) {
    state.recordingArmed = preset.mode;
    recordingMode.disabled = true;
    recordButton.textContent = "Recording armed";
    recordButton.setAttribute("aria-pressed", "true");
    const armedMessage = preset.mode === "audit" || preset.mode === "compare"
      ? "Exact-pair audit armed. It will begin on the first native source/result pair."
      : preset.mode === "live"
        ? "Compare recording armed. It will begin on the first displayed generated frame."
        : "Output recording armed. It will begin on the first generated frame.";
    setMessage(armedMessage);
    return;
  }
  beginRecording(preset.mode);
}

function beginRecording(mode) {
  const preset = recordingPreset(mode);
  if (typeof MediaRecorder === "undefined" || !recordingCanvas.captureStream) {
    setMessage("This browser cannot record the generated canvas.", "error");
    resetRecordingControls();
    return;
  }

  recordingCanvas.width = preset.width;
  recordingCanvas.height = preset.height;
  const mimeType = supportedRecordingType();
  const chunks = [];
  const recording = {
    mode: preset.mode,
    recorder: null,
    chunks,
    save: true,
    stopping: false,
    renderTimer: null,
    startedAt: performance.now(),
  };
  let stream;
  let recorder;
  try {
    drawRecordingFrame(recording);
    stream = recordingCanvas.captureStream(30);
    recorder = new MediaRecorder(stream, buildRecordingOptions({
      mimeType,
      cloud: state.mode === "cloud",
      compare: preset.width !== preset.height,
    }));
  } catch (error) {
    stream?.getTracks().forEach((track) => track.stop());
    resetRecordingControls();
    setMessage(error.message || "This browser could not start recording.", "error");
    return;
  }
  recording.recorder = recorder;
  recording.stream = stream;
  state.recording = recording;
  recordingMode.disabled = true;
  recordButton.setAttribute("aria-pressed", "true");
  recordButton.textContent = "Stop · 0s";

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size) chunks.push(event.data);
  });
  recorder.addEventListener("stop", () => {
    stream.getTracks().forEach((track) => track.stop());
    const saved = recording.save && chunks.length > 0;
    if (saved) {
      const type = recorder.mimeType || mimeType || "video/webm";
      const extension = type.includes("mp4") ? "mp4" : "webm";
      const output = new Blob(chunks, { type });
      const url = URL.createObjectURL(output);
      const link = document.createElement("a");
      link.href = url;
      link.download = `surfaceshift-${recording.mode}-${Date.now()}.${extension}`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const savedMessage = recording.mode === "live"
        ? "1920×1080 Compare recording saved with the smooth displayed output."
        : recording.mode === "audit" || recording.mode === "compare"
          ? "1920×1080 exact-pair audit saved. Native holds are expected in this mode."
          : "1080×1080 output recording saved with a 30 fps presentation target.";
      if (!recording.terminalMessage) setMessage(savedMessage);
    }
    if (recording.terminalMessage) {
      const suffix = saved ? " Recording saved." : "";
      setMessage(`${recording.terminalMessage.message}${suffix}`, recording.terminalMessage.tone);
    }
    resetRecordingControls(recording);
  });

  recorder.addEventListener("error", (event) => {
    recording.save = false;
    clearInterval(recording.renderTimer);
    stream.getTracks().forEach((track) => track.stop());
    if (resetRecordingControls(recording)) {
      setMessage(event.error?.message || "Recording failed in this browser.", "error");
    }
  }, { once: true });

  try {
    recorder.start(250);
  } catch (error) {
    recording.save = false;
    stream.getTracks().forEach((track) => track.stop());
    resetRecordingControls(recording);
    setMessage(error.message || "This browser could not start recording.", "error");
    return;
  }
  recording.renderTimer = setInterval(() => drawRecordingFrame(recording), 1000 / 30);
  const startedMessage = recording.mode === "live"
    ? "Compare is recording the moving source and the same model, interpolation, and disclosed motion-compensated output shown live."
    : recording.mode === "audit" || recording.mode === "compare"
      ? "Lab is recording exact native source/result pairs for auditing."
      : "Create is recording the clean 1080×1080 generated stage.";
  setMessage(startedMessage);
}

function stopRecording(save = true, { terminalMessage = null } = {}) {
  const recording = state.recording;
  if (!recording) return;
  recording.save = recording.save && save;
  if (terminalMessage) recording.terminalMessage = terminalMessage;
  if (recording.stopping) return;
  recording.stopping = true;
  clearInterval(recording.renderTimer);
  recordButton.disabled = true;
  recordButton.textContent = save ? "Saving…" : "Stopping…";
  if (recording.recorder.state === "recording") recording.recorder.stop();
  else {
    recording.stream?.getTracks().forEach((track) => track.stop());
    resetRecordingControls(recording);
  }
}

$$(".source-button").forEach((button) => button.addEventListener("click", async () => {
  try {
    if (button.dataset.source === "demo") chooseDemo();
    if (button.dataset.source === "screen") await chooseScreen();
    if (button.dataset.source === "camera") await chooseCamera();
    if (button.dataset.source === "video") chooseVideo();
  } catch (error) {
    setMessage(error.message || "The source could not be opened.", "error");
  }
}));

videoFile.addEventListener("change", async () => {
  try {
    await loadVideoFile(videoFile.files?.[0]);
  } catch (error) {
    setMessage(error.message || "The video could not be opened.", "error");
  }
});

$$(".style-swatch").forEach((button) => button.addEventListener("click", async () => {
  selectedStyle = button.dataset.style;
  $$(".style-swatch").forEach((item) => {
    const active = item === button;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  if (state.running && state.mode === "local") {
    try {
      await configureLocalSession();
    } catch (error) {
      stopTransform(error.message || "Could not update the local prompt.", "error");
    }
  }
}));

runtimeSelect.addEventListener("change", () => {
  if (state.running) stopTransform("Engine changed. Start again when ready.");
  applyRuntime(runtimeSelect.value);
});

accessControl.addEventListener("submit", (event) => {
  event.preventDefault();
  startTransform();
});

strength.addEventListener("input", () => {
  strengthValue.textContent = `${strength.value}%`;
});
strength.addEventListener("change", async () => {
  if (state.running && state.mode === "local") {
    try {
      await configureLocalSession();
    } catch (error) {
      stopTransform(error.message || "Could not update the local effect.", "error");
    }
  }
});

startButton.addEventListener("click", startTransform);
recordButton.addEventListener("click", startRecording);
scrollButton.addEventListener("click", toggleWheelForwarding);
showcaseButton.addEventListener("click", () => setShowcase(!studio.classList.contains("is-showcase")));
exitShowcaseButton.addEventListener("click", () => setShowcase(false));
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && studio.classList.contains("is-showcase")) setShowcase(false);
});
stopSharingButton.addEventListener("click", () => stopAll());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && studio.classList.contains("is-showcase")) setShowcase(false);
});
window.addEventListener("pagehide", () => stopAll({ saveRecording: false }));

boot();
