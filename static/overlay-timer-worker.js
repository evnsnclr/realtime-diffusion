// Timer ticks for overlay.js. Worker messages are exempt from the page timer
// throttling Chrome applies to hidden tabs, so intervals scheduled here keep
// the capture pump sampling while the app tab is covered.
const timers = new Map();

self.onmessage = ({ data }) => {
  if (data.type === "interval") {
    timers.set(data.id, setInterval(() => self.postMessage({ id: data.id }), data.delayMs));
  } else if (data.type === "timeout") {
    timers.set(data.id, setTimeout(() => {
      timers.delete(data.id);
      self.postMessage({ id: data.id });
    }, data.delayMs));
  } else if (data.type === "clear") {
    const timer = timers.get(data.id);
    clearInterval(timer);
    clearTimeout(timer);
    timers.delete(data.id);
  }
};
