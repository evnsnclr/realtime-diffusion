/**
 * Source manager: selecting and tearing down the live input.
 *
 * Owns the demo canvas, captured-tab, camera, and video-file sources plus
 * their shared teardown. DOM elements and app state arrive through the
 * factory; session control flows back through the onStop callbacks.
 */

import { startDemoSource } from "./demo-source.js?v=0.6.0";

const $$ = (selector) => [...document.querySelectorAll(selector)];

export function createSourceManager({
  state,
  setMessage,
  onStopTransform,
  onStopAll,
  elements: {
    studio,
    inputVideo,
    demoCanvas,
    inputEmpty,
    videoFile,
    sourceStatus,
    stopSharingButton,
    scrollButton,
  },
}) {
  let sourceStream = null;
  let sourceKind = null;
  let sourceObjectUrl = null;

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
    if (state.running) onStopTransform();
    stopSourceTracks();
    state.demoStop = startDemoSource(demoCanvas);
    setSourceSelected("demo");
    setMessage("Animated map and gallery ready. This source is designed to make motion easy to judge.");
  }

  async function chooseScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing is unavailable in this browser.");
    if (state.running) onStopTransform();
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
      if (sourceStream?.getVideoTracks().includes(track)) onStopAll();
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
    if (state.running) onStopTransform();
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
      if (sourceStream?.getVideoTracks().includes(track)) onStopAll();
    });
    setSourceSelected("camera");
  }

  function chooseVideo() {
    videoFile.value = "";
    videoFile.click();
  }

  async function loadVideoFile(file) {
    if (!file) return;
    if (state.running) onStopTransform();
    stopSourceTracks();
    sourceObjectUrl = URL.createObjectURL(file);
    inputVideo.src = sourceObjectUrl;
    inputVideo.loop = true;
    await inputVideo.play();
    setSourceSelected("video");
  }

  function stop() {
    stopSourceTracks();
    sourceKind = null;
    delete studio.dataset.source;
  }

  return {
    get kind() {
      return sourceKind;
    },
    media: getSourceMedia,
    isReady: sourceIsReady,
    chooseDemo,
    chooseScreen,
    chooseCamera,
    chooseVideo,
    loadVideoFile,
    stop,
  };
}
