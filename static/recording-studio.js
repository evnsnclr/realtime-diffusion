/**
 * Recording studio: the Compare / Create / Lab capture pipeline.
 *
 * Owns the 30 fps recording compositor, MediaRecorder lifecycle, and the
 * record-button state machine. All DOM elements and app state arrive through
 * the factory so this module stays free of document-level lookups.
 */

import { buildRecordingOptions } from "./flux-config.js?v=0.6.0";
import {
  containRect,
  recordingIsReady,
  recordingPreset,
} from "./recording-layout.js?v=0.6.0";

export function createRecordingStudio({
  state,
  timers,
  setMessage,
  sourceIsReady,
  drawSourceToLiveRecording,
  mediaDimensions,
  getSelectedStyle,
  elements: {
    recordingCanvas,
    recordButton,
    recordingMode,
    captureCanvas,
    liveSourceCanvas,
    outputCanvas,
    matchedSourceCanvas,
    matchedOutputCanvas,
  },
}) {
  const recordingContext = recordingCanvas.getContext("2d");

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
    const pairStyle = state.matchedPair?.style || getSelectedStyle();
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
      timers.clearInterval(recording.renderTimer);
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
    recording.renderTimer = timers.setInterval(() => drawRecordingFrame(recording), 1000 / 30);
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
    timers.clearInterval(recording.renderTimer);
    recordButton.disabled = true;
    recordButton.textContent = save ? "Saving…" : "Stopping…";
    if (recording.recorder.state === "recording") recording.recorder.stop();
    else {
      recording.stream?.getTracks().forEach((track) => track.stop());
      resetRecordingControls(recording);
    }
  }

  return { startRecording, beginRecording, stopRecording };
}
