const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function downsampleLuma(
  pixels,
  width,
  height,
  {
    channels = 4,
    sampleWidth = 48,
    sampleHeight = 48,
    insetFraction = 0.06,
  } = {},
) {
  if (!pixels || width <= 0 || height <= 0 || ![3, 4].includes(channels)) {
    throw new Error("Valid RGB or RGBA pixels and dimensions are required");
  }
  const insetX = Math.floor(width * insetFraction);
  const insetY = Math.floor(height * insetFraction);
  const usableWidth = Math.max(1, width - insetX * 2);
  const usableHeight = Math.max(1, height - insetY * 2);
  const luma = new Float32Array(sampleWidth * sampleHeight);
  for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
    const sourceY = clamp(
      Math.floor(insetY + ((sampleY + 0.5) / sampleHeight) * usableHeight),
      0,
      height - 1,
    );
    for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
      const sourceX = clamp(
        Math.floor(insetX + ((sampleX + 0.5) / sampleWidth) * usableWidth),
        0,
        width - 1,
      );
      const sourceOffset = (sourceY * width + sourceX) * channels;
      luma[sampleY * sampleWidth + sampleX] = (
        pixels[sourceOffset] * 0.299
        + pixels[sourceOffset + 1] * 0.587
        + pixels[sourceOffset + 2] * 0.114
      );
    }
  }
  return { luma, width: sampleWidth, height: sampleHeight };
}

function variance(values) {
  if (!values.length) return 0;
  let sum = 0;
  let squareSum = 0;
  for (const value of values) {
    sum += value;
    squareSum += value * value;
  }
  const mean = sum / values.length;
  return Math.max(0, squareSum / values.length - mean * mean);
}

function translationError(previous, current, width, height, dx, dy) {
  const startX = Math.max(0, -dx);
  const endX = Math.min(width, width - dx);
  const startY = Math.max(0, -dy);
  const endY = Math.min(height, height - dy);
  let error = 0;
  let count = 0;
  for (let y = startY; y < endY; y += 1) {
    const currentY = y + dy;
    for (let x = startX; x < endX; x += 1) {
      error += Math.abs(previous[y * width + x] - current[currentY * width + x + dx]);
      count += 1;
    }
  }
  return count ? error / count : Infinity;
}

export function estimateTranslation(
  previous,
  current,
  width,
  height,
  {
    maxShift = 6,
    minimumVariance = 30,
    minimumImprovement = 0.045,
    maximumError = 38,
  } = {},
) {
  if (!previous || !current || previous.length !== width * height || current.length !== previous.length) {
    throw new Error("Motion samples must have matching dimensions");
  }
  const texture = Math.min(variance(previous), variance(current));
  const zeroError = translationError(previous, current, width, height, 0, 0);
  if (texture < minimumVariance || zeroError < 0.25) {
    return {
      dx: 0,
      dy: 0,
      accepted: false,
      error: zeroError,
      zeroError,
      improvement: 0,
      texture,
    };
  }

  let best = { dx: 0, dy: 0, error: zeroError };
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const error = translationError(previous, current, width, height, dx, dy);
      const magnitudePenalty = Math.hypot(dx, dy) * 0.035;
      if (error + magnitudePenalty < best.error + Math.hypot(best.dx, best.dy) * 0.035) {
        best = { dx, dy, error };
      }
    }
  }
  const improvement = (zeroError - best.error) / Math.max(zeroError, 1);
  const accepted = (
    (best.dx !== 0 || best.dy !== 0)
    && improvement >= minimumImprovement
    && best.error <= maximumError
  );
  return {
    ...best,
    dx: accepted ? best.dx : 0,
    dy: accepted ? best.dy : 0,
    accepted,
    zeroError,
    improvement,
    texture,
  };
}

export class SourceMotionTracker {
  constructor({
    sampleWidth = 48,
    sampleHeight = 48,
    maxShift = 6,
    maximumStepFraction = 0.08,
  } = {}) {
    this.sampleWidth = sampleWidth;
    this.sampleHeight = sampleHeight;
    this.maxShift = maxShift;
    this.maximumStepFraction = maximumStepFraction;
    this.reset();
  }

  reset() {
    this.previous = null;
    this.positionX = 0;
    this.positionY = 0;
    this.lastCapturedAt = null;
    this.acceptedCount = 0;
    this.rejectedCount = 0;
  }

  observe(sample, capturedAt) {
    if (!sample || sample.length !== this.sampleWidth * this.sampleHeight) {
      throw new Error("Unexpected motion sample size");
    }
    let estimate = {
      dx: 0,
      dy: 0,
      accepted: false,
      error: 0,
      zeroError: 0,
      improvement: 0,
      texture: variance(sample),
    };
    if (this.previous) {
      estimate = estimateTranslation(
        this.previous,
        sample,
        this.sampleWidth,
        this.sampleHeight,
        { maxShift: this.maxShift },
      );
      const stepX = estimate.dx / this.sampleWidth;
      const stepY = estimate.dy / this.sampleHeight;
      if (
        estimate.accepted
        && Math.abs(stepX) <= this.maximumStepFraction
        && Math.abs(stepY) <= this.maximumStepFraction
      ) {
        this.positionX += stepX;
        this.positionY += stepY;
        this.acceptedCount += 1;
      } else {
        estimate = { ...estimate, dx: 0, dy: 0, accepted: false };
        this.rejectedCount += 1;
      }
    }
    this.previous = new Float32Array(sample);
    this.lastCapturedAt = capturedAt;
    return { ...this.snapshot(), estimate };
  }

  snapshot() {
    return {
      x: this.positionX,
      y: this.positionY,
      capturedAt: this.lastCapturedAt,
    };
  }

  deltaFrom(anchor, { maximumWarpFraction = 0.055 } = {}) {
    if (!anchor) return { x: 0, y: 0 };
    return {
      x: clamp(this.positionX - anchor.x, -maximumWarpFraction, maximumWarpFraction),
      y: clamp(this.positionY - anchor.y, -maximumWarpFraction, maximumWarpFraction),
    };
  }
}

export function translateRgbFrameClamped(pixels, width, height, dx, dy) {
  const output = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y += 1) {
    const sourceY = clamp(Math.round(y - dy), 0, height - 1);
    for (let x = 0; x < width; x += 1) {
      const sourceX = clamp(Math.round(x - dx), 0, width - 1);
      const sourceOffset = (sourceY * width + sourceX) * 3;
      const outputOffset = (y * width + x) * 3;
      output[outputOffset] = pixels[sourceOffset];
      output[outputOffset + 1] = pixels[sourceOffset + 1];
      output[outputOffset + 2] = pixels[sourceOffset + 2];
    }
  }
  return output;
}

export function drawTranslatedWithEdgeFill(context, source, width, height, dx, dy) {
  const offsetX = Math.round(dx);
  const offsetY = Math.round(dy);
  context.clearRect(0, 0, width, height);
  context.drawImage(source, offsetX, offsetY, width, height);
  if (offsetX > 0) context.drawImage(source, 0, 0, 1, height, 0, 0, offsetX, height);
  if (offsetX < 0) context.drawImage(source, width - 1, 0, 1, height, width + offsetX, 0, -offsetX, height);
  if (offsetY > 0) context.drawImage(source, 0, 0, width, 1, 0, 0, width, offsetY);
  if (offsetY < 0) context.drawImage(source, 0, height - 1, width, 1, 0, height + offsetY, width, -offsetY);
}
