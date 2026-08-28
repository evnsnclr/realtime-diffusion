import assert from "node:assert/strict";
import test from "node:test";

import {
  createOverlayController,
  createResilientTimers,
  overlaySupported,
} from "../static/overlay.js";

class FakeTimerWorker {
  constructor() {
    this.posted = [];
    this.onmessage = null;
    this.terminated = false;
  }

  postMessage(message) {
    this.posted.push(message);
  }

  fire(id) {
    this.onmessage?.({ data: { id } });
  }

  terminate() {
    this.terminated = true;
  }
}

function fakeHostTimers() {
  return {
    setIntervalCalls: [],
    setTimeoutCalls: [],
    clearedIntervals: [],
    clearedTimeouts: [],
    setInterval(callback, delayMs) {
      this.setIntervalCalls.push({ callback, delayMs });
      return `host-interval-${this.setIntervalCalls.length}`;
    },
    setTimeout(callback, delayMs) {
      this.setTimeoutCalls.push({ callback, delayMs });
      return `host-timeout-${this.setTimeoutCalls.length}`;
    },
    clearInterval(id) {
      this.clearedIntervals.push(id);
    },
    clearTimeout(id) {
      this.clearedTimeouts.push(id);
    },
  };
}

test("worker-backed interval fires on worker messages and clears cleanly", () => {
  const worker = new FakeTimerWorker();
  const timers = createResilientTimers({ createWorker: () => worker });
  assert.equal(timers.usingWorker, true);

  let ticks = 0;
  const id = timers.setInterval(() => { ticks += 1; }, 100);
  assert.deepEqual(worker.posted, [{ type: "interval", id, delayMs: 100 }]);

  worker.fire(id);
  worker.fire(id);
  assert.equal(ticks, 2);

  timers.clearInterval(id);
  assert.deepEqual(worker.posted.at(-1), { type: "clear", id });
  worker.fire(id);
  assert.equal(ticks, 2);
});

test("worker-backed timeout fires once and ignores duplicate messages", () => {
  const worker = new FakeTimerWorker();
  const timers = createResilientTimers({ createWorker: () => worker });

  let fired = 0;
  const id = timers.setTimeout(() => { fired += 1; }, 250);
  assert.deepEqual(worker.posted, [{ type: "timeout", id, delayMs: 250 }]);

  worker.fire(id);
  worker.fire(id);
  assert.equal(fired, 1);
});

test("clearing an unknown or null timer id is a safe no-op", () => {
  const worker = new FakeTimerWorker();
  const timers = createResilientTimers({ createWorker: () => worker });
  timers.clearTimeout(null);
  timers.clearInterval(undefined);
  timers.clearTimeout(987);
  assert.deepEqual(worker.posted, []);
});

test("falls back to host timers when no worker is available", () => {
  const host = fakeHostTimers();
  const timers = createResilientTimers({ host, createWorker: () => null });
  assert.equal(timers.usingWorker, false);

  const intervalId = timers.setInterval(() => {}, 100);
  const timeoutId = timers.setTimeout(() => {}, 500);
  assert.equal(host.setIntervalCalls[0].delayMs, 100);
  assert.equal(host.setTimeoutCalls[0].delayMs, 500);

  timers.clearInterval(intervalId);
  timers.clearTimeout(timeoutId);
  assert.deepEqual(host.clearedIntervals, ["host-interval-1"]);
  assert.deepEqual(host.clearedTimeouts, ["host-timeout-1"]);
});

test("a throwing worker factory degrades to host timers instead of failing", () => {
  const host = fakeHostTimers();
  const timers = createResilientTimers({
    host,
    createWorker: () => {
      throw new Error("workers forbidden");
    },
  });
  assert.equal(timers.usingWorker, false);
  timers.setInterval(() => {}, 100);
  assert.equal(host.setIntervalCalls.length, 1);
});

function detachFakeNode(node) {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.children.indexOf(node);
  if (index !== -1) parent.children.splice(index, 1);
  node.parentNode = null;
}

function fakeElement(tagName = "div") {
  const element = {
    tagName,
    className: "",
    textContent: "",
    children: [],
    parentNode: null,
    get nextSibling() {
      if (!element.parentNode) return null;
      const siblings = element.parentNode.children;
      const index = siblings.indexOf(element);
      return index === -1 ? null : siblings[index + 1] ?? null;
    },
    append(...nodes) {
      for (const node of nodes) {
        detachFakeNode(node);
        node.parentNode = element;
        element.children.push(node);
      }
    },
    insertBefore(node, reference) {
      detachFakeNode(node);
      node.parentNode = element;
      const index = reference ? element.children.indexOf(reference) : -1;
      if (index === -1) element.children.push(node);
      else element.children.splice(index, 0, node);
      return node;
    },
  };
  return element;
}

function fakePipWindow() {
  const listeners = new Map();
  return {
    document: {
      head: fakeElement("head"),
      body: fakeElement("body"),
      createElement: (tagName) => fakeElement(tagName),
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      listeners.get(type)?.({});
    },
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
    },
  };
}

function fakePipHost(pip) {
  return {
    documentPictureInPicture: {
      requests: [],
      async requestWindow(options) {
        this.requests.push(options);
        return pip;
      },
    },
  };
}

test("overlaySupported reflects the host capability", () => {
  assert.equal(overlaySupported({}), false);
  assert.equal(overlaySupported(fakePipHost(fakePipWindow())), true);
});

test("open moves the content into the floating window and reports state", async () => {
  const pip = fakePipWindow();
  const host = fakePipHost(pip);
  const events = [];
  const controller = createOverlayController({
    host,
    onOpen: () => events.push("open"),
    onClose: () => events.push("close"),
  });

  const home = fakeElement("section");
  const canvas = fakeElement("canvas");
  const sibling = fakeElement("p");
  home.append(canvas, sibling);

  await controller.open({ content: canvas, width: 480, height: 360, statusText: "warming" });

  assert.equal(controller.isOpen, true);
  assert.equal(controller.window, pip);
  assert.deepEqual(host.documentPictureInPicture.requests, [{ width: 480, height: 360 }]);
  const [stage, status] = pip.document.body.children;
  assert.equal(stage.children[0], canvas);
  assert.equal(status.textContent, "warming");
  assert.deepEqual(events, ["open"]);

  controller.setStatus("4.0 native");
  assert.equal(status.textContent, "4.0 native");
});

test("close restores the content to its original position exactly once", async () => {
  const pip = fakePipWindow();
  const controller = createOverlayController({ host: fakePipHost(pip) });

  const home = fakeElement("section");
  const canvas = fakeElement("canvas");
  const sibling = fakeElement("p");
  home.append(canvas, sibling);

  await controller.open({ content: canvas });
  assert.equal(home.children.includes(canvas), false);

  controller.close();
  assert.equal(controller.isOpen, false);
  assert.equal(pip.closeCalls, 1);
  assert.deepEqual(home.children, [canvas, sibling]);

  pip.dispatch("pagehide");
  controller.close();
  assert.equal(pip.closeCalls, 1);
  assert.deepEqual(home.children, [canvas, sibling]);
});

test("a user-initiated pagehide restores content and fires onClose", async () => {
  const pip = fakePipWindow();
  const events = [];
  const controller = createOverlayController({
    host: fakePipHost(pip),
    onClose: () => events.push("close"),
  });

  const home = fakeElement("section");
  const canvas = fakeElement("canvas");
  home.append(canvas);

  await controller.open({ content: canvas });
  pip.dispatch("pagehide");

  assert.equal(controller.isOpen, false);
  assert.deepEqual(home.children, [canvas]);
  assert.deepEqual(events, ["close"]);
  controller.setStatus("ignored after close");
});

test("open rejects on unsupported hosts", async () => {
  const controller = createOverlayController({ host: {} });
  await assert.rejects(
    () => controller.open({ content: fakeElement("canvas") }),
    /Document Picture-in-Picture/,
  );
});
