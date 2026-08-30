export const FRAME_WIDTH = 320;
export const FRAME_HEIGHT = 180;
export const SCENARIO_DURATION_MS = 4_000;
export const SCENARIOS = Object.freeze(["scroll", "map-motion", "structure"]);

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function keyframed(timeMs, points) {
  if (timeMs <= points[0][0]) return points[0][1];
  for (let index = 1; index < points.length; index += 1) {
    const [time, value] = points[index];
    const [previousTime, previousValue] = points[index - 1];
    if (timeMs <= time) {
      const mix = smoothstep((timeMs - previousTime) / (time - previousTime));
      return previousValue + (value - previousValue) * mix;
    }
  }
  return points.at(-1)[1];
}

function frame(fill = [235, 224, 209]) {
  const pixels = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT * 3);
  for (let offset = 0; offset < pixels.length; offset += 3) {
    pixels[offset] = fill[0];
    pixels[offset + 1] = fill[1];
    pixels[offset + 2] = fill[2];
  }
  return pixels;
}

function setPixel(pixels, x, y, color) {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || px >= FRAME_WIDTH || py < 0 || py >= FRAME_HEIGHT) return;
  const offset = (py * FRAME_WIDTH + px) * 3;
  pixels[offset] = color[0];
  pixels[offset + 1] = color[1];
  pixels[offset + 2] = color[2];
}

function rect(pixels, x, y, width, height, color) {
  const left = clamp(Math.floor(x), 0, FRAME_WIDTH);
  const top = clamp(Math.floor(y), 0, FRAME_HEIGHT);
  const right = clamp(Math.ceil(x + width), 0, FRAME_WIDTH);
  const bottom = clamp(Math.ceil(y + height), 0, FRAME_HEIGHT);
  for (let py = top; py < bottom; py += 1) {
    let offset = (py * FRAME_WIDTH + left) * 3;
    for (let px = left; px < right; px += 1) {
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      offset += 3;
    }
  }
}

function circle(pixels, centerX, centerY, radius, color) {
  const radiusSquared = radius * radius;
  for (let y = Math.floor(centerY - radius); y <= Math.ceil(centerY + radius); y += 1) {
    for (let x = Math.floor(centerX - radius); x <= Math.ceil(centerX + radius); x += 1) {
      if ((x - centerX) ** 2 + (y - centerY) ** 2 <= radiusSquared) {
        setPixel(pixels, x, y, color);
      }
    }
  }
}

function line(pixels, startX, startY, endX, endY, color, thickness = 1) {
  const steps = Math.max(Math.abs(endX - startX), Math.abs(endY - startY), 1);
  for (let step = 0; step <= steps; step += 1) {
    const mix = step / steps;
    const x = startX + (endX - startX) * mix;
    const y = startY + (endY - startY) * mix;
    circle(pixels, x, y, thickness, color);
  }
}

function pseudoText(pixels, x, y, width, color, rows = 3) {
  for (let row = 0; row < rows; row += 1) {
    const rowWidth = width * (row === rows - 1 ? 0.63 : 1 - row * 0.08);
    rect(pixels, x, y + row * 5, rowWidth, 2, color);
  }
}

function scrollOffset(timeMs) {
  return keyframed(timeMs, [
    [0, 0],
    [450, 0],
    [1_400, 92],
    [1_750, 92],
    [2_550, 38],
    [2_850, 38],
    [3_850, 142],
    [4_000, 142],
  ]);
}

function renderScroll(timeMs) {
  const pixels = frame([241, 233, 221]);
  rect(pixels, 0, 0, FRAME_WIDTH, 24, [32, 38, 42]);
  circle(pixels, 14, 12, 4, [235, 112, 69]);
  pseudoText(pixels, 28, 8, 42, [232, 225, 211], 2);
  rect(pixels, 244, 7, 60, 10, [62, 69, 72]);

  const palette = [
    [232, 127, 82], [100, 155, 132], [123, 104, 219],
    [238, 190, 75], [95, 126, 168], [198, 112, 137],
  ];
  const offset = scrollOffset(timeMs);
  for (let index = 0; index < 18; index += 1) {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const x = 12 + column * 102;
    const y = 32 + row * 72 - offset;
    rect(pixels, x + 2, y + 3, 92, 62, [205, 194, 180]);
    rect(pixels, x, y, 92, 62, [251, 247, 239]);
    rect(pixels, x + 5, y + 5, 82, 37, palette[index % palette.length]);
    circle(pixels, x + 25 + (index % 2) * 35, y + 23, 10, palette[(index + 2) % palette.length]);
    pseudoText(pixels, x + 7, y + 47, 65, [75, 72, 67], 2);
  }
  const thumbY = 30 + (offset / 142) * 112;
  rect(pixels, 313, 28, 3, 140, [216, 203, 187]);
  rect(pixels, 313, thumbY, 3, 25, [105, 94, 84]);
  return { pixels, motion: { x: 0, y: -offset, scale: 1 } };
}

function mapState(timeMs) {
  return {
    panX: keyframed(timeMs, [
      [0, -18], [700, -18], [1_600, 34], [2_100, 34], [3_000, -28], [4_000, 4],
    ]),
    panY: keyframed(timeMs, [
      [0, 12], [1_200, 12], [2_100, -24], [2_600, -24], [3_500, 18], [4_000, 18],
    ]),
    scale: keyframed(timeMs, [
      [0, 0.88], [850, 0.88], [1_350, 1.12], [2_500, 1.12], [3_050, 0.94], [4_000, 0.94],
    ]),
  };
}

function mapPoint(worldX, worldY, state) {
  return {
    x: FRAME_WIDTH / 2 + (worldX + state.panX) * state.scale,
    y: FRAME_HEIGHT / 2 + (worldY + state.panY) * state.scale,
  };
}

function renderMap(timeMs) {
  const pixels = frame([189, 202, 164]);
  const state = mapState(timeMs);

  for (let y = -180; y <= 180; y += 45) {
    const a = mapPoint(-240, y, state);
    const b = mapPoint(240, y + 28, state);
    line(pixels, a.x, a.y, b.x, b.y, [225, 215, 188], 3);
    line(pixels, a.x, a.y, b.x, b.y, [239, 231, 207], 1);
  }
  for (let x = -240; x <= 240; x += 55) {
    const a = mapPoint(x, -180, state);
    const b = mapPoint(x - 32, 180, state);
    line(pixels, a.x, a.y, b.x, b.y, [222, 211, 184], 3);
    line(pixels, a.x, a.y, b.x, b.y, [243, 235, 214], 1);
  }

  const waterA = mapPoint(-210, 35, state);
  const waterB = mapPoint(210, 85, state);
  line(pixels, waterA.x, waterA.y, waterB.x, waterB.y, [98, 157, 183], 10);
  const landmarks = [
    [-95, -48, [230, 112, 72]],
    [4, -18, [121, 99, 210]],
    [92, 34, [231, 184, 65]],
    [-32, 70, [86, 139, 115]],
  ];
  for (const [worldX, worldY, color] of landmarks) {
    const point = mapPoint(worldX, worldY, state);
    rect(pixels, point.x - 12 * state.scale, point.y - 8 * state.scale, 24 * state.scale, 16 * state.scale, color);
    circle(pixels, point.x, point.y - 10 * state.scale, 4 * state.scale, [248, 243, 231]);
  }
  rect(pixels, 10, 10, 84, 20, [248, 244, 235]);
  pseudoText(pixels, 19, 16, 59, [55, 60, 57], 2);
  circle(pixels, 296, 154, 13, [248, 244, 235]);
  line(pixels, 288, 154, 304, 154, [58, 61, 59], 1);
  line(pixels, 296, 146, 296, 162, [58, 61, 59], 1);
  return { pixels, motion: { x: state.panX, y: state.panY, scale: state.scale } };
}

function renderStructure(timeMs) {
  const pixels = frame([233, 225, 213]);
  const shift = keyframed(timeMs, [
    [0, -4], [700, -4], [1_700, 10], [2_300, 10], [3_300, -8], [4_000, -8],
  ]);
  rect(pixels, 0, 0, FRAME_WIDTH, 30, [73, 66, 61]);
  circle(pixels, 17 + shift * 0.1, 15, 6, [239, 123, 77]);
  pseudoText(pixels, 33 + shift * 0.1, 10, 78, [241, 233, 220], 3);
  rect(pixels, 230, 8, 72, 14, [99, 91, 84]);

  const cardX = 18 + shift;
  rect(pixels, cardX + 3, 46, 135, 112, [190, 178, 165]);
  rect(pixels, cardX, 43, 135, 112, [251, 247, 240]);
  circle(pixels, cardX + 46, 84, 22, [209, 148, 113]);
  circle(pixels, cardX + 40, 80, 3, [48, 45, 42]);
  circle(pixels, cardX + 52, 80, 3, [48, 45, 42]);
  line(pixels, cardX + 40, 93, cardX + 52, 93, [91, 61, 52], 1);
  pseudoText(pixels, cardX + 16, 116, 101, [62, 59, 55], 4);

  const panelX = 171 + shift * 0.45;
  rect(pixels, panelX, 43, 131, 48, [124, 104, 218]);
  circle(pixels, panelX + 104, 67, 14, [242, 193, 79]);
  pseudoText(pixels, panelX + 13, 56, 63, [249, 245, 235], 3);
  rect(pixels, panelX, 103, 61, 52, [100, 153, 129]);
  rect(pixels, panelX + 70, 103, 61, 52, [231, 127, 82]);
  circle(pixels, panelX + 30, 124, 10, [247, 240, 224]);
  rect(pixels, panelX + 84, 116, 33, 16, [249, 242, 229]);
  pseudoText(pixels, panelX + 77, 140, 44, [65, 61, 56], 2);
  return { pixels, motion: { x: shift, y: 0, scale: 1 } };
}

export function renderScenarioFrame(name, timeMs) {
  const boundedTime = clamp(timeMs, 0, SCENARIO_DURATION_MS);
  if (name === "scroll") return renderScroll(boundedTime);
  if (name === "map-motion") return renderMap(boundedTime);
  if (name === "structure") return renderStructure(boundedTime);
  throw new Error(`Unknown benchmark scenario: ${name}`);
}

export function stylizeFrame(source) {
  const output = new Uint8Array(source.length);
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const offset = (y * FRAME_WIDTH + x) * 3;
      const red = source[offset];
      const green = source[offset + 1];
      const blue = source[offset + 2];
      const light = (red * 3 + green * 5 + blue * 2) / 10;
      const texture = ((x * 17 + y * 23) % 29) - 14;
      output[offset] = clamp(Math.round(red * 0.82 + light * 0.18 + 16 + texture * 0.28), 0, 255);
      output[offset + 1] = clamp(Math.round(green * 0.78 + light * 0.12 + 10 + texture * 0.18), 0, 255);
      output[offset + 2] = clamp(Math.round(blue * 0.68 + light * 0.12 + 5 + texture * 0.12), 0, 255);
    }
  }
  return output;
}

export function blendFrames(previous, current, fraction = 0.5) {
  if (!previous) return new Uint8Array(current);
  const output = new Uint8Array(current.length);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = Math.round(previous[index] * (1 - fraction) + current[index] * fraction);
  }
  return output;
}

export function joinFrames(left, right) {
  const width = FRAME_WIDTH * 2;
  const output = new Uint8Array(width * FRAME_HEIGHT * 3);
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    const leftStart = y * FRAME_WIDTH * 3;
    const outputStart = y * width * 3;
    output.set(left.subarray(leftStart, leftStart + FRAME_WIDTH * 3), outputStart);
    output.set(right.subarray(leftStart, leftStart + FRAME_WIDTH * 3), outputStart + FRAME_WIDTH * 3);
  }
  return output;
}

export function meanAbsoluteDifference(first, second) {
  if (!first || !second || first.length !== second.length) return Infinity;
  let total = 0;
  for (let index = 0; index < first.length; index += 3) {
    total += Math.abs(first[index] - second[index]);
    total += Math.abs(first[index + 1] - second[index + 1]);
    total += Math.abs(first[index + 2] - second[index + 2]);
  }
  return total / first.length;
}
