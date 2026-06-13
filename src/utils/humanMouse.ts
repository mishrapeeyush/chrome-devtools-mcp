/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Minimal mouse API used for human-like pointer paths. */
export interface HumanMouse {
  move(x: number, y: number): Promise<void>;
}

export interface HumanMousePoint {
  x: number;
  y: number;
}

/** Human-like movement delta stats (pixels), inspired by GMM-morphed human traces. */
const HUMAN_DELTA_MEAN = 5;
const HUMAN_DELTA_STD = 2;

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Pick a point inside a box, biased toward center but not dead-center. */
export function randomPointInBox(
  x: number,
  y: number,
  width: number,
  height: number,
): HumanMousePoint {
  const padX = width * 0.2;
  const padY = height * 0.2;
  const innerW = Math.max(4, width - padX * 2);
  const innerH = Math.max(4, height - padY * 2);
  return {
    x: Math.round(x + padX + Math.random() * innerW),
    y: Math.round(y + padY + Math.random() * innerH),
  };
}

export function randomNormal(mean: number, stddev: number): number {
  const u1 = Math.max(Number.MIN_VALUE, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

/** Cumulative random walk — base path before smoothing. */
export function randomWalk(length: number, stddev: number): number[] {
  const walk: number[] = [0];
  for (let i = 1; i < length; i++) {
    walk.push(walk[i - 1] + randomNormal(0, stddev));
  }
  return walk;
}

function gaussianKernel(sigma: number, radius: number): number[] {
  const kernel: number[] = [];
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel.push(v);
    sum += v;
  }
  return kernel.map(v => v / sum);
}

/** 1D Gaussian smoothing (equivalent to scipy.ndimage.gaussian_filter1d). */
export function gaussianSmooth1d(data: number[], sigma: number): number[] {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = gaussianKernel(sigma, radius);
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    let acc = 0;
    for (let k = 0; k < kernel.length; k++) {
      const idx = i + k - radius;
      const clamped = Math.max(0, Math.min(data.length - 1, idx));
      acc += data[clamped] * kernel[k];
    }
    out.push(acc);
  }
  return out;
}

/** Rescale distribution to match target mean/std (probability-integral morph). */
export function morphDistribution(
  data: number[],
  targetMean: number,
  targetStd: number,
): number[] {
  const n = data.length;
  if (n === 0) {
    return [];
  }
  let sum = 0;
  for (const v of data) {
    sum += v;
  }
  const mean = sum / n;
  let varSum = 0;
  for (const v of data) {
    varSum += (v - mean) ** 2;
  }
  const std = Math.sqrt(varSum / n) || 1;
  return data.map(v => ((v - mean) / std) * targetStd + targetMean);
}

/**
 * Build a curved path using Gaussian-smoothed random walk + distribution morph,
 * then map onto the segment from start to end with perpendicular deviation.
 */
export function generateHumanPathPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps: number,
): HumanMousePoint[] {
  const length = Math.max(steps, 10);
  const smoothX = gaussianSmooth1d(randomWalk(length, 10), 2);
  const smoothY = gaussianSmooth1d(randomWalk(length, 10), 2);
  const morphedX = morphDistribution(smoothX, HUMAN_DELTA_MEAN, HUMAN_DELTA_STD);
  const morphedY = morphDistribution(smoothY, HUMAN_DELTA_MEAN, HUMAN_DELTA_STD);

  const dx = endX - startX;
  const dy = endY - startY;
  const dist = Math.hypot(dx, dy) || 1;
  const perpX = -dy / dist;
  const perpY = dx / dist;
  const baseX = morphedX[0];
  const baseY = morphedY[0];

  const points: HumanMousePoint[] = [];
  for (let i = 0; i < length; i++) {
    const t = easeInOutCubic((i + 1) / length);
    const envelope = Math.sin(Math.PI * t);
    const offsetScale = envelope * Math.min(dist * 0.12, 48);
    const mx = morphedX[i] - baseX;
    const my = morphedY[i] - baseY;
    points.push({
      x: Math.round(startX + dx * t + perpX * mx * offsetScale),
      y: Math.round(startY + dy * t + perpY * my * offsetScale),
    });
  }
  return points;
}

function stepDelayMs(baseDelay: number, progress: number): number {
  let delay = baseDelay * (0.65 + Math.random() * 0.7);
  if (progress > 0.85) {
    delay *= 1.15 + Math.random() * 0.9;
  }
  if (Math.random() < 0.1) {
    delay += 25 + Math.random() * 90;
  }
  return delay;
}

/**
 * Move along a Gaussian-morphed curved path with variable timing, micro-pauses,
 * and precision jitter near the target. Used before clicks and drags to avoid
 * straight-line bot trajectories detected by DataDome/PerimeterX.
 */
export async function humanMouseMove(
  mouse: HumanMouse,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  durationMs: number,
): Promise<void> {
  const steps = Math.max(25, Math.round(durationMs / 14));
  const points = generateHumanPathPoints(startX, startY, endX, endY, steps);
  const baseDelay = durationMs / points.length;

  for (let i = 0; i < points.length; i++) {
    const progress = (i + 1) / points.length;
    let {x, y} = points[i];
    if (progress > 0.8) {
      x += Math.round((Math.random() - 0.5) * 4);
      y += Math.round((Math.random() - 0.5) * 4);
    }
    await mouse.move(x, y);
    await sleep(stepDelayMs(baseDelay, progress));
  }
}

/** Approach target from a random offset (simulates cursor already on page). */
export function randomApproachStart(
  targetX: number,
  targetY: number,
): HumanMousePoint {
  const angle = Math.random() * Math.PI * 2;
  const distance = 80 + Math.random() * 120;
  return {
    x: Math.round(targetX + Math.cos(angle) * distance),
    y: Math.round(targetY + Math.sin(angle) * distance),
  };
}
