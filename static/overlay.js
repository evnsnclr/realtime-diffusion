/**
 * Floating-output overlay: Document Picture-in-Picture plus throttle-resistant
 * timers.
 *
 * Chrome clamps a hidden or occluded tab's timers to once per second (and to
 * once per minute after five minutes), which would stall the 10 fps capture
 * pump as soon as another window covers the app. Dedicated-worker messages are
 * not subject to page timer throttling, and the PiP window itself stays
 * visible, so together they keep a live session sampling while the user works
 * in other apps.
 */

const OVERLAY_DOCUMENT_STYLES = `
  :root { color-scheme: dark; }
  body {
    margin: 0;
    height: 100vh;
    display: grid;
    grid-template-rows: 1fr auto;
    background: #171310;
  }
  .overlay-stage {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 0;
  }
  .overlay-stage canvas {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .overlay-status {
    padding: 6px 12px;
    text-align: center;
    color: #d9cfc2;
    font: 500 11px "DM Mono", ui-monospace, monospace;
    letter-spacing: 0.04em;
  }
`;

function defaultWorkerFactory() {
  if (typeof Worker === "undefined") return null;
  try {
    // A same-origin worker file satisfies the app's script-src 'self' CSP;
    // Blob workers do not.
    return new Worker(new URL("overlay-timer-worker.js", import.meta.url));
  } catch {
    return null;
  }
}

export function createResilientTimers({
  host = globalThis,
  createWorker = defaultWorkerFactory,
} = {}) {
  let worker = null;
  try {
    worker = createWorker() || null;
  } catch {
    worker = null;
  }

  const entries = new Map();
  let nextId = 1;

  if (worker) {
    worker.onmessage = ({ data }) => {
      const entry = entries.get(data?.id);
      if (!entry) return;
      if (entry.once) entries.delete(data.id);
      entry.callback();
    };
  }

  const start = (callback, delayMs, once) => {
    const id = nextId;
    nextId += 1;
    if (worker) {
      entries.set(id, { callback, once });
      worker.postMessage({ type: once ? "timeout" : "interval", id, delayMs });
    } else {
      const hostId = once
        ? host.setTimeout(callback, delayMs)
        : host.setInterval(callback, delayMs);
      entries.set(id, { hostId, once });
    }
    return id;
  };

  const clear = (id) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (worker) {
      worker.postMessage({ type: "clear", id });
    } else if (entry.once) {
      host.clearTimeout(entry.hostId);
    } else {
      host.clearInterval(entry.hostId);
    }
  };

  return {
    get usingWorker() {
      return worker !== null;
    },
    setInterval: (callback, delayMs) => start(callback, delayMs, false),
    setTimeout: (callback, delayMs) => start(callback, delayMs, true),
    clearInterval: clear,
    clearTimeout: clear,
    dispose() {
      entries.clear();
      worker?.terminate?.();
      worker = null;
    },
  };
}

export function overlaySupported(host = globalThis) {
  return typeof host.documentPictureInPicture?.requestWindow === "function";
}

export function createOverlayController({
  host = globalThis,
  onOpen = () => {},
  onClose = () => {},
} = {}) {
  let pipWindow = null;
  let statusElement = null;
  const restore = { element: null, parent: null, nextSibling: null };

  const handleClosed = () => {
    if (!pipWindow) return;
    pipWindow = null;
    statusElement = null;
    if (restore.element && restore.parent) {
      restore.parent.insertBefore(restore.element, restore.nextSibling);
    }
    restore.element = null;
    restore.parent = null;
    restore.nextSibling = null;
    onClose();
  };

  return {
    get supported() {
      return overlaySupported(host);
    },
    get isOpen() {
      return pipWindow !== null;
    },
    get window() {
      return pipWindow;
    },
    async open({ content, width = 480, height = 480, statusText = "" }) {
      if (pipWindow) return pipWindow;
      if (!overlaySupported(host)) {
        throw new Error(
          "Floating output needs the Document Picture-in-Picture API (Chrome or Edge 116+).",
        );
      }
      const opened = await host.documentPictureInPicture.requestWindow({ width, height });
      const doc = opened.document;
      const style = doc.createElement("style");
      style.textContent = OVERLAY_DOCUMENT_STYLES;
      doc.head.append(style);

      restore.element = content;
      restore.parent = content.parentNode;
      restore.nextSibling = content.nextSibling;

      const stage = doc.createElement("div");
      stage.className = "overlay-stage";
      stage.append(content);
      statusElement = doc.createElement("div");
      statusElement.className = "overlay-status";
      statusElement.textContent = statusText;
      doc.body.append(stage, statusElement);

      opened.addEventListener("pagehide", handleClosed, { once: true });
      pipWindow = opened;
      onOpen(opened);
      return opened;
    },
    close() {
      const closing = pipWindow;
      if (!closing) return;
      handleClosed();
      closing.close();
    },
    setStatus(text) {
      if (statusElement) statusElement.textContent = text;
    },
  };
}
